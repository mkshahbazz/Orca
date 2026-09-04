"""INCOIS integration seam: PFZ zones read from PostGIS + mock ocean metrics.

Keeps the same return contract a real INCOIS/ISRO API would use, so swapping
in the live endpoint later only touches this file.
"""
from datetime import datetime, timezone

from app.services import geospatial


async def get_pfz_bulletin() -> dict:
    """Bulletin: PFZ GeoJSON + count + mock satellite metrics."""
    geojson = await geospatial.get_pfz_zones_geojson()
    return {
        "source": "INCOIS (mock layer over PostGIS)",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "zone_count": len(geojson["features"]),
        "geojson": geojson,
    }


async def get_ocean_metrics(lat: float, lon: float) -> dict:
    """Mock satellite-derived SST / chlorophyll for a coordinate."""
    return {
        "source": "INCOIS (mock)",
        "lat": lat, "lon": lon,
        "sea_surface_temperature_c": 29.3,
        "chlorophyll_mg_m3": 1.6,
    }
