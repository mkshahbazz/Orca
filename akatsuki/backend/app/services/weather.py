"""Open-Meteo marine + forecast wrappers (async, httpx).

Performance notes:
- one module-level AsyncClient (connection pooling, keep-alive) instead of a
  new client + TLS handshake per request
- the two Open-Meteo endpoints are fetched *concurrently* (asyncio.gather)
- a small in-memory TTL cache absorbs repetitive queries for the same
  location (marine data moves slowly; 10 min is safely fresh)
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

WEATHER_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Rain", 65: "Heavy rain",
    80: "Rain showers", 95: "Thunderstorm", 96: "Thunderstorm w/ hail",
    99: "Severe thunderstorm w/ hail",
}

_DEFAULT = {"lat": 13.0827, "lon": 80.2707}  # Chennai

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


async def startup() -> None:
    """Create the shared client (call once from app lifespan)."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=4.0),
            limits=httpx.Limits(
                max_connections=40, max_keepalive_connections=20
            ),
            headers={"User-Agent": "orca-marine-assistant/1.0"},
        )


async def shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _fallback(lat: float, lon: float) -> dict:
    """Graceful demo payload when the marine API is unreachable."""
    return {
        "lat": lat, "lon": lon, "source": "fallback (demo)",
        "wave_height_m": 1.8, "wave_direction_deg": 135, "wave_period_s": 7.0,
        "wind_wave_height_m": 0.9, "swell_wave_height_m": 1.2,
        "sea_surface_temperature_c": 29.2, "wind_speed_kmh": 28,
        "wind_gusts_kmh": 42, "weather": "Partly cloudy",
    }


def _round(v: float | None, nd: int = 1) -> float | None:
    return round(v, nd) if isinstance(v, (int, float)) else None


async def get_marine_conditions(lat: float | None = None, lon: float | None = None) -> dict:
    """Live waves + SST (marine API) and wind/weather (forecast API).

    Returns a trimmed payload (rounded floats, short keys) to cut JSON
    transit size between agent -> backend -> frontend.
    """
    lat = lat if lat is not None else _DEFAULT["lat"]
    lon = lon if lon is not None else _DEFAULT["lon"]

    key = f"{round(float(lat), 2):.2f},{round(float(lon), 2):.2f}"
    hit = _cache_get(key)
    if hit is not None:
        return dict(hit, cached=True)

    params = {
        "marine": {"latitude": lat, "longitude": lon,
                   "current": MARINE_CURRENT, "timezone": "auto"},
        "forecast": {"latitude": lat, "longitude": lon,
                     "current": FORECAST_CURRENT, "timezone": "auto"},
    }

    try:
        async with asyncio.timeout(8):
            m_resp, f_resp = await asyncio.gather(
                _client.get(MARINE_URL, params=params["marine"]),
                _client.get(FORECAST_URL, params=params["forecast"]),
            )
            m_resp.raise_for_status()
            f_resp.raise_for_status()
            mj = m_resp.json()["current"]
            fj = f_resp.json()["current"]
    except Exception:  # offline / rate-limited / timeout -> deterministic fallback
        return _fallback(lat, lon)

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
    }
    _cache_put(key, data)
    return dict(data, cached=False)
