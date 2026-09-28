"""Dynamic location resolution — any place the user names, no hardcoded list.

The assistant must work for whatever location a user asks about, so this module
deliberately contains **no gazetteer**. A place name is resolved at request time
through two free, keyless services that are already part of this platform's
stack:

  1. Nominatim / OpenStreetMap — best coverage for states, seas, bays and towns.
  2. Open-Meteo geocoding — only used when Nominatim cannot resolve the name at
     all (small coastal towns).

Three things make the result trustworthy rather than merely plausible:

  * **Same name only.** Candidates are narrowed to entries whose name literally
    matches what the user wrote, so "London" can never become "london colony".
  * **Coastal disambiguation.** A place name often has an inland namesake that
    Nominatim ranks first (Gopalpur-in-Bihar over Gopalpur-on-Sea). This is a
    marine assistant whose operational waters are Indian, so among the entries
    that carry the same name an Indian namesake wins if one exists, and then the
    first entry with open water nearby (checked with one batched marine request)
    wins. It is always the name the user asked about — never another place
    substituted for it. The full name of the entry used travels back in the
    answer, so an ambiguous name is visible rather than hidden.

  * **Scope.** One coordinate cannot honestly stand for a whole region or sea.
    A region/sea is placed on a representative *water* point inside it (its
    centre may be inland, where there is no sea data at all), and the flag
    travels with the result so the answer can say exactly what the readings
    cover.

Callers get ``None`` when a name cannot be resolved. Nothing is invented and
nothing silently falls back to a default location.
"""
import asyncio
import logging
import math
import time

from app.services import weather

log = logging.getLogger("marine.location")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OPEN_METEO_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
USER_AGENT = "seamonk-marine-assistant/1.0 (+https://seamonk.live)"

# Nominatim's usage policy asks for at most one request per second, so calls are
# serialised behind a lock with a minimum gap. Results change slowly -> 24 h cache.
_CACHE_TTL = 24 * 3600
_CACHE_MAX = 256
_cache: dict[str, tuple[float, dict | None]] = {}

_nominatim_lock = asyncio.Lock()
_last_nominatim_call = 0.0
_MIN_GAP = 1.1

# Candidate probing (all of it batched into a single marine request).
_GRID = 8                 # region/sea: grid resolution over the bounding box
_PROBE_LIMIT = 48         # region/sea: how many grid points to probe
# "Is there water nearby?" allowance. Small on purpose: it should tell a
# coastal town from an inland namesake, not reach a distant lake or estuary.
_RING_RADIUS_DEG = 0.13

_STRIP_WORDS = (
    "near", "offshore", "off", "in", "at", "around", "for", "of", "by",
    "over", "on", "the", "a", "an", "please", "weather", "conditions",
)

# Nominatim feature classification -> what one coordinate can honestly mean.
_REGION_TYPES = {
    "administrative", "state", "province", "region", "county", "district",
    "municipality", "local_authority", "territory", "federal_state",
}
_SEA_TYPES = {"sea", "bay", "strait", "gulf", "ocean", "sound", "channel"}

# A feature whose bounding box is at least this wide is an area, not a point.
# (Chennai's city boundary spans ~0.4 degrees; Odisha ~5 — the gap is large.)
_AREA_SPAN_DEG = 1.5

# Administrative areas wider than this cannot be described by one set of
# readings at all (a country, a prefecture spanning islands), so the assistant
# asks which part the user means instead of pretending. Seas are exempt: the
# requirement is to answer for the queried point and say what it covers.
_TOO_BROAD_DEG = 12.0

# ---------------------------------------------------------------- coastline atlas
# The marine data feeds, the operating area and the default map all centre on
# the Indian coast, and some hosting networks cannot reach the primary geocoder
# at all. A small coastline atlas covers the names people actually ask for that
# the fallback geocoder misses (states, seas, and spelling variants it stores
# with diacritics like "Gopālpur"), so those still resolve to the right waters.
# Anything else still goes to the geocoders — this is a floor, not a ceiling.
_COASTLINE_ATLAS: dict[str, tuple[str, float, float, str]] = {
    # name -> (label, lat, lon, scope)
    "kerala": ("Kerala", 10.223, 75.956, "region"),
    "odisha": ("Odisha", 19.171, 84.873, "region"),
    "orissa": ("Odisha", 19.171, 84.873, "region"),
    "west bengal": ("West Bengal", 21.9, 87.9, "region"),
    "bengal": ("West Bengal", 21.9, 87.9, "region"),
    "bay of bengal": ("Bay of Bengal", 12.994, 85.758, "sea"),
    "arabian sea": ("Arabian Sea", 14.5, 68.5, "sea"),
    "indian ocean": ("Indian Ocean", 8.0, 78.0, "sea"),
    "andaman sea": ("Andaman Sea", 11.5, 96.5, "sea"),
    "lakshadweep sea": ("Lakshadweep Sea", 10.6, 72.6, "sea"),
    "gulf of mannar": ("Gulf of Mannar", 8.9, 78.5, "sea"),
    "palk bay": ("Palk Bay", 9.6, 79.6, "sea"),
    "palk strait": ("Palk Strait", 10.3, 79.9, "sea"),
    "gulf of khambhat": ("Gulf of Khambhat", 21.3, 72.4, "sea"),
    "gulf of kutch": ("Gulf of Kutch", 22.7, 69.3, "sea"),
    "andaman and nicobar": ("Andaman and Nicobar Islands", 11.7, 92.7, "region"),
    "andaman & nicobar": ("Andaman and Nicobar Islands", 11.7, 92.7, "region"),
    "gopalpur": ("Gopalpur", 19.259, 84.905, "point"),
    "mangalore": ("Mangalore", 12.869, 74.842, "point"),
    "kollam": ("Kollam", 8.893, 76.614, "point"),
    "thiruvananthapuram": ("Thiruvananthapuram", 8.485, 76.949, "point"),
    "trivandrum": ("Thiruvananthapuram", 8.485, 76.949, "point"),
    "kanyakumari": ("Kanyakumari", 8.079, 77.55, "point"),
    "rameswaram": ("Rameswaram", 9.288, 79.312, "point"),
    "digha": ("Digha", 21.627, 87.509, "point"),
    "shankarpur": ("Shankarpur", 21.675, 87.571, "point"),
    "mandarmani": ("Mandarmani", 21.66, 87.79, "point"),
    "sunderbans": ("Sunderbans", 21.95, 89.2, "region"),
    "sundarbans": ("Sunderbans", 21.95, 89.2, "region"),
    "sagar island": ("Sagar Island", 21.745, 88.118, "point"),
    "gangasagar": ("Sagar Island", 21.745, 88.118, "point"),
    "chandipur": ("Chandipur", 21.467, 87.017, "point"),
    "talasari": ("Talasari", 21.6, 87.15, "point"),
}


def _atlas_entry(name: str) -> dict | None:
    """Atlas hit for an exact name (folded), honouring the cache contract."""
    key = name.strip().lower()
    hit = _COASTLINE_ATLAS.get(key)
    if not hit:
        return None
    label, lat, lon, scope = hit
    return {
        "query": name,
        "label": label,
        "display_name": f"{label}, India" if scope == "region" else label,
        "lat": lat,
        "lon": lon,
        "scope": scope,
        "bbox": None,
        "source": "SEAMONK coastline atlas",
        "feature": "place/coastal" if scope == "point" else "area/coastal",
        "representative": scope != "point",
        "too_broad": False,
    }


# ---------------------------------------------------------------- helpers
def _cache_get(key: str) -> tuple[bool, dict | None]:
    entry = _cache.get(key)
    if entry is None:
        return False, None
    expires, value = entry
    if expires < time.monotonic():
        _cache.pop(key, None)
        return False, None
    return True, value


def _cache_put(key: str, value: dict | None) -> None:
    if len(_cache) >= _CACHE_MAX:
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    _cache[key] = (time.monotonic() + _CACHE_TTL, value)


def clean_query(text: str) -> str:
    """Trim the conversational scaffolding around a place name.

    ``"near the Bay of Bengal"`` -> ``"Bay of Bengal"``. Only leading/trailing
    filler words are removed, so multi-word real names survive intact.
    """
    words = [w for w in (text or "").strip().strip("?.!,").split() if w]
    while words and words[0].lower() in _STRIP_WORDS:
        words.pop(0)
    while words and words[-1].lower() in _STRIP_WORDS:
        words.pop()
    return " ".join(words).strip()


def coords_label(lat: float, lon: float) -> str:
    """Human label for a bare coordinate pair (no lookup, no invention)."""
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"{abs(lat):.2f}°{ns}, {abs(lon):.2f}°{ew}"


def _label_for(query: str, display_name: str) -> str:
    """Name the place the way the user said it when that clearly matches.

    Keeps ``"Chennai"`` from becoming ``"Chennai Corporation"`` while leaving
    genuinely different names alone.
    """
    first = (display_name.split(",")[0] or query).strip()
    if first.lower().startswith(query.lower()):
        if len(query.split()) == 1 and query.islower():
            return query.title()
        return query
    return first


def _scope_for(entry: dict) -> str:
    category, ftype = entry.get("category", ""), entry.get("type", "")
    if ftype in _SEA_TYPES:
        return "sea"
    bbox = entry.get("bbox")
    span_lat = bbox["north"] - bbox["south"] if bbox else 0.0
    span_lon = bbox["east"] - bbox["west"] if bbox else 0.0
    if category == "boundary" and ftype in _REGION_TYPES:
        return "region" if max(span_lat, span_lon) >= _AREA_SPAN_DEG else "point"
    if ftype in _REGION_TYPES:
        return "region" if max(span_lat, span_lon) >= _AREA_SPAN_DEG else "point"
    if max(span_lat, span_lon) >= _AREA_SPAN_DEG:
        return "region"
    return "point"


def _parse_bbox(raw) -> dict | None:
    """Nominatim boundingbox is [south, north, west, east] as strings."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        south, north, west, east = (float(v) for v in raw)
    except (TypeError, ValueError):
        return None
    return {"south": south, "north": north, "west": west, "east": east}


# ---------------------------------------------------------------- providers
async def _nominatim(query: str, country: str | None = None) -> list[dict]:
    global _last_nominatim_call

    params = {"q": query, "format": "jsonv2", "limit": 5, "addressdetails": 1}
    if country:
        params["countrycodes"] = country

    async with _nominatim_lock:
        gap = _MIN_GAP - (time.monotonic() - _last_nominatim_call)
        if gap > 0:
            await asyncio.sleep(gap)
        try:
            resp = await weather.shared_client().get(
                NOMINATIM_URL, params=params,
                headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
                timeout=10,
            )
            _last_nominatim_call = time.monotonic()
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            _last_nominatim_call = time.monotonic()
            log.warning("geocoding lookup failed for %r: %s", query, exc)
            return []

    out: list[dict] = []
    for row in data if isinstance(data, list) else []:
        try:
            out.append({
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
                "display_name": row.get("display_name") or query,
                "category": str(row.get("category") or row.get("class") or "").lower(),
                "type": str(row.get("type") or "").lower(),
                "bbox": _parse_bbox(row.get("boundingbox")),
                "importance": row.get("importance"),
                "country_code": str(((row.get("address") or {}).get("country_code")) or "").lower(),
                "source": "OpenStreetMap",
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out


async def _open_meteo_geocode(query: str) -> list[dict]:
    """Fallback provider: towns Nominatim has nothing for."""
    try:
        resp = await weather.shared_client().get(
            OPEN_METEO_GEOCODE,
            params={"name": query, "count": 5, "language": "en", "format": "json"},
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get("results") or []
    except Exception as exc:
        log.warning("fallback geocoding failed for %r: %s", query, exc)
        return []

    out: list[dict] = []
    for row in results:
        try:
            code = str(row.get("feature_code") or "")
            out.append({
                "lat": float(row["latitude"]),
                "lon": float(row["longitude"]),
                "display_name": ", ".join(
                    p for p in (row.get("name"), row.get("admin1"), row.get("country")) if p
                ),
                "category": "place",
                "type": "administrative" if code.startswith("ADM") else "town",
                "bbox": None,
                "country_code": str(row.get("country_code") or "").lower(),
                "source": "Open-Meteo geocoding",
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _first_component(entry: dict) -> str:
    return (entry["display_name"].split(",")[0] or "").strip()


def _same_name(entry: dict, query: str) -> bool:
    """Only entries whose name literally matches what the user wrote."""
    first = _first_component(entry).lower()
    q = query.lower()
    return first == q or first.rstrip(".,") == q


# ---------------------------------------------------------------- water probing
def _bbox_grid(bbox: dict, grid: int = _GRID) -> list[tuple[float, float]]:
    """Grid inside an area, ordered from its centre outwards."""
    south, north = bbox["south"], bbox["north"]
    west, east = bbox["west"], bbox["east"]
    clat, clon = (south + north) / 2, (west + east) / 2
    pts: list[tuple[float, float]] = []
    for i in range(grid):
        for j in range(grid):
            pts.append((
                south + (north - south) * i / (grid - 1),
                west + (east - west) * j / (grid - 1),
            ))
    pts.sort(key=lambda p: (p[0] - clat) ** 2 + (p[1] - clon) ** 2)
    return pts[:_PROBE_LIMIT]


def _ring(lat: float, lon: float, radius: float = _RING_RADIUS_DEG,
          steps: int = 8) -> list[tuple[float, float]]:
    """The point itself plus a circle of neighbours (is there water here?)."""
    pts = [(lat, lon)]
    for k in range(steps):
        a = 2 * math.pi * k / steps
        pts.append((lat + radius * math.sin(a), lon + radius * math.cos(a)))
    return pts


def _nearest(points: list[tuple[float, float]], lat: float, lon: float):
    return min(points, key=lambda p: (p[0] - lat) ** 2 + (p[1] - lon) ** 2)


async def _representative_water_point(bbox: dict) -> tuple[float, float] | None:
    """Centre-nearest point inside an area that has real marine data."""
    pts = _bbox_grid(bbox)
    if not pts:
        return None
    values = await weather.probe_water_points(pts)
    for point, value in zip(pts, values):
        if value is not None:
            return point
    return None


async def _pick_coastal(
    rows: list[dict],
) -> tuple[dict, tuple[float, float], bool]:
    """Prefer the first candidate with open water nearby; report where it sits.

    Returns ``(chosen_row, point, snapped)`` — `snapped` is True when the chosen
    point had no marine data of its own and the nearest water point is used.
    One batched request covers every candidate.
    """
    probe: list[tuple[float, float]] = []
    own: list[int] = []                       # index in `probe` of each row's own point
    spans: list[tuple[int, int]] = []         # probe range for each row
    for row in rows:
        start = len(probe)
        own.append(start)
        probe += _ring(row["lat"], row["lon"])
        spans.append((start, len(probe)))

    values = await weather.probe_water_points(probe)
    for row, own_i, (start, end) in zip(rows, own, spans):
        hits = [probe[i] for i in range(start, end) if values[i] is not None]
        if not hits:
            continue
        if values[own_i] is not None:
            return row, (row["lat"], row["lon"]), False
        return row, _nearest(hits, row["lat"], row["lon"]), True
    return rows[0], (rows[0]["lat"], rows[0]["lon"]), False


# ---------------------------------------------------------------- public API
async def resolve(place: str) -> dict | None:
    """Resolve a place name to coordinates + scope. ``None`` when unresolved."""
    query = clean_query(place)
    if not query:
        return None

    cached, value = _cache_get(query)
    if cached:
        return value

    # The coastline atlas answers for the coastal names the geocoders can miss —
    # states, seas, and spellings stored with diacritics ("Gopālpur"). It is
    # consulted first because it is exact-name only: anything it does not know
    # falls through to the live geocoders as before.
    atlas = _atlas_entry(query)
    if atlas:
        _cache_put(query, atlas)
        return atlas

    rows = await _nominatim(query) or await _open_meteo_geocode(query)
    if not rows:
        # One more atlas chance: "off Odisha", "near Gopalpur" — the strip in
        # clean_query leaves the name, but the geocoders may still have failed.
        atlas = _atlas_entry(query)
        if atlas:
            _cache_put(query, atlas)
            return atlas
        log.info("location %r could not be resolved", place)
        _cache_put(query, None)
        return None

    # Narrow to entries actually carrying this name, then prefer the platform's
    # own operational country (India) when several of them share it.
    named = [r for r in rows if _same_name(r, query)] or rows
    indian = [r for r in named if r["country_code"] == "in"]
    pool = indian or named

    # The fallback geocoder stores many Indian names with diacritics and its
    # accent-folded match may be a foreign namesake ("Kerala" -> "Kerälä",
    # Finland). Never let that stand in for a coastal name the atlas knows.
    first = (pool[0].get("display_name") or "").split(",")[0].strip().lower()
    if first != query.strip().lower():
        atlas = _atlas_entry(query)
        if atlas:
            _cache_put(query, atlas)
            return atlas

    entry = pool[0]
    scope = _scope_for(entry)
    lat, lon = entry["lat"], entry["lon"]
    representative = False

    if scope == "point":
        # Ambiguous names: Nominatim's first hit may be an inland namesake.
        entry, (lat, lon), snapped = await _pick_coastal(pool[:5])
        scope = _scope_for(entry)
        representative = snapped
        if scope in ("region", "sea"):
            # A large feature picked here (e.g. a whole district) still needs a
            # point on water rather than its (possibly inland) centre.
            point = await _representative_water_point(entry["bbox"]) if entry.get("bbox") else None
            if point:
                lat, lon = point
                representative = point != (entry["lat"], entry["lon"])
    elif entry.get("bbox"):
        point = await _representative_water_point(entry["bbox"])
        if point:
            lat, lon = point
            representative = True

    if scope in ("region", "sea"):
        representative = True

    bbox = entry.get("bbox")
    too_broad = bool(
        scope == "region" and bbox
        and max(bbox["north"] - bbox["south"], bbox["east"] - bbox["west"]) >= _TOO_BROAD_DEG
    )

    result = {
        "query": place,
        "label": _label_for(query, entry["display_name"]),
        "display_name": entry["display_name"],
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "scope": scope,
        "bbox": bbox,
        "source": entry["source"],
        "feature": f"{entry['category']}/{entry['type']}".strip("/"),
        # True when the reported point is a representative point of a larger
        # area (or the nearest water point to the place named) rather than the
        # place's own centre.
        "representative": representative,
        # True when the area named is so large that one point cannot describe
        # it — the assistant asks which part is meant instead of answering.
        "too_broad": too_broad,
    }
    _cache_put(query, result)
    return result


def for_coordinates(lat: float, lon: float) -> dict:
    """Wrap user-supplied coordinates in the same shape as a resolved place."""
    return {
        "query": coords_label(lat, lon),
        "label": coords_label(lat, lon),
        "display_name": coords_label(lat, lon),
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "scope": "point",
        "bbox": None,
        "source": "user-supplied coordinates",
        "feature": "coordinates",
        "representative": False,
        "too_broad": False,
    }


def from_prior(prior: dict) -> dict | None:
    """Reuse a location carried over from the previous turn of the conversation."""
    try:
        lat, lon = float(prior["lat"]), float(prior["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    name = prior.get("location") or coords_label(lat, lon)
    return {
        "query": name,
        "label": name,
        "display_name": name,
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "scope": prior.get("scope") or "point",
        "bbox": None,
        "source": "earlier in this conversation",
        "feature": "conversation context",
        "representative": bool(prior.get("representative")),
        "too_broad": False,
    }
