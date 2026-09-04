"""PostGIS access via asyncpg: hazard geofencing + PFZ zone fetch.

Coordinate ordering is X=lon, Y=lat (EPSG:4326). This is the #1 bug source —
ST_MakePoint(lon, lat), never (lat, lon).
"""
import json

import asyncpg
import pgvector.asyncpg

from app.config import settings

_pool: asyncpg.Pool | None = None


async def init_pool() -> None:
    global _pool
    if _pool is None:
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set in backend/.env")
        _pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def ping() -> bool:
    if _pool is None:
        return False
    async with _pool.acquire() as conn:
        return bool(await conn.fetchval("SELECT 1"))


async def check_hazard_zone(lat: float, lon: float) -> list[dict]:
    """Return every hazard zone containing the point, with its GeoJSON polygon."""
    if _pool is None:
        raise RuntimeError("DB pool not initialised — call init_pool() first")
    sql = """
        SELECT id, name, severity, advisory,
               ST_AsGeoJSON(geometry)::text AS geojson
        FROM hazard_zones
        WHERE ST_Contains(geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))
    """
    async with _pool.acquire() as conn:
        rows = await conn.fetch(sql, lon, lat)  # $1=lon, $2=lat
    return [dict(r) | {"geojson": json.loads(r["geojson"])} for r in rows]


async def get_pfz_zones_geojson() -> dict:
    """Active PFZ zones as a styled GeoJSON FeatureCollection (green)."""
    if _pool is None:
        raise RuntimeError("DB pool not initialised — call init_pool() first")
    sql = """
        SELECT id, location_name, sst, chlorophyll, valid_until,
               ST_AsGeoJSON(geometry)::text AS geojson
        FROM pfz_zones
        WHERE valid_until > now()
        ORDER BY chlorophyll DESC
    """
    async with _pool.acquire() as conn:
        rows = await conn.fetch(sql)
    features = []
    for r in rows:
        geom = json.loads(r["geojson"])
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "zone": "pfz", "color": "#22c55e",
                "location_name": r["location_name"],
                "sst": r["sst"], "chlorophyll": r["chlorophyll"],
                "valid_until": str(r["valid_until"]),
            },
        })
    return {"type": "FeatureCollection", "features": features}
