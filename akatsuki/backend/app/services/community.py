"""Crowdsourced marine intelligence: proximity search + verification matrix.

Community reports (fishermen, coastal workers, harbour staff) live in the
`community_reports` table — a PostGIS point plus category, description and the
time it happened. This module provides the two halves the agents need:

1. :func:`find_nearby_reports` — spatial search around a queried location.
2. :func:`verify_reports` — the verification matrix. A human tip is NEVER
   trusted blindly: each claim is cross-referenced against the physical
   satellite/weather readings for the same point and time window. Only claims
   the sensors can corroborate are promoted to `verified`, and only verified
   reports are allowed to influence the answer's confidence score.
"""
import json
import logging
from datetime import datetime, timezone

from app.services import geospatial

log = logging.getLogger("marine.community")

# Search neighbourhood + freshness window for relevancy.
DEFAULT_RADIUS_KM = 75.0
DEFAULT_MAX_AGE_HOURS = 72

# Human-observable claims the physical feeds can corroborate.
#   category -> (thresholds describing what confirms it)
WAVE_CATEGORIES = {"heavy_swell", "high_wave", "rough_seas"}
WIND_CATEGORIES = {"high_wind", "squall"}
STORM_CATEGORIES = {"thunderstorm", "storm"}

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


def _row_to_report(row) -> dict:
    report = dict(row)
    geom = report.pop("geojson", None)
    if geom:
        report["geojson"] = json.loads(geom)
    observed = report.get("observed_at")
    if isinstance(observed, datetime):
        report["observed_at"] = observed.astimezone(timezone.utc).isoformat()
    return report


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
    if geospatial._pool is None:
        log.warning("community search skipped: DB pool not initialised")
        return []

    sql = """
        SELECT id, category, description, reporter_role, lat, lon, observed_at,
               ST_AsGeoJSON(location)::text AS geojson
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
        async with geospatial._pool.acquire() as conn:
            rows = await conn.fetch(sql, lon, lat, max_age_hours, radius_km * 1000.0, limit)
    except Exception as exc:  # table missing / DB hiccup -> degrade, don't fail
        log.warning("community search failed: %s", exc)
        return []
    return [_row_to_report(r) for r in rows]


def _corroboration(report: dict, weather: dict) -> tuple[bool, str]:
    """Apply the verification matrix to a single report. -> (verified, note)"""
    category = str(report.get("category") or "").lower()
    if not weather:
        return False, "No live sensor reading was available to cross-check this report."

    wave = weather.get("wave_height_m")
    swell = weather.get("swell_wave_height_m")
    period = weather.get("wave_period_s")
    wind = weather.get("wind_speed_kmh")
    gust = weather.get("wind_gusts_kmh")
    code = weather.get("weather_code")

    if category in WAVE_CATEGORIES:
        best = max([v for v in (wave, swell) if isinstance(v, (int, float))] or [0])
        if best >= SWELL_WAVE_M:
            return True, (
                f"Confirmed: live wave/swell height {best} m near the reported position."
            )
        if isinstance(period, (int, float)) and period >= SWELL_PERIOD_S:
            return True, f"Confirmed: long swell period of {period} s at the reported position."
        return False, (
            f"Contradicted by sensors: live wave/swell height is only {best} m "
            f"(threshold {SWELL_WAVE_M} m)."
        )

    if category in WIND_CATEGORIES:
        best = max([v for v in (wind, gust) if isinstance(v, (int, float))] or [0])
        if best >= WIND_KMH:
            return True, f"Confirmed: live wind/gust speed {best} km/h in the reported area."
        return False, (
            f"Contradicted by sensors: live wind/gust speed is only {best} km/h "
            f"(threshold {WIND_KMH} km/h)."
        )

    if category in STORM_CATEGORIES:
        best = max([v for v in (wind, gust) if isinstance(v, (int, float))] or [0])
        if code in (95, 96, 99):
            return True, "Confirmed: live weather feed reports an active thunderstorm cell."
        if best >= STORM_WIND_KMH:
            return True, f"Confirmed: storm-force winds of {best} km/h recorded nearby."
        return False, "Not corroborated: no active storm signal in the live weather feed."

    return False, UNVERIFIABLE_HINT


def verify_reports(reports: list[dict], weather: dict | None) -> list[dict]:
    """Cross-reference every human report against the physical sensor data.

    Returns new dicts (input untouched) with `verified`, `verification_note` and
    `verification_source` populated so the UI can render trust at a glance.
    """
    out: list[dict] = []
    for report in reports or []:
        verified, note = _corroboration(report, weather or {})
        out.append({
            **report,
            "verified": verified,
            "verification_note": note,
            "verification_source": (weather or {}).get("source") if verified else None,
        })
    return out


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
                "observed_at": r.get("observed_at"),
                "verification_note": r.get("verification_note"),
                "verification_source": r.get("verification_source"),
            },
        })
    return {"type": "FeatureCollection", "features": features}
