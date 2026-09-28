"""Offline check of the Monk's LLM-free fallback composer.

Stubs the heavy third-party imports (openai/langgraph/httpx/pydantic-settings)
that aren't installed on this machine, then calls _fallback_answer directly with
synthetic agent states shaped exactly like the real worker payloads.

The composer is what answers when the AI provider is unreachable, so these
checks are about honesty and style: every number must come from a feed, the
readings must be *explained* rather than listed, a region must never be passed
off as a single point, and a question with no location must never be answered
from a default one.
"""
import re
import sys
import types
from pathlib import Path

# the answers contain °C and ⚠️ — keep Windows consoles from choking on them
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# --- stub third-party modules the import chain needs -----------------------
for name in ("openai", "httpx", "langgraph", "langgraph.graph", "langgraph.types",
             "pydantic_settings", "fastapi", "fastapi.responses", "supabase",
             "asyncpg", "postgrest"):
    mod = types.ModuleType(name)
    sys.modules.setdefault(name, mod)
sys.modules["openai"].AsyncOpenAI = object
sys.modules["httpx"].AsyncClient = object

asyncpg_mod = sys.modules["asyncpg"]
asyncpg_mod.create_pool = lambda **kw: None
asyncpg_mod.Pool = object

pgvector = types.ModuleType("pgvector")
pgvector_asyncpg = types.ModuleType("pgvector.asyncpg")
pgvector_asyncpg.register = lambda *a, **kw: None
pgvector.asyncpg = pgvector_asyncpg
sys.modules["pgvector"] = pgvector
sys.modules["pgvector.asyncpg"] = pgvector_asyncpg

class _StubGraph:
    def __init__(self, *a, **kw):
        pass
    def add_node(self, *a, **kw):
        return self
    def add_edge(self, *a, **kw):
        return self
    def add_conditional_edges(self, *a, **kw):
        return self
    def compile(self, *a, **kw):
        return types.SimpleNamespace(ainvoke=None)

langgraph_graph = sys.modules["langgraph.graph"]
langgraph_graph.StateGraph = _StubGraph
langgraph_graph.START = "START"
langgraph_graph.END = "END"
langgraph_types = sys.modules["langgraph.types"]
langgraph_types.Send = object

class _BaseSettings:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)

sys.modules["pydantic_settings"].BaseSettings = _BaseSettings
sys.modules["pydantic_settings"].SettingsConfigDict = lambda **kw: {}

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agents import _clarification, _fallback_answer  # noqa: E402

WEATHER = {
    "lat": 21.4, "lon": 87.9, "source": "Open-Meteo (live)",
    "wave_height_m": 1.4, "wave_direction_deg": 245, "wave_period_s": 9,
    "sea_surface_temperature_c": 29.0,
    "wind_speed_kmh": 11, "wind_gusts_kmh": 15,
    "air_temperature_c": 30, "weather": "Partly cloudy",
    "forecast_days": [
        {"date": "2026-09-29", "wave_max_m": 1.2, "wind_max_kmh": 22,
         "gust_max_kmh": 34, "weather": "Partly cloudy", "rain_chance_pct": 40},
    ],
}

state = {
    "message": "Is it safe to fish near Digha?",
    "intent": "hazard_check",
    "coordinates": {"lat": 21.4, "lon": 87.9},
    "location": {"label": "Digha", "display_name": "Digha, Purba Medinipur, West Bengal, India",
                 "lat": 21.4, "lon": 87.9, "scope": "point", "representative": False},
    "weather_data": WEATHER,
    "geospatial_data": {"checked": True, "zones": [], "geojson": None},
    "pfz_data": {
        "source": "INCOIS (mock layer over PostGIS)", "zone_count": 2,
        "geojson": {"features": [
            {"properties": {"location_name": "Off Digha", "probability": 74}},
            {"properties": {"location_name": "SW of Paradip", "probability": 66}},
        ]},
    },
    "advisory_data": {"matches": [{"category": "safety", "title": "Monsoon trawler advisory",
                                   "content": "Keep to lee of the shelf edge when gusts exceed 25 kt."}]},
    "community_data": {"reports": [{"description": "Strong currents near the sandbar",
                                    "verified": True, "observed_at": "2026-09-28"}],
                       "verified_count": 1, "searched": True},
    "feed_errors": [],
}

out = _fallback_answer(state)
print(out)
print("\n" + "=" * 60)

region = dict(
    state,
    message="What are the weather conditions in Odisha?",
    location={"label": "Odisha", "display_name": "Odisha, India",
              "lat": 19.2, "lon": 84.9, "scope": "region", "representative": True},
)
region_out = _fallback_answer(region)
print(region_out)
print("\n" + "=" * 60)

no_location = {"message": "What is the weather like?", "intent": "weather",
               "needs_location": True, "coordinates": None}
no_location_out = _fallback_answer(no_location)
print(no_location_out)
print("\n" + "=" * 60)

checks = {
    "names the location": "Digha" in out,
    "explains the waves instead of listing them":
        "Waves are about 1.4 m" in out and "moderate but manageable" in out,
    "explains the wind together with its gusts": "gusting to 15 km/h" in out,
    "no raw field dump": not re.search(r"^-\s+[A-Z][a-z]+:", out, re.M),
    "plain-language sea-state verdict": "Sea state:" in out,
    "hazard wording is precise, not absolute":
        "not that the area is hazard-free" in out,
    "PFZ zones named": "Off Digha" in out,
    "advisory included": "Monsoon trawler advisory" in out,
    "community report included": "Strong currents" in out,
    "feeds disclaimer present": "live feeds" in out,
    "map line present": "🛰️ Map:" in out,
    "region scope stated": "representative point" in region_out
        and "not for the whole area" in region_out,
    "no-location question asks instead of answering": no_location_out == _clarification(no_location)
        and "which location" in no_location_out.lower(),
}
ok = all(checks.values())
for k, v in checks.items():
    print(f"  {'PASS' if v else 'FAIL'}  {k}")
sys.exit(0 if ok else 1)
