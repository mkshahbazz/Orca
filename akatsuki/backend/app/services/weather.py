"""Open-Meteo marine + forecast wrappers (async, httpx).

Performance notes:
- one shared AsyncClient (connection pooling, keep-alive) instead of a
  new client + TLS handshake per request
- the two Open-Meteo endpoints are fetched *concurrently* (asyncio.gather)
- a small in-memory TTL cache absorbs repetitive queries for the same
  location (marine data moves slowly; 10 min is safely fresh)

Failure policy: there is NO fabricated fallback payload. If the live feeds
cannot be reached the call raises :class:`WeatherUnavailable` so the chat
surface can tell the user the truth instead of printing invented numbers.
"""

import asyncio
import time

import httpx

MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

MARINE_CURRENT = (
    "wave_height,wave_direction,wave_period,wind_wave_height,"
    "swell_wave_height,sea_surface_temperature"
)
FORECAST_CURRENT = "temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m"

# Day-by-day outlook so follow-up questions ("what about tomorrow?") can be
# answered for the same location instead of only the current hour.
MARINE_DAILY = "wave_height_max,wave_direction_dominant,wave_period_max"
FORECAST_DAILY = (
    "temperature_2m_max,temperature_2m_min,wind_speed_10m_max,"
    "wind_gusts_10m_max,weather_code,precipitation_probability_max"
)

WEATHER_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Rain", 65: "Heavy rain",
    80: "Rain showers", 95: "Thunderstorm", 96: "Thunderstorm w/ hail",
    99: "Severe thunderstorm w/ hail",
}

class WeatherUnavailable(RuntimeError):
    """Raised when live marine/weather data cannot be retrieved."""

# ---------------------------------------------------------------- caching
_CACHE_TTL = 600          # seconds
_CACHE_MAX = 512          # simple size cap
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = asyncio.Lock()


def _cache_get(key: str) -> dict | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    expires, value = entry
    if expires < time.monotonic():
        _cache.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: dict) -> None:
    if len(_cache) >= _CACHE_MAX:
        # drop the oldest entry (monotonic expiry) — good enough for this size
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    _cache[key] = (time.monotonic() + _CACHE_TTL, value)


# ---------------------------------------------------------------- client
_client: httpx.AsyncClient | None = None


def _ensure_client() -> httpx.AsyncClient:
    """Lazily create the shared client (also called from startup())."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=4.0),
            limits=httpx.Limits(
                max_connections=40, max_keepalive_connections=20
            ),
            headers={"User-Agent": "orca-marine-assistant/1.0"},
        )
    return _client


async def startup() -> None:
    """Create the shared client (call once from app lifespan)."""
    _ensure_client()


def shared_client() -> httpx.AsyncClient:
    """The process-wide pooled client — reused by the location resolver so the
    platform keeps a single connection pool instead of one per module."""
    return _ensure_client()


async def shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _round(v: float | None, nd: int = 1) -> float | None:
    return round(v, nd) if isinstance(v, (int, float)) else None


def _daily(mj: dict, fj: dict) -> list[dict]:
    """Join the marine + weather daily series into one day-by-day outlook."""
    def index(d: dict) -> dict[str, int]:
        return {day: i for i, day in enumerate(d.get("time") or [])}

    def pick(d: dict, key: str, i: int, nd: int = 1):
        col = d.get(key)
        return _round(col[i], nd) if isinstance(col, list) and i < len(col) else None

    mi, fi = index(mj), index(fj)
    out: list[dict] = []
    for day in sorted(set(mi) | set(fi)):
        row: dict = {"date": day}
        if day in mi:
            i = mi[day]
            row["wave_max_m"] = pick(mj, "wave_height_max", i)
            row["wave_period_max_s"] = pick(mj, "wave_period_max", i)
            row["wave_dir_deg"] = pick(mj, "wave_direction_dominant", i, 0)
        if day in fi:
            i = fi[day]
            row["air_max_c"] = pick(fj, "temperature_2m_max", i)
            row["air_min_c"] = pick(fj, "temperature_2m_min", i)
            row["wind_max_kmh"] = pick(fj, "wind_speed_10m_max", i, 0)
            row["gust_max_kmh"] = pick(fj, "wind_gusts_10m_max", i, 0)
            row["rain_chance_pct"] = pick(fj, "precipitation_probability_max", i, 0)
            code = pick(fj, "weather_code", i, 0)
            row["weather"] = WEATHER_CODES.get(code, f"Code {code}") if code is not None else None
        out.append(row)
    return out


async def get_marine_conditions(lat: float | None = None, lon: float | None = None) -> dict:
    """Live waves + SST (marine API) and wind/weather (forecast API).

    Coordinates are REQUIRED. There is deliberately no default location: the
    assistant must never answer for a place the user did not ask about, so a
    missing location surfaces as :class:`WeatherUnavailable` and the caller
    asks the user where they mean.

    Returns a trimmed payload (rounded floats, short keys) to cut JSON
    transit size between agent -> backend -> frontend.
    """
    if lat is None or lon is None:
        raise WeatherUnavailable(
            "No location was resolved for this question, so live conditions "
            "cannot be fetched for it."
        )

    key = f"{round(float(lat), 2):.2f},{round(float(lon), 2):.2f}"
    hit = _cache_get(key)
    if hit is not None:
        return dict(hit, cached=True)

    params = {
        "marine": {"latitude": lat, "longitude": lon,
                   "current": MARINE_CURRENT, "daily": MARINE_DAILY,
                   "forecast_days": 3, "timezone": "auto"},
        "forecast": {"latitude": lat, "longitude": lon,
                     "current": FORECAST_CURRENT, "daily": FORECAST_DAILY,
                     "forecast_days": 3, "timezone": "auto"},
    }

    client = _ensure_client()
    try:
        async with asyncio.timeout(8):
            m_resp, f_resp = await asyncio.gather(
                client.get(MARINE_URL, params=params["marine"]),
                client.get(FORECAST_URL, params=params["forecast"]),
            )
            m_resp.raise_for_status()
            f_resp.raise_for_status()
            m_body = m_resp.json()
            f_body = f_resp.json()
            mj = m_body["current"]
            fj = f_body["current"]
    except Exception as exc:  # offline / rate-limited / timeout -> tell the truth
        raise WeatherUnavailable(
            f"Live weather/sea-state feeds could not be reached for "
            f"{lat:.3f}, {lon:.3f} ({type(exc).__name__}: {exc})"
        ) from exc

    data = {
        "lat": lat, "lon": lon, "source": "Open-Meteo (live)",
        "wave_height_m": _round(mj.get("wave_height")),
        "wave_direction_deg": _round(mj.get("wave_direction"), 0),
        "wave_period_s": _round(mj.get("wave_period")),
        "wind_wave_height_m": _round(mj.get("wind_wave_height")),
        "swell_wave_height_m": _round(mj.get("swell_wave_height")),
        "sea_surface_temperature_c": _round(mj.get("sea_surface_temperature")),
        "wind_speed_kmh": _round(fj.get("wind_speed_10m"), 0),
        "wind_gusts_kmh": _round(fj.get("wind_gusts_10m"), 0),
        "air_temperature_c": _round(fj.get("temperature_2m")),
        "weather": WEATHER_CODES.get(fj.get("weather_code"), f"Code {fj.get('weather_code')}"),
        # raw WMO code kept so downstream verification (community reports)
        # can reason about storms without parsing the human label
        "weather_code": fj.get("weather_code"),
        # today + the two following days, so "what about tomorrow?" can be
        # answered for the requested location from the same fetched payload
        "forecast_days": _daily(m_body.get("daily") or {}, f_body.get("daily") or {}),
    }
    _cache_put(key, data)
    return dict(data, cached=False)


async def probe_water_points(points: list[tuple[float, float]]) -> list[float | None]:
    """Wave height at each candidate point, in ONE batched marine request.

    Points over land come back as null. The location resolver uses this to put
    a large-area question (a state, a bay) on real water instead of an inland
    centre point. Never raises: an unreachable feed returns all-null and the
    caller falls back to the feature centre.
    """
    if not points:
        return []
    params = {
        "latitude": ",".join(f"{p[0]:.3f}" for p in points),
        "longitude": ",".join(f"{p[1]:.3f}" for p in points),
        "current": "wave_height",
        "timezone": "auto",
    }
    try:
        async with asyncio.timeout(10):
            resp = await _ensure_client().get(MARINE_URL, params=params)
            resp.raise_for_status()
            payload = resp.json()
    except Exception:
        return [None] * len(points)

    rows = payload if isinstance(payload, list) else [payload]
    out: list[float | None] = []
    for i in range(len(points)):
        row = rows[i] if i < len(rows) and isinstance(rows[i], dict) else {}
        value = (row.get("current") or {}).get("wave_height")
        out.append(float(value) if isinstance(value, (int, float)) else None)
    return out
