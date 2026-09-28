"""LangGraph multi-agent DAG.

Flow: START -> router (LLM intent classification)
           -> conditional edge returns [Send(...)] -> parallel specialist nodes
           -> verify (community corroboration + confidence scoring)
           -> synthesize (gpt-4o markdown) -> END

No cycles: termination is guaranteed. Each worker writes ONE distinct state key,
so parallel branches never conflict.

Two payloads leave this module and they never touch each other:
  * `response`   — the conversational markdown, streamed token-by-token;
  * `confidence` — the self-assessment (score + one-line justification) which is
    returned as a separate field so it cannot interrupt the typing stream.
"""
import asyncio
import re
from typing import Any, AsyncIterator, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from app.llm import LLMError, chat_json, chat_markdown, chat_markdown_stream
from app.services import advisory, community, confidence, geospatial, incois, weather

# ---------------------------------------------------------------- state
class AgentState(TypedDict, total=False):
    message: str
    intent: str
    coordinates: dict[str, float] | None
    weather_data: dict[str, Any] | None
    geospatial_data: dict[str, Any] | None
    pfz_data: dict[str, Any] | None
    advisory_data: dict[str, Any] | None
    community_data: dict[str, Any] | None
    feed_errors: list[str]
    confidence: dict[str, Any] | None
    map_features: dict[str, Any] | None
    response: str

INTENTS = ("weather", "pfz_search", "hazard_check", "general_advisory")

# intent -> workers to fan out to (every intent maps to >= 1 worker)
TASK_MAP = {
    "weather":        ["weather", "community"],
    "pfz_search":     ["pfz", "advisory", "community"],        "hazard_check":   ["geospatial", "weather", "advisory", "community"],
    "general_advisory": ["advisory", "weather_lenient"],
}

# Human-readable milestones the UI shows while it waits (live status transparency).
STATUS_LABELS = {
    "routed": "Understanding your question…",
    "weather": "Checking weather buoys…",
    "geospatial": "Checking hazard zones…",
    "pfz": "Fetching the PFZ bulletin…",
    "advisory": "Searching safety advisories…",
    "weather_lenient": "Checking weather buoys…",
    "community": "Scanning community reports…",
    "verifying": "Cross-checking human reports against live sensors…",
    "synthesizing": "Writing safety report…",
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
        # Deterministic keyword parsing — not fabricated data, just a fallback
        # classifier when the router LLM is unreachable.
        msg = state["message"].lower()
        if "pfz" in msg or "fish zone" in msg or "chlorophyll" in msg:
            intent = "pfz_search"
        elif coords and ("fish" in msg or "safe" in msg or "venture" in msg):
            intent = "hazard_check"
        elif any(w in msg for w in ("weather", "wave", "wind", "cyclone")):
            intent = "weather"
        elif "fish" in msg or "safe" in msg:
            # Safety/fishing question without coordinates: the PFZ bulletin
            # path pulls zones + advisories + community, which is the most
            # useful real-data answer we can give.
            intent = "pfz_search"
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
        "weather_lenient": "weather_node_lenient",
        "geospatial": "geospatial_node",
        "pfz": "pfz_node",
        "advisory": "advisory_node",
        "community": "community_node",
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


async def weather_node_lenient(state: AgentState) -> dict:
    """Weather for general questions: keep going when the feed is down so a
    no-coordinate advisory question still gets its advisories answered."""
    try:
        return await weather_node(state)
    except Exception as exc:
        return {"feed_errors": [f"weather: {exc}"]}


async def community_node(state: AgentState) -> dict:
    """Pull crowdsourced reports near the queried location (never verified here:
    verification happens once weather data is in hand, in verify_node)."""
    c = state.get("coordinates")
    if not c:
        return {"community_data": {"reports": [], "searched": False}}
    reports = await community.find_nearby_reports(c["lat"], c["lon"])
    return {"community_data": {
        "reports": reports, "searched": True, "lat": c["lat"], "lon": c["lon"],
    }}

# ---------------------------------------------------------------- verification
async def verify_node(state: AgentState) -> dict:
    """Verification matrix + confidence scoring.

    Human tips are cross-referenced with the physical sensor readings gathered
    by the parallel workers; only sensor-corroborated reports are allowed to
    lift the final confidence score.
    """
    cd = state.get("community_data") or {}
    reports = community.verify_reports(cd.get("reports") or [], state.get("weather_data"))
    verified = [r for r in reports if r.get("verified")]
    scored = confidence.score_answer(state, verified_reports=verified)
    return {
        "community_data": {**cd, "reports": reports, "verified_count": len(verified)},
        "confidence": scored,
    }

# ---------------------------------------------------------------- synthesizer
SYNTH_SYS = (
    "You are a marine safety officer writing for fishermen and coastal authorities. "
    "Answer in markdown. Cite sources by name (Open-Meteo, INCOIS, PostGIS hazard DB, "
    "advisory knowledge base). If a hazard zone hit is reported you MUST lead with a "
    "prominent ⚠️ warning and a strict DO-NOT recommendation. Never invent numbers — "
    "use only the data provided. Keep it under ~180 words. Always end with a short "
    "'🛰️ Map' line describing what was drawn (red = hazard, green = PFZ, cyan/amber = "
    "community report pins)."
)


def _merge_features(state: AgentState) -> dict:
    features: list[dict] = []
    gd = (state.get("geospatial_data") or {}).get("geojson")
    pd = (state.get("pfz_data") or {}).get("geojson")
    cd = (state.get("community_data") or {}).get("reports")
    if gd:
        features += gd["features"]
    if pd:
        features += pd["features"]
    if cd:
        features += community.to_geojson(cd)["features"]
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
    cd = state.get("community_data") or {}
    for r in (cd.get("reports") or [])[:4]:
        trust = "VERIFIED" if r.get("verified") else "UNVERIFIED"
        parts.append(
            f"COMMUNITY [{trust}] {r.get('category')} by {r.get('reporter_role') or 'community'} "
            f"at {r.get('lat'):.3f},{r.get('lon'):.3f} on {r.get('observed_at')}: "
            f"{r.get('description')} — {r.get('verification_note')}"
        )
    return "\n".join(parts)


def _compass(deg: float | None) -> str:
    if deg is None:
        return ""
    dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return dirs[int((deg % 360) / 22.5) % 16]


def _sea_verdict(wave_m: float | None, gusts_kmh: float | None) -> str:
    """Plain-language verdict from observed values — same thresholds the
    dashboard console uses, so the chat never contradicts the map."""
    wave = wave_m if wave_m is not None else 99
    gust = gusts_kmh if gusts_kmh is not None else 0
    if wave < 1.5 and gust < 25:
        return "**Favourable** — small craft can work the nearshore grounds."
    if wave <= 2.5 and gust <= 40:
        return "**Workable with caution** — larger vessels OK; small craft keep to sheltered water."
    return "**Poor** — advise staying in harbour until the sea settles."


def _fmt_conditions(w: dict) -> list[str]:
    kt = lambda v: round(v / 1.852) if isinstance(v, (int, float)) else None
    wind, gusts = kt(w.get("wind_speed_kmh")), kt(w.get("wind_gusts_kmh"))
    lines = []
    if wind is not None:
        g = f", gusting {gusts} kt" if gusts else ""
        lines.append(f"- Wind: **{wind} kt**{g}")
    wave = w.get("wave_height_m")
    if wave is not None:
        per = w.get("wave_period_s")
        d = _compass(w.get("wave_direction_deg"))
        lines.append(f"- Waves: **{wave} m**" + (f" at {per} s" if per else "") + (f" from {d}" if d else ""))
    sst = w.get("sea_surface_temperature_c")
    if sst is not None:
        lines.append(f"- Sea surface: **{sst} °C**" + (f" · air {w['air_temperature_c']} °C" if w.get("air_temperature_c") is not None else ""))
    if w.get("weather"):
        lines.append(f"- Sky: {w['weather']}")
    return lines


def _fallback_answer(state: AgentState, partial: str = "") -> str:
    """Compose the answer straight from the live feeds the workers gathered.

    Used when the LLM provider is unreachable (quota exhausted, outage). Every
    number here comes from an observed/model feed — nothing is invented — and
    the answer says so, in one quiet line, without losing its authority.
    """
    c = state.get("coordinates") or {}
    where = f"{c['lat']:.2f}°N, {c['lon']:.2f}°E" if c else "your area"
    sections: list[str] = [f"**Feed brief for {where}**"]

    w = state.get("weather_data")
    if w:
        cond = _fmt_conditions(w)
        if cond:
            sections += ["### Observed conditions — Open-Meteo", *cond,
                         "", "→ " + _sea_verdict(w.get("wave_height_m"), w.get("wind_gusts_kmh"))]

    g = state.get("geospatial_data") or {}
    if g.get("checked"):
        zones = g.get("zones") or []
        if zones:
            z = zones[0]
            sections += ["", "### ⚠️ Hazard geofence — PostGIS",
                         f"This point is **inside recorded hazard zone “{z.get('name')}” (severity {z.get('severity')}). DO NOT venture here.** {z.get('advisory') or ''}".strip()]
        else:
            sections += ["", "### Hazard geofence — PostGIS",
                         "✅ No recorded hazard zone at this location."]

    p = state.get("pfz_data")
    if p:
        feats = (p.get("geojson") or {}).get("features") or []
        rows = []
        for f in feats[:4]:
            pr = f.get("properties") or {}
            name = pr.get("location_name") or pr.get("name") or "zone"
            prob = pr.get("probability")
            rows.append(f"{name}" + (f" ({prob}% likelihood)" if isinstance(prob, (int, float)) else ""))
        if rows:
            sections += ["", f"### Fishing zones — INCOIS bulletin ({p.get('zone_count', len(feats))} active)",
                         "· " + "\n· ".join(rows)]

    a = state.get("advisory_data") or {}
    for m in (a.get("matches") or [])[:2]:
        if m.get("title"):
            content = (m.get("content") or "").strip()[:220]
            sections += ["", f"### Advisory — {m.get('category') or 'general'}",
                         f"**{m['title']}**" + (f": {content}…”" if len(m.get("content") or "") > 220 else (f": {content}" if content else ""))]

    cd = state.get("community_data") or {}
    reports = [r for r in (cd.get("reports") or [])]
    if reports:
        trusted = [r for r in reports if r.get("verified")]
        r0 = (trusted or reports)[0]
        tag = "sensor-verified" if r0.get("verified") else "unverified"
        sections += ["", f"### Community reports ({len(reports)} near, {len(trusted)} verified)",
                     f"“{(r0.get('description') or '')[:160]}” — {tag}, {r0.get('observed_at') or 'recent'}"]

    if len(sections) <= 1:
        # Nothing answered at all — say so plainly instead of shipping a shell.
        sections = [
            f"**Feed brief for {where}**",
            "",
            "I could not reach any live feed just now — the ocean database, weather models and the advisory store all stayed silent, so I have nothing observed to report. Please try again in a few minutes; if this persists the platform's data connections need attention.",
        ]
        return "\n".join(sections)

    drawn = []
    if (g.get("geojson") or {}).get("features"):
        drawn.append("hazard zones in red")
    if (p or {}).get("geojson", {}).get("features"):
        drawn.append("PFZ polygons in green")
    if reports:
        drawn.append("community pins in cyan")
    sections += ["", "🛰️ Map: " + (" and ".join(drawn) + " drawn on the chart." if drawn else "nothing to draw for this question.")]

    feed_errors = state.get("feed_errors") or []
    if feed_errors:
        sections += ["", "⚠️ " + f"{len(feed_errors)} live feed(s) could not be reached just now, so this brief covers only what answered."]

    if partial:
        sections = [partial, "", "---", *sections]
    sections += ["", "_Assembled directly from the platform's live feeds — the AI writer is temporarily unavailable, so no number here is paraphrased._"]
    return "\n".join(sections)


async def synthesize_node(state: AgentState) -> dict:
    """gpt-4o markdown answer; falls back to a live-feed brief when the
    provider is down (quota/outage) so the Monk still answers from real data."""
    map_features = _merge_features(state)
    try:
        response = await chat_markdown(SYNTH_SYS, _context(state))
    except LLMError:
        response = _fallback_answer(state)
    # Trimmed payload: the big geojson blobs are already merged into
    # map_features, so drop the per-worker duplicates from the state.
    return {"response": response, "map_features": map_features}


async def synthesize_stream_node(state: AgentState):
    """Streaming twin of synthesize_node for SSE.

    Yields ('__token__', str) chunks as the LLM generates, then a final
    ('result', dict) state update. If the provider fails mid-run the answer
    is completed from the live-feed brief instead of leaving the user with
    a dead stream.
    """
    map_features = _merge_features(state)
    response = ""
    try:
        async for token in chat_markdown_stream(SYNTH_SYS, _context(state)):
            response += token
            yield ("__token__", token)
    except LLMError:
        # Provider down (quota exhausted / outage): complete the answer from
        # the feeds already gathered — never a fabricated report, only real
        # observed/model values, and the brief says where it came from.
        brief = _fallback_answer(state)
        tail = brief.split("\n\n---\n", 1)[-1]
        if response:
            separator = "\n\n---\n"
            yield ("__token__", separator + tail)
            response = response + separator + tail
        else:
            yield ("__token__", brief)
            response = brief
    yield "result", {"response": response, "map_features": map_features}


# ---------------------------------------------------------------- streaming

_STREAM_NODE_MAP = {
    "weather": weather_node,
    "weather_lenient": weather_node_lenient,
    "geospatial": geospatial_node,
    "pfz": pfz_node,
    "advisory": advisory_node,
    "community": community_node,
}


def _status(stage: str, **extra) -> tuple[str, dict]:
    return "status", {"stage": stage, "label": STATUS_LABELS.get(stage, stage), **extra}


async def run_chat_stream(message: str) -> AsyncIterator[tuple[str, dict | str]]:
    """SSE-friendly orchestration mirroring the LangGraph DAG (same nodes).

    Yields ("status", {...}) milestones with human-readable labels,
    ("token", str) synthesis tokens as they are generated, and finally
    ("final", {...}) with the complete trimmed result — including the
    out-of-band `confidence` payload that must never enter the token stream.
    """
    state: AgentState = {"message": message}

    state.update(await router_node(state))
    yield _status("routed", intent=state.get("intent"))

    tasks = TASK_MAP.get(state.get("intent"), ["advisory"])
    payload = {k: state.get(k) for k in ("message", "intent", "coordinates")}

    async def _run(name: str):
        return name, await _STREAM_NODE_MAP[name](payload)

    # One dead feed must not kill the answer: record the failure and answer
    # from whichever feeds did respond (or say plainly that none did).
    feed_errors: list[str] = []
    for coro in asyncio.as_completed([_run(t) for t in tasks]):
        try:
            name, delta = await coro
        except Exception as exc:  # WeatherUnavailable, DB down, timeout…
            feed_errors.append(f"{type(exc).__name__}: {exc}")
            continue
        state.update(delta)
        yield _status(name)
    state["feed_errors"] = feed_errors

    # Verification matrix + confidence scoring (out-of-band of the tokens).
    yield _status("verifying")
    state.update(await verify_node(state))

    yield _status("synthesizing")
    async for kind, chunk in synthesize_stream_node(state):
        if kind == "__token__":
            yield "token", chunk
        else:
            state.update(chunk)

    cd = state.get("community_data") or {}
    yield "final", {
        "response": state.get("response", ""),
        "map_features": state.get("map_features")
        or {"type": "FeatureCollection", "features": []},
        "intent": state.get("intent") or "general_advisory",
        "coordinates": state.get("coordinates"),
        "confidence": state.get("confidence"),
        "community": {
            "count": len(cd.get("reports") or []),
            "verified_count": cd.get("verified_count", 0),
        },
    }

# ---------------------------------------------------------------- graph
def build_graph():
    g = StateGraph(AgentState)
    g.add_node("router", router_node)
    g.add_node("weather_node", weather_node)
    g.add_node("geospatial_node", geospatial_node)
    g.add_node("pfz_node", pfz_node)
    g.add_node("advisory_node", advisory_node)
    g.add_node("community_node", community_node)
    g.add_node("verify", verify_node)
    g.add_node("synthesize", synthesize_node)

    g.add_edge(START, "router")
    # router -> parallel workers (Send fan-out); workers rejoin at verify
    g.add_conditional_edges(
        "router", route_workers,
        ["weather_node", "geospatial_node", "pfz_node", "advisory_node", "community_node"],
    )
    for w in ("weather_node", "geospatial_node", "pfz_node", "advisory_node", "community_node"):
        g.add_edge(w, "verify")
    g.add_edge("verify", "synthesize")
    g.add_edge("synthesize", END)
    return g.compile()


graph = build_graph()
