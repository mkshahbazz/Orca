"""Crowdsourced marine intelligence: submission, proximity search, verification.

Community reports (fishermen, coastal workers, harbour staff) live in the
`community_reports` table — a PostGIS point plus category, description, media
and the time it happened. This module owns all three halves the product needs:

1. :func:`insert_report` / :func:`list_reports` — the Contribute page's writes
   and reads, on the *existing* table (no parallel store).
2. :func:`find_nearby_reports` — spatial search around a queried location.
3. :func:`verify_reports` — the verification matrix. A human tip is NEVER
   trusted blindly: each claim is cross-referenced against the physical
   satellite/weather/PFZ readings for the same point and time window. Only
   claims the sensors can corroborate are promoted to `verified`, and only
   verified reports are allowed to influence the answer's confidence score.

Category vocabulary — the Contribute page folds a fisher's intent into one of
six choices, which map onto the physical evidence that can confirm each claim:

    catch                -> inside an active INCOIS PFZ zone (PostGIS)
    fishing_zone         -> inside an active INCOIS PFZ zone (PostGIS)
    sea_condition        -> live wave / swell height or swell period
    weather_observation  -> live wind gusts or an active storm cell
    hazard               -> any live wave / wind / storm signal
    other                -> nothing can confirm it; kept, always unverified

Legacy categories written by earlier versions (`heavy_swell`, `rough_seas`,
`high_wind`, `squall`, `thunderstorm`, `storm`, `strong_current`, `debris`,
`oil_spill`, `shoal`, `fish_sighting`) keep their original rules so existing
rows verify exactly as before.
"""
import json
import logging
from datetime import datetime, timezone

from shapely.geometry import Point, shape

from app.services import geospatial

log = logging.getLogger("marine.community")

# Search neighbourhood + freshness window for relevancy.
DEFAULT_RADIUS_KM = 75.0
DEFAULT_MAX_AGE_HOURS = 72

# The six choices a contributor picks from on the Contribute page.
CONTRIBUTION_CATEGORIES = {
    "catch": "Catch",
    "hazard": "Hazard",
    "sea_condition": "Sea / ocean condition",
    "fishing_zone": "Fishing zone condition",
    "weather_observation": "Weather observation",
    "other": "Other",
}

# Every value the table's CHECK constraint accepts (see the migration).
ALL_CATEGORIES = tuple(CONTRIBUTION_CATEGORIES) + (
    "heavy_swell", "high_wave", "rough_seas", "high_wind", "squall",
    "thunderstorm", "storm", "strong_current", "debris", "oil_spill",
    "shoal", "fish_sighting",
)

# Human-observable claims the physical feeds can corroborate.
WAVE_CATEGORIES = {"heavy_swell", "high_wave", "rough_seas", "sea_condition"}
WIND_CATEGORIES = {"high_wind", "squall", "weather_observation"}
STORM_CATEGORIES = {"thunderstorm", "storm"}
PFZ_CATEGORIES = {"catch", "fishing_zone"}
# A hazard report is a claim that *something* out there is dangerous, so any of
# the three physical signals may confirm it.
HAZARD_CATEGORIES = {"hazard"}

# Claims no surface sensor feed can independently confirm today. They are kept
# and shown, but always marked unverified.
UNVERIFIABLE_HINT = (
    "No independent sensor feed can confirm this claim; kept as a human observation."
)

SWELL_WAVE_M = 2.0
SWELL_PERIOD_S = 8.0
WIND_KMH = 30.0
GUST_KMH = 45.0
STORM_WIND_KMH = 40.0

# Columns the API returns — kept in one place so the submit/list/search paths
# can never drift apart and hand the UI a half-populated report.
_REPORT_COLUMNS = """
    id, created_at, observed_at, category, description, reporter_role,
    reporter_name, lat, lon, verified, verification_note, verification_source,
    media_url, media_type, ST_AsGeoJSON(location)::text AS geojson
"""


def _row_to_report(row) -> dict:
    report = dict(row)
    geom = report.pop("geojson", None)
    if geom:
        report["geojson"] = json.loads(geom)
    for key in ("observed_at", "created_at"):
        value = report.get(key)
        if isinstance(value, datetime):
            report[key] = value.astimezone(timezone.utc).isoformat()
    report["id"] = str(report.get("id"))
    # The database flag is a record of the last verification run; it is always
    # re-derived by `verify_reports` before anything downstream trusts it.
    report["verified"] = bool(report.get("verified"))
    return report


def _pool():
    pool = geospatial._pool
    if pool is None:
        log.warning("community query skipped: DB pool not initialised")
    return pool


MIGRATION_HINT = (
    "The community_reports table is missing the contribution columns. Run "
    "supabase/migrations/001_community_contribution.sql in the Supabase SQL editor to enable "
    "community contributions."
)


def _schema_error(exc: Exception) -> Exception:
    """Turn 'column does not exist' into an instruction instead of a mystery."""
    text = str(exc)
    if "does not exist" in text and ("column" in text or "relation" in text):
        log.error("community schema incomplete: %s", text)
        return RuntimeError(f"{MIGRATION_HINT} Postgres said: {text}")
    return exc


# --------------------------------------------------------------- reads
async def find_nearby_reports(
    lat: float,
    lon: float,
    radius_km: float = DEFAULT_RADIUS_KM,
    max_age_hours: int = DEFAULT_MAX_AGE_HOURS,
    limit: int = 25,
) -> list[dict]:
    """Community reports within `radius_km` of a point, newest first.

    Returns an empty list (not an error) when the spatial database is
    unreachable — crowdsourced data is additive, and its absence must never
    break the safety report itself.
    """
    pool = _pool()
    if pool is None:
        return []

    sql = f"""
        SELECT {_REPORT_COLUMNS}
        FROM community_reports
        WHERE observed_at > now() - make_interval(hours => $3)
          AND ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                $4
              )
        ORDER BY observed_at DESC
        LIMIT $5
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, lon, lat, max_age_hours, radius_km * 1000.0, limit)
    except Exception as exc:  # table missing / DB hiccup -> degrade, don't fail
        if "does not exist" in str(exc):
            # A missing column means the migration has not run — that is an
            # operator error, not an absence of reports, so it is shouted about.
            log.error("community search failed (schema incomplete): %s", exc)
        else:
            log.warning("community search failed: %s", exc)
        return []
    return [_row_to_report(r) for r in rows]


async def list_reports(
    limit: int = 50,
    verified_only: bool = False,
    max_age_hours: int = 24 * 30,
) -> list[dict]:
    """Newest community reports, optionally only sensor-verified ones.

    Raises on a broken database: unlike the *additive* proximity search, this
    backs a page whose entire purpose is showing real contributions, so an
    outage must be visible instead of rendering as "no reports exist".
    """
    pool = _pool()
    if pool is None:
        raise RuntimeError("The spatial database is unavailable, so community reports cannot be listed.")
    sql = f"""
        SELECT {_REPORT_COLUMNS}
        FROM community_reports
        WHERE observed_at > now() - make_interval(hours => $3)
          AND ($2::boolean IS NOT TRUE OR verified)
        ORDER BY observed_at DESC
        LIMIT $1
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, max(1, min(limit, 200)), verified_only, max_age_hours)
    except Exception as exc:
        raise _schema_error(exc) from exc
    return [_row_to_report(r) for r in rows]


async def report_stats(max_age_hours: int = 24 * 30) -> dict:
    """Headline counts for the Contribute page (one pass over the table)."""
    pool = _pool()
    if pool is None:
        raise RuntimeError("The spatial database is unavailable, so community stats cannot be read.")
    sql = """
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE verified)::int AS verified,
               COUNT(DISTINCT COALESCE(NULLIF(BTRIM(reporter_name), ''), 'Anonymous'))::int
                   AS contributors,
               COUNT(*) FILTER (WHERE media_url IS NOT NULL)::int AS with_media
        FROM community_reports
        WHERE observed_at > now() - make_interval(hours => $1)
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, max_age_hours)
    total = int(row["total"] or 0)
    verified = int(row["verified"] or 0)
    return {
        "total": total,
        "verified": verified,
        "unverified": total - verified,
        "contributors": int(row["contributors"] or 0),
        "with_media": int(row["with_media"] or 0),
        "verified_share": round(100 * verified / total) if total else 0,
        "window_hours": max_age_hours,
    }


async def insert_report(
    *,
    category: str,
    description: str,
    lat: float,
    lon: float,
    reporter_name: str | None = None,
    reporter_role: str | None = None,
    media_url: str | None = None,
    media_type: str | None = None,
    observed_at: datetime | None = None,
) -> dict:
    """Store one contribution on the existing table and return the stored row."""
    pool = _pool()
    if pool is None:
        raise RuntimeError("The spatial database is unavailable, so the report could not be saved.")
    sql = f"""
        INSERT INTO community_reports (
            observed_at, category, description, reporter_role, reporter_name,
            media_url, media_type, lat, lon
        )
        VALUES (COALESCE($1, now()), $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING {_REPORT_COLUMNS}
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                sql, observed_at, category, description, reporter_role,
                reporter_name, media_url, media_type, lat, lon,
            )
    except Exception as exc:
        raise _schema_error(exc) from exc
    return _row_to_report(row)


async def save_verification(report_id: str, verified: bool, note: str, source: str | None) -> None:
    """Persist the verdict of the verification matrix next to the report."""
    pool = _pool()
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE community_reports
                      SET verified = $2, verification_note = $3, verification_source = $4
                    WHERE id = $1""",
                int(report_id), verified, note, source,
            )
    except Exception as exc:  # a failed bookkeeping write never fails the request
        log.warning("could not persist verification for report %s: %s", report_id, exc)


# --------------------------------------------------------- verification
def _pfz_corroboration(lat: float, lon: float, zones: list[dict] | None) -> tuple[bool, str]:
    """Is this fishing claim inside the live PFZ bulletin?"""
    if not zones:
        return False, (
            "No active PFZ bulletin was available, so this fishing report could not be "
            "corroborated against satellite-derived zones."
        )
    point = Point(lon, lat)
    for zone in zones:
        geom = zone.get("geojson") or zone.get("geometry")
        if not geom:
            continue
        try:
            polygon = shape(geom)
        except Exception:  # malformed geometry in the store
            continue
        if polygon.contains(point):
            name = zone.get("location_name") or "an active zone"
            chl = zone.get("chlorophyll")
            detail = f" (chlorophyll {chl} mg/m³)" if chl is not None else ""
            return True, (
                f"Confirmed: the reported position lies inside the active PFZ zone "
                f"“{name}”{detail} in the current INCOIS bulletin."
            )
    return False, (
        "Not corroborated: the reported position lies outside every active PFZ zone in "
        "the current INCOIS bulletin."
    )


def _corroboration(
    report: dict, weather: dict, pfz_zones: list[dict] | None
) -> tuple[bool, str]:
    """Apply the verification matrix to a single report. -> (verified, note)"""
    category = str(report.get("category") or "").lower()
    lat, lon = report.get("lat"), report.get("lon")

    if category in PFZ_CATEGORIES:
        if lat is None or lon is None:
            return False, "The report carries no position, so it cannot be cross-checked."
        return _pfz_corroboration(float(lat), float(lon), pfz_zones)

    if not weather:
        return False, "No live sensor reading was available to cross-check this report."

    wave = weather.get("wave_height_m")
    swell = weather.get("swell_wave_height_m")
    period = weather.get("wave_period_s")
    wind = weather.get("wind_speed_kmh")
    gust = weather.get("wind_gusts_kmh")
    code = weather.get("weather_code")

    def strongest(*values) -> float:
        return max([v for v in values if isinstance(v, (int, float))] or [0])

    if category in WAVE_CATEGORIES or category in HAZARD_CATEGORIES:
        best = strongest(wave, swell)
        if best >= SWELL_WAVE_M:
            note = f"Confirmed: live wave/swell height {best} m near the reported position."
            return True, note
        if isinstance(period, (int, float)) and period >= SWELL_PERIOD_S:
            note = f"Confirmed: long swell period of {period} s at the reported position."
            return True, note
        if category in HAZARD_CATEGORIES:
            # A hazard claim can also be carried by wind or an active storm cell.
            wind_best = strongest(wind, gust)
            if code in (95, 96, 99) or wind_best >= STORM_WIND_KMH:
                return True, (
                    "Confirmed: the live weather feed reports storm-force conditions "
                    f"({wind_best} km/h) in the reported area."
                )
            return False, (
                f"Not corroborated: the live feed shows calm conditions ({wind_best} km/h "
                f"wind, {best} m wave) at the reported position."
            )
        return False, (
            f"Contradicted by sensors: live wave/swell height is only {best} m "
            f"(threshold {SWELL_WAVE_M} m)."
        )

    if category in WIND_CATEGORIES:
        best = strongest(wind, gust)
        if best >= WIND_KMH:
            return True, f"Confirmed: live wind/gust speed {best} km/h in the reported area."
        if code in (95, 96, 99):
            return True, "Confirmed: the live weather feed reports an active thunderstorm cell."
        return False, (
            f"Contradicted by sensors: live wind/gust speed is only {best} km/h "
            f"(threshold {WIND_KMH} km/h)."
        )

    if category in STORM_CATEGORIES:
        best = strongest(wind, gust)
        if code in (95, 96, 99):
            return True, "Confirmed: live weather feed reports an active thunderstorm cell."
        if best >= STORM_WIND_KMH:
            return True, f"Confirmed: storm-force winds of {best} km/h recorded nearby."
        return False, "Not corroborated: no active storm signal in the live weather feed."

    return False, UNVERIFIABLE_HINT


def verify_reports(
    reports: list[dict],
    weather: dict | None,
    pfz_zones: list[dict] | None = None,
) -> list[dict]:
    """Cross-reference every human report against the physical sensor data.

    Returns new dicts (input untouched) with `verified`, `verification_note` and
    `verification_source` populated so the UI can render trust at a glance. The
    database's own `verified` flag is deliberately overwritten: trust is always
    a *current* judgement, not a stored claim.
    """
    out: list[dict] = []
    for report in reports or []:
        verified, note = _corroboration(report, weather or {}, pfz_zones)
        source = None
        if verified:
            source = (
                "INCOIS PFZ bulletin (PostGIS)"
                if str(report.get("category") or "").lower() in PFZ_CATEGORIES
                else (weather or {}).get("source")
            )
        out.append({
            **report,
            "verified": verified,
            "verification_note": note,
            "verification_source": source,
        })
    return out


async def verify_reports_for_point(
    reports: list[dict],
    weather: dict | None,
) -> list[dict]:
    """Verify reports whose rules need the PFZ bulletin, fetching it lazily.

    Each report carries its own position, so the bulletin is only fetched when
    at least one report is a fishing claim (catch / fishing zone)."""
    needs_pfz = any(
        str(r.get("category") or "").lower() in PFZ_CATEGORIES for r in reports or []
    )
    zones: list[dict] | None = None
    if needs_pfz:
        try:
            from app.services import incois  # local import: avoids a cycle

            bulletin = await incois.get_pfz_bulletin()
            zones = [
                {**f.get("properties", {}), "geojson": f.get("geometry")}
                for f in (bulletin.get("geojson") or {}).get("features", [])
            ]
        except Exception as exc:
            log.warning("PFZ bulletin unavailable for community verification: %s", exc)
    return verify_reports(reports, weather, zones)


def to_geojson(reports: list[dict]) -> dict:
    """Verified + unverified reports as styled point features for the map."""
    features = []
    for r in reports:
        geom = r.get("geojson")
        if not geom:
            geom = {"type": "Point", "coordinates": [r.get("lon"), r.get("lat")]}
        verified = bool(r.get("verified"))
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "zone": "community",
                "pin": "community",
                "color": "#22d3ee" if verified else "#f59e0b",
                "verified": verified,
                "category": r.get("category"),
                "description": r.get("description"),
                "reporter_role": r.get("reporter_role"),
                "reporter_name": r.get("reporter_name"),
                "media_url": r.get("media_url"),
                "media_type": r.get("media_type"),
                "observed_at": r.get("observed_at"),
                "verification_note": r.get("verification_note"),
                "verification_source": r.get("verification_source"),
            },
        })
    return {"type": "FeatureCollection", "features": features}
