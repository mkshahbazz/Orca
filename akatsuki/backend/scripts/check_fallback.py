"""Offline check of the Monk's LLM-free fallback composer.

Stubs the heavy third-party imports (openai/langgraph/httpx/pydantic-settings)
that aren't installed on this machine, then calls _fallback_answer directly
with a synthetic agent state shaped exactly like the real worker payloads.
"""
import sys
import types
from pathlib import Path

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

from app.agents import _fallback_answer  # noqa: E402

state = {
    "message": "Is it safe to fish near 21.4, 87.9?",
    "intent": "hazard_check",
    "coordinates": {"lat": 21.4, "lon": 87.9},
    "weather_data": {
        "lat": 21.4, "lon": 87.9, "source": "Open-Meteo (live)",
        "wave_height_m": 1.4, "wave_direction_deg": 245, "wave_period_s": 9,
        "sea_surface_temperature_c": 29.0,
        "wind_speed_kmh": 11, "wind_gusts_kmh": 15,
        "air_temperature_c": 30, "weather": "Partly cloudy",
    },
    "geospatial_data": {"checked": True, "zones": [], "geojson": None},
    "pfz_data": {
        "source": "INCOIS (mock layer over PostGIS)", "zone_count": 2,
        "geojson": {"features": [
            {"properties": {"location_name": "Off Digha", "probability": 74}},
            {"properties": {"location_name": "SW of Paradip", "probability": 66}},
        ]},
    },
    "advisory_data": {"matches": [{"category": "safety", "title": "Monsoon trawler advisory", "content": "Keep to lee of the shelf edge when gusts exceed 25 kt."}]},
    "community_data": {"reports": [{"description": "Strong currents near the sandbar", "verified": True, "observed_at": "2026-09-28"}], "verified_count": 1},
    "feed_errors": [],
}

out = _fallback_answer(state)
print(out)
print("\n" + "=" * 60)
checks = {
    "mentions coordinates": "21.40°N" in out,
    "wind line": "Wind:" in out and "kt" in out,
    "wave line": "Waves:" in out and "1.4 m" in out,
    "verdict": "Favourable" in out or "Workable" in out or "Poor" in out,
    "hazard section": "Hazard geofence" in out,
    "pfz section": "Off Digha" in out,
    "advisory": "Monsoon trawler advisory" in out,
    "community": "Strong currents" in out,
    "honesty line": "live feeds" in out,
    "map line": "🛰️ Map:" in out,
}
ok = all(checks.values())
for k, v in checks.items():
    print(f"  {'PASS' if v else 'FAIL'}  {k}")
sys.exit(0 if ok else 1)
