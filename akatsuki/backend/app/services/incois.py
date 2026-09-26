"""INCOIS integration seam: PFZ zones read from PostGIS + mock ocean metrics.

Keeps the same return contract a real INCOIS/ISRO API would use, so swapping
in the live endpoint later only touches this file.

The bulletin only changes when the underlying pfz_zones rows change, so it is
cached in-memory with a short TTL — every user asking about PFZs shares one
PostGIS round-trip instead of hammering the DB.
"""
import time
from datetime import datetime, timezone

from app.services import geospatial

_BULLETIN_TTL = 120  # seconds

_bulletin_cache: tuple[float, dict] | None = None


async def get_pfz_bulletin() -> dict:
    """Bulletin: PFZ GeoJSON + count + mock satellite metrics (TTL-cached)."""
    global _bulletin_cache

    now = time.monotonic()
    if _bulletin_cache is not None:
        expires, value = _bulletin_cache
        if expires > now:
            return value

    geojson = await geospatial.get_pfz_zones_geojson()
    bulletin = {
        "source": "INCOIS (mock layer over PostGIS)",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "zone_count": len(geojson["features"]),
        "geojson": geojson,
    }
    _bulletin_cache = (now + _BULLETIN_TTL, bulletin)
    return bulletin


async def get_ocean_metrics(lat: float, lon: float) -> dict:
    """Mock satellite-derived SST / chlorophyll for a coordinate."""
    return {
        "source": "INCOIS (mock)",
        "lat": lat, "lon": lon,
        "sea_surface_temperature_c": 29.3,
        "chlorophyll_mg_m3": 1.6,
    }
