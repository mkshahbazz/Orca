"""LangGraph multi-agent DAG.

Flow: START -> router (LLM intent classification)
           -> conditional edge returns [Send(...)] -> parallel specialist nodes
           -> synthesize (gpt-4o markdown) -> END

No cycles: termination is guaranteed. Each worker writes ONE distinct state key,
so parallel branches never conflict.
"""
import re
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from app.llm import chat_json, chat_markdown
from app.services import advisory, geospatial, incois, weather

# ---------------------------------------------------------------- state
class AgentState(TypedDict, total=False):
    message: str
    intent: str
    coordinates: dict[str, float] | None
    weather_data: dict[str, Any] | None
    geospatial_data: dict[str, Any] | None
    pfz_data: dict[str, Any] | None
    advisory_data: dict[str, Any] | None
    map_features: dict[str, Any] | None
    response: str

INTENTS = ("weather", "pfz_search", "hazard_check", "general_advisory")

# intent -> workers to fan out to (every intent maps to >= 1 worker)
TASK_MAP = {
    "weather":        ["weather"],
    "pfz_search":     ["pfz", "advisory"],
    "hazard_check":   ["geospatial", "weather", "advisory"],
    "general_advisory": ["advisory"],
}

_COORD_RE = re.compile(
    r"(?P<lat>-?\d{1,2}(?:\.\d+)?)\s*[,;\s]+\s*(?P<lon>-?\d{1,3}(?:\.\d+)?)"
)

# ---------------------------------------------------------------- router
ROUTER_SYS = (
    "You are the intent router of a marine safety assistant. Reply with JSON only: "
    '{"intent": "<one of weather|pfz_search|hazard_check|general_advisory>", '
    '"lat": <number|null>, "lon": <number|null>}. '
    "Extract coordinates from text like '16.0, 86.5', '16N 86.5E', 'lat 16 lon 86.5'. "
    "Rules: fishing/safety/coordinates/boundary questions -> hazard_check; "
    "waves/wind/weather/cyclone -> weather; PFZ/fishing zone/chlorophyll/SST -> pfz_search; "
    "anything else (regulations, general advice) -> general_advisory."
)


def _extract_coords(text: str) -> dict[str, float] | None:
    m = _COORD_RE.search(text)
    if m:
        return {"lat": float(m.group("lat")), "lon": float(m.group("lon"))}
    return None


async def router_node(state: AgentState) -> dict:
    """Classify intent + coordinates; fall back to heuristics if the LLM fails."""
    coords = _extract_coords(state["message"])
    intent = "general_advisory"
    try:
        out = await chat_json(ROUTER_SYS, state["message"])
        if out.get("intent") in INTENTS:
            intent = out["intent"]
        if out.get("lat") is not None and out.get("lon") is not None:
            coords = {"lat": float(out["lat"]), "lon": float(out["lon"])}
    except Exception:
        msg = state["message"].lower()
        if "pfz" in msg or "fish zone" in msg or "chlorophyll" in msg:
            intent = "pfz_search"
        elif coords and ("fish" in msg or "safe" in msg or "venture" in msg):
            intent = "hazard_check"
        elif any(w in msg for w in ("weather", "wave", "wind", "cyclone")):
            intent = "weather"
    return {"intent": intent, "coordinates": coords}


def route_workers(state: AgentState) -> list[Send]:
    """Conditional edge: fan out to the workers required by this intent."""
    tasks = TASK_MAP.get(state.get("intent"), ["advisory"])
    payload = {
        "message": state["message"],
        "intent": state["intent"],
        "coordinates": state.get("coordinates"),
    }
    node_map = {
        "weather": "weather_node",
        "geospatial": "geospatial_node",
        "pfz": "pfz_node",
        "advisory": "advisory_node",
    }
    return [Send(node_map[t], payload) for t in tasks]

# ---------------------------------------------------------------- workers
async def weather_node(state: AgentState) -> dict:
    c = state.get("coordinates") or {}
    data = await weather.get_marine_conditions(c.get("lat"), c.get("lon"))
    return {"weather_data": data}


async def geospatial_node(state: AgentState) -> dict:
    """Geofence: ST_Contains check + red GeoJSON if the point is inside a zone."""
    c = state.get("coordinates")
    if not c:
        return {"geospatial_data": {"zones": [], "geojson": None,
                                    "checked": False}}
    zones = await geospatial.check_hazard_zone(c["lat"], c["lon"])
    features = [{
        "type": "Feature",
        "geometry": z["geojson"],
        "properties": {
            "zone": "hazard", "color": "#ef4444",
            "name": z["name"], "severity": z["severity"], "advisory": z["advisory"],
        },
    } for z in zones]
    fc = {"type": "FeatureCollection", "features": features} if features else None
    return {"geospatial_data": {"zones": zones, "geojson": fc,
                                "checked": True, "lat": c["lat"], "lon": c["lon"]}}


async def pfz_node(state: AgentState) -> dict:
    return {"pfz_data": await incois.get_pfz_bulletin()}


async def advisory_node(state: AgentState) -> dict:
    try:
        matches = await advisory.match_advisories(state["message"])
    except Exception as exc:                      # embeddings not seeded yet
        matches = [{"note": f"advisory RAG unavailable: {exc}"}]
    return {"advisory_data": {"matches": matches}}

# ---------------------------------------------------------------- synthesizer
SYNTH_SYS = (
    "You are a marine safety officer writing for fishermen and coastal authorities. "
    "Answer in markdown. Cite sources by name (Open-Meteo, INCOIS, PostGIS hazard DB, "
    "advisory knowledge base). If a hazard zone hit is reported you MUST lead with a "
    "prominent ⚠️ warning and a strict DO-NOT recommendation. Never invent numbers — "
    "use only the data provided. Keep it under ~180 words. Always end with a short "
    "'🛰️ Map' line describing what was drawn (red = hazard, green = PFZ)."
)


def _merge_features(state: AgentState) -> dict:
    features: list[dict] = []
    gd = (state.get("geospatial_data") or {}).get("geojson")
    pd = (state.get("pfz_data") or {}).get("geojson")
    if gd:
        features += gd["features"]
    if pd:
        features += pd["features"]
    return {"type": "FeatureCollection", "features": features}


def _context(state: AgentState) -> str:
    parts = [f"User query: {state['message']}",
             f"Intent: {state.get('intent')}",
             f"Coordinates: {state.get('coordinates')}"]
    w = state.get("weather_data")
    if w:
        parts.append("WEATHER: " + ", ".join(f"{k}={v}" for k, v in w.items()))
    g = state.get("geospatial_data") or {}
    zones = g.get("zones") or []
    parts.append("HAZARD CHECK: " + (f"HIT -> {zones}" if zones else "No active hazard zone at this location."))
    p = state.get("pfz_data")
    if p:
        names = [f["properties"]["location_name"] for f in p.get("geojson", {}).get("features", [])]
        parts.append(f"PFZ ZONES ({p.get('zone_count', 0)}): {names}")
    a = state.get("advisory_data") or {}
    for m in (a.get("matches") or [])[:2]:
        parts.append(f"ADVISORY [{m.get('category')}] {m.get('title')}: {(m.get('content') or '')[:400]}")
    return "\n".join(parts)


async def synthesize_node(state: AgentState) -> dict:
    """gpt-4o markdown answer; deterministic fallback if the LLM call fails."""
    map_features = _merge_features(state)
    try:
        response = await chat_markdown(SYNTH_SYS, _context(state))
    except Exception:
        g = state.get("geospatial_data") or {}
        zones = g.get("zones") or []
        lines = []
        if zones:
            for z in zones:
                lines.append(f"⚠️ **{z['name']}** (severity: {z['severity']}) — {z['advisory']}")
            lines.append("**Recommendation: DO NOT proceed to this location.**")
        else:
            lines.append("✅ No active hazard zone was found at the given coordinates.")
        w = state.get("weather_data") or {}
        if w:
            lines.append(f"\n🌊 Marine conditions: {w.get('weather')}, wave height {w.get('wave_height_m')} m, "
                         f"wind {w.get('wind_speed_kmh')} km/h (gust {w.get('wind_gusts_kmh')} km/h), "
                         f"SST {w.get('sea_surface_temperature_c')} °C — *{w.get('source')}*.")
        p = state.get("pfz_data")
        if p and p.get("zone_count"):
            lines.append(f"\n🎣 {p['zone_count']} active PFZ zone(s) shown in green — *{p['source']}*.")
        response = "\n\n".join(lines)
    return {"response": response, "map_features": map_features}

# ---------------------------------------------------------------- graph
def build_graph():
    g = StateGraph(AgentState)
    g.add_node("router", router_node)
    g.add_node("weather_node", weather_node)
    g.add_node("geospatial_node", geospatial_node)
    g.add_node("pfz_node", pfz_node)
    g.add_node("advisory_node", advisory_node)
    g.add_node("synthesize", synthesize_node)

    g.add_edge(START, "router")
    # router -> parallel workers (Send fan-out); workers rejoin at synthesize
    g.add_conditional_edges(
        "router", route_workers,
        ["weather_node", "geospatial_node", "pfz_node", "advisory_node"],
    )
    for w in ("weather_node", "geospatial_node", "pfz_node", "advisory_node"):
        g.add_edge(w, "synthesize")
    g.add_edge("synthesize", END)
    return g.compile()


graph = build_graph()
