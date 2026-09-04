"""Open-Meteo marine + forecast wrappers (async, httpx)."""
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


def _fallback(lat: float, lon: float) -> dict:
    """Graceful demo payload when the marine API is unreachable."""
    return {
        "lat": lat, "lon": lon, "source": "fallback (demo)",
        "wave_height_m": 1.8, "wave_direction_deg": 135, "wave_period_s": 7.0,
        "wind_wave_height_m": 0.9, "swell_wave_height_m": 1.2,
        "sea_surface_temperature_c": 29.2, "wind_speed_kmh": 28,
        "wind_gusts_kmh": 42, "weather": "Partly cloudy",
    }


async def get_marine_conditions(lat: float | None = None, lon: float | None = None) -> dict:
    """Live waves + SST (marine API) and wind/weather (forecast API)."""
    lat = lat if lat is not None else _DEFAULT["lat"]
    lon = lon if lon is not None else _DEFAULT["lon"]

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            m, f = await client.get(MARINE_URL, params={
                "latitude": lat, "longitude": lon,
                "current": MARINE_CURRENT, "timezone": "auto",
            }), await client.get(FORECAST_URL, params={
                "latitude": lat, "longitude": lon,
                "current": FORECAST_CURRENT, "timezone": "auto",
            })
            m.raise_for_status(); f.raise_for_status()
            mj, fj = m.json()["current"], f.json()["current"]
            wcode = fj.get("weather_code")
            return {
                "lat": lat, "lon": lon, "source": "Open-Meteo (live)",
                "wave_height_m": mj.get("wave_height"),
                "wave_direction_deg": mj.get("wave_direction"),
                "wave_period_s": mj.get("wave_period"),
                "wind_wave_height_m": mj.get("wind_wave_height"),
                "swell_wave_height_m": mj.get("swell_wave_height"),
                "sea_surface_temperature_c": mj.get("sea_surface_temperature"),
                "wind_speed_kmh": fj.get("wind_speed_10m"),
                "wind_gusts_kmh": fj.get("wind_gusts_10m"),
                "air_temperature_c": fj.get("temperature_2m"),
                "weather": WEATHER_CODES.get(wcode, f"Code {wcode}"),
            }
        except Exception:  # offline / rate-limited -> deterministic fallback
            return _fallback(lat, lon)
