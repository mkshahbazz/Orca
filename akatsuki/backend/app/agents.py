"""LangGraph multi-agent DAG.

Flow: START -> router (LLM intent classification)
           -> resolve_location (place name -> coordinates; no gazetteer)
           -> conditional edge returns [Send(...)] -> parallel specialist nodes
           -> verify (community corroboration + confidence scoring)
           -> synthesize (gpt-4o markdown) -> END

No cycles: termination is guaranteed. Each worker writes ONE distinct state key,
so parallel branches never conflict.

Two payloads leave this module and they never touch each other:
  * `response`   — the conversational markdown, streamed token-by-token;
  * `confidence` — the self-assessment (score + one-line justification) which is
    returned as a separate field so it cannot interrupt the typing stream.

Ordinary conversation is a first-class intent (`conversation`). It fans out to
*no* worker at all, so a greeting never touches a weather feed, a spatial query
or the PFZ bulletin — and it is answered by the conversational prompt rather
than a marine brief.

Follow-ups work because the caller may pass the last few turns (`history`) plus
the location resolved last time (`context`). The router sees both, so "is the
wind strong?" after a Chennai answer is understood as Chennai.
"""
import asyncio
import re
from typing import Any, AsyncIterator, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from app.llm import chat_json, chat_markdown, chat_markdown_stream
from app.services import advisory, community, confidence, geospatial, incois, location, weather

# ---------------------------------------------------------------- state
class AgentState(TypedDict, total=False):
    message: str
    intent: str
    # last few turns of the conversation, oldest first: [{role, content}]
    history: list[dict]
    # location carried over from the previous turn of this conversation
    prior_location: dict | None
    # place name the router pulled out of the message
    location_query: str | None
    # the resolved location: {label, display_name, lat, lon, scope, ...}
    location: dict | None
    is_followup: bool
    # a marine question that names no location (or names one we cannot resolve)
    needs_location: bool
    unresolved_location: str | None
    too_broad: bool
    conversation: bool
    coordinates: dict[str, float] | None
    weather_data: dict[str, Any] | None
    geospatial_data: dict[str, Any] | None
    pfz_data: dict[str, Any] | None
    advisory_data: dict[str, Any] | None
    community_data: dict[str, Any] | None
    confidence: dict[str, Any] | None
    map_features: dict[str, Any] | None
    response: str


INTENTS = ("weather", "pfz_search", "hazard_check", "general_advisory", "conversation")

# Intents that cannot be answered without a point on the map. A question in one
# of these with no location gets a clarification question, never a guess.
LOCATION_INTENTS = ("weather", "hazard_check")

# intent -> workers to fan out to. `_tasks_for` prunes the point-dependent ones
# when no location is available. Conversation deliberately maps to nothing.
TASK_MAP = {
    "conversation": [],
    "weather":        ["weather", "community"],
    "pfz_search":     ["pfz", "advisory", "community"],
    "hazard_check":   ["geospatial", "weather", "advisory", "community"],
    "general_advisory": ["advisory"],
}

# Workers that are meaningless without a resolved coordinate.
_POINT_WORKERS = {"weather", "geospatial", "community"}

# Human-readable milestones the UI shows while it waits (live status transparency).
STATUS_LABELS = {
    "routed": "Understanding your question…",
    "locating": "Locating the area you asked about…",
    "chatting": "Thinking…",
    "weather": "Checking weather buoys…",
    "geospatial": "Checking hazard zones…",
    "pfz": "Fetching the PFZ bulletin…",
    "advisory": "Searching safety advisories…",
    "community": "Scanning community reports…",
    "verifying": "Cross-checking human reports against live sensors…",
    "synthesizing": "Writing the answer…",
}

_COORD_RE = re.compile(
    r"(?P<lat>-?\d{1,2}(?:\.\d+)?)\s*[,;\s]+\s*(?P<lon>-?\d{1,3}(?:\.\d+)?)"
)

# ---------------------------------------------------------------- router
ROUTER_SYS = (
    "You are the intent router of THE SEAMONK, a marine intelligence assistant. "
    "Reply with JSON only: "
    '{"intent": "<weather|pfz_search|hazard_check|general_advisory|conversation>", '
    '"location": "<place name or null>", "lat": <number|null>, "lon": <number|null>, '
    '"followup": <true|false>}. '
    "Choose the intent from what the user is actually asking for:\n"
    "- conversation: ordinary talk — greetings, thanks, how are you, who are you, what can you "
    "do, small talk, and general knowledge that is not about the sea at a place (e.g. 'what is "
    "AI?'). Nothing about ocean or weather conditions is being asked for.\n"
    "- weather: conditions, wind, waves, sea state, temperature, rain, storms, visibility, or a "
    "forecast (today/tomorrow) for a place or coordinate.\n"
    "- pfz_search: fishing zones, PFZ, where the fish are, chlorophyll, best fishing area.\n"
    "- hazard_check: is it safe to fish/sail/venture, hazard zones, boundaries, or coordinates "
    "the user wants checked.\n"
    "- general_advisory: marine guidance that names no place and is not a location question "
    "(monsoon advice, regulations, licences, general safety practice).\n"
    "A greeting does NOT make a message conversational: 'Hi, what is the weather in Chennai?' is "
    "a weather request, and 'Hello, is it safe to fish near Odisha today?' is a hazard_check. "
    "Decide from the request inside the message.\n"
    "location: the place the user is asking about, written as a plain place name ('Chennai', "
    "'Kerala', 'Bay of Bengal', 'Digha', 'Kochi'). null when the message names no place of its "
    "own. lat/lon: fill ONLY when the user gives explicit numeric coordinates (e.g. '16.0, 86.5' "
    "or '16N 86.5E'); otherwise null.\n"
    "followup: true when the message only makes sense against the previous turn (e.g. 'is the "
    "wind strong?', 'what about tomorrow?', 'explain that', 'are they dangerous?') and names no "
    "place of its own. false otherwise."
)

# Deterministic keyword sets used ONLY when the router LLM is unreachable, so the
# assistant still classifies sanely instead of treating everything as marine.
# Matching is whole-word (with a small plural/gerund tail), so "sea" cannot
# fire inside "please" and "wind" cannot fire inside "window".
_MARINE_WORDS = (
    "weather", "wave", "swell", "wind", "gust", "sea", "marine", "maritime", "condition",
    "cyclone", "storm", "rain", "temperature", "forecast", "tide", "visibility", "monsoon",
    "cloud", "rough", "calm", "offshore", "coastal", "advisory", "fog", "surf",
)
_PFZ_WORDS = ("pfz", "fishing zone", "fish zone", "fish zones", "chlorophyll", "fish biting", "best fishing", "where are the fish")
# A judgement about going out, rather than a reading of the conditions
_SAFETY_WORDS = ("safe", "safety", "hazard", "danger", "dangerous", "risky", "risk",
                 "venture", "capsize", "warning", "warn", "suitable", "allowed")
# …and the craft/activity a safe-or-not question is about
_CRAFT_WORDS = ("boat", "sail", "trawler", "vessel", "ship", "craft", "fish", "fishing",
                "ferry", "kayak", "yacht", "swim", "swimming", "dive", "diving")
# Cues that a message is about the same place as the previous turn. Deliberately
# narrow: "explain that" alone is ordinary conversation ("explain AI"), while a
# time word or "what about" clearly continues the marine thread.
_FOLLOWUP_WORDS = ("tomorrow", "today", "tonight", "this evening", "next week", "weekend",
                   "later tonight", "what about", "how about", "those", "that forecast",
                   "same area", "same place", "in detail", "more detail")


def _extract_coords(text: str) -> dict[str, float] | None:
    m = _COORD_RE.search(text)
    if m:
        return {"lat": float(m.group("lat")), "lon": float(m.group("lon"))}
    return None


# Words that are never part of a place name here: the question's own scaffolding
# (what/where/is/in/near…), marine vocabulary, and time words. What is left over
# is the user's own place name, and only that is offered to the geocoder.
_STOPWORDS = frozenset("""
about after again all also am an and any are around as ask at back be because been before being
below between both but by can could did do does doing down during each few for from further get
give goes going had has have having here how if in into is it its just kind like me more most much
my near need nice no nor not of off on once only or other our out over own please say see should
show so some such tell than that the their them then there these they this those through to too
under until up us was way we were what when where which while who whom why will with would yes you
your
good morning evening afternoon night hello hey hi namaste thanks thank ok okay great cool right
weather marine maritime sea condition state wave swell wind gust forecast tide temperature rain
storm cyclone monsoon cloud visibility rough calm fog advisory condition conditions safety safe
hazard danger dangerous risky risk suitable allowed boat boats sail sailing fishing fish trawler
vessel ship craft ferry swim swimming dive diving coastal offshore report reports check info
information level current currently latest today tomorrow tonight yesterday soon later""".split())

# Describing words that appear in marine questions ("is the wind strong?", "is it
# suitable for small boats?") and would otherwise be read as a place name.
_STOPWORDS |= frozenset("""
strong weak high low big small large heavy light moderate fresh calm rough fast slow deep shallow
far close explain describe mean means average overall generally mostly really very quite still
even much many few bad better worse best worst warm hot cold wet dry early late quick quickly hard
soft easy hard difficult available possible happen happens change changes expect expected
""".split())

_NON_PLACE_WORD = re.compile(r"^[a-z0-9'\-]{1,2}$")

# The waters this platform serves (Indian coast, Bay of Bengal, Arabian Sea and
# the neighbouring seas). The offline guesser only accepts a name it recognises
# inside this box, so an ordinary word that happens to be some village abroad
# ("Strong", Arkansas) can never be mistaken for the place being asked about.
_OPERATING_AREA = ((-6.0, 32.0), (45.0, 100.0))


def _serves_these_waters(loc: dict) -> bool:
    lat, lon = loc.get("lat"), loc.get("lon")
    if lat is None or lon is None:
        return False
    return (_OPERATING_AREA[0][0] <= lat <= _OPERATING_AREA[0][1]
            and _OPERATING_AREA[1][0] <= lon <= _OPERATING_AREA[1][1])


def _is_that_place(loc: dict, phrase: str) -> bool:
    """The geocoder must have matched the very words the user wrote."""
    first = (loc.get("display_name") or "").split(",")[0].strip().lower()
    return bool(first) and first == phrase.strip().lower()


async def _guess_place(message: str) -> str | None:
    """Read a place out of the user's own words when the router model is down.

    Every phrase the user actually wrote is tried, longest first, and accepted
    only when the geocoder recognises that exact name — so no place is invented
    and no other place is ever substituted for the one that was asked about.
    """
    words = re.findall(r"[A-Za-z][A-Za-z'\-]*", message)
    kept = [i for i, w in enumerate(words) if w.lower() not in _STOPWORDS
            and not _NON_PLACE_WORD.match(w)]
    if not kept:
        return None
    candidates: list[str] = []
    for start in kept:
        for end in reversed(kept):
            if end < start:
                continue
            candidates.append(" ".join(words[start:end + 1]))
    ordered = sorted(dict.fromkeys(candidates), key=lambda c: (-len(c.split()), len(c)))
    for phrase in ordered[:4]:
        try:
            loc = await location.resolve(phrase)
        except Exception:
            return None
        if loc and _is_that_place(loc, phrase) and _serves_these_waters(loc):
            return phrase
    return None


def _last_turns(history: list[dict] | None, limit: int = 6, width: int = 600) -> list[dict]:
    """Trim the conversation to the few recent turns a follow-up needs."""
    out: list[dict] = []
    for turn in (history or [])[-limit:]:
        role = str(turn.get("role") or "")
        content = str(turn.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        out.append({"role": role, "content": content[:width]})
    return out


def _router_input(state: AgentState) -> str:
    """The router sees the previous turns and the location already in play."""
    parts: list[str] = []
    prior = state.get("prior_location") or {}
    if prior.get("location") or prior.get("lat") is not None:
        where = prior.get("location") or f"{prior.get('lat')}, {prior.get('lon')}"
        parts.append(f"Location already established in this conversation: {where}")
    turns = state.get("history") or []
    if turns:
        parts.append("Recent conversation (oldest first):")
        parts += [f"{t['role']}: {t['content']}" for t in turns]
    parts.append(f"New user message: {state['message']}")
    return "\n".join(parts)


def _mentions(text: str, words: tuple[str, ...]) -> bool:
    """Whole-word match with a small plural/gerund tail."""
    for word in words:
        if re.search(rf"(?<![a-z]){re.escape(word)}(?:s|es|ing|ed|y)?(?![a-z])", text):
            return True
    return False


def _heuristic_intent(
    message: str, coords: dict | None, has_prior: bool = False
) -> tuple[str, bool]:
    """Offline classifier used only when the router LLM fails -> (intent, followup).

    It decides only what is being asked. Place names are read from the user's own
    words by `_guess_place`, never mined here and never guessed.
    """
    msg = message.lower()
    if _mentions(msg, _PFZ_WORDS):
        return "pfz_search", True
    if coords is not None:
        return "hazard_check", False
    marine = _mentions(msg, _MARINE_WORDS)
    safety = _mentions(msg, _SAFETY_WORDS)
    craft = _mentions(msg, _CRAFT_WORDS)
    if safety and (marine or craft):
        return "hazard_check", True
    if marine:
        return "weather", True
    if craft:
        return "pfz_search", True
    if has_prior and _mentions(msg, _FOLLOWUP_WORDS):
        # "What about tomorrow?" continues the marine thread of the last answer.
        return "weather", True
    # Nothing marine was asked for: this is ordinary conversation, not a report.
    return "conversation", False


async def router_node(state: AgentState) -> dict:
    """Classify intent, the named place, coordinates and follow-up-ness."""
    coords = _extract_coords(state["message"])
    intent = "conversation"
    location_query: str | None = None
    followup = False
    try:
        out = await chat_json(ROUTER_SYS, _router_input(state))
        if out.get("intent") in INTENTS:
            intent = out["intent"]
        name = out.get("location")
        if isinstance(name, str) and name.strip() and name.strip().lower() not in ("null", "none"):
            location_query = name.strip()
        if out.get("lat") is not None and out.get("lon") is not None:
            try:
                coords = {"lat": float(out["lat"]), "lon": float(out["lon"])}
            except (TypeError, ValueError):
                pass
        followup = bool(out.get("followup"))
    except Exception:
        intent, followup = _heuristic_intent(
            state["message"], coords, bool(state.get("prior_location"))
        )
        # The model is down, so the place is read from the user's own words and
        # accepted only if the geocoder knows that exact name. A message that
        # names no place falls back to the conversation, never to a guess.
        if intent != "conversation":
            location_query = await _guess_place(state["message"])
    return {
        "intent": intent,
        "coordinates": coords,
        "location_query": location_query,
        "is_followup": followup,
    }


# ---------------------------------------------------------------- location
def _clarification(state: AgentState) -> str:
    """Ask for a location instead of inventing one."""
    missing = state.get("unresolved_location")
    if missing and state.get("too_broad"):
        return (
            f"“{missing}” covers a very large area, so one set of readings cannot describe "
            "it. "
            "Which part do you mean? A coastal town or city would work, or coordinates like "
            "16.0, 86.5."
        )
    if missing:
        return (
            f"I could not place “{missing}” on the map, and I will not guess a location for it. "
            "Could you name it a little more precisely — a town or city, or coordinates like "
            "16.0, 86.5?"
        )
    return (
        "Sure — which location would you like the conditions for? You can name a place "
        "(for example Chennai, Kochi, Kerala, Odisha or the Bay of Bengal) or give coordinates "
        "like 16.0, 86.5."
    )


async def resolve_location_node(state: AgentState) -> dict:
    """Turn the user's words into coordinates — or admit there is no location.

    Priority is strict: coordinates the user typed are used as-is; a place name
    the user named is geocoded; only a genuine follow-up may reuse the previous
    turn's location. A name that cannot be resolved is never swapped for
    another place.
    """
    coords = state.get("coordinates")
    if coords:
        loc = location.for_coordinates(float(coords["lat"]), float(coords["lon"]))
        return {"location": loc, "coordinates": {"lat": loc["lat"], "lon": loc["lon"]},
                "is_followup": False, "needs_location": False}

    query = state.get("location_query")
    if query:
        loc = await location.resolve(query)
        if loc and loc.get("too_broad"):
            # A country-sized area cannot be answered with one point: ask which
            # part is meant rather than answering for an arbitrary spot.
            return {"location": None, "coordinates": None, "unresolved_location": loc["label"],
                    "too_broad": True, "needs_location": True}
        if loc:
            return {"location": loc, "coordinates": {"lat": loc["lat"], "lon": loc["lon"]},
                    "needs_location": False}
        return {"location": None, "coordinates": None, "unresolved_location": query,
                "needs_location": state.get("intent") in LOCATION_INTENTS}

    prior = state.get("prior_location")
    if prior and state.get("is_followup"):
        loc = location.from_prior(prior)
        if loc:
            return {"location": loc, "coordinates": {"lat": loc["lat"], "lon": loc["lon"]},
                    "is_followup": True, "needs_location": False}

    if state.get("intent") in LOCATION_INTENTS:
        return {"needs_location": True}
    return {}


async def conversation_node(state: AgentState) -> dict:
    """Ordinary conversation: no feeds are touched, nothing is fetched.

    It exists as a node so the fan-out edge always has somewhere to send the
    state, and it marks the run as conversational for verify/synthesize.
    """
    return {"conversation": True}


# ---------------------------------------------------------------- fan-out
def _tasks_for(state: AgentState) -> list[str]:
    """Which workers this question actually needs (and can run)."""
    intent = state.get("intent")
    if intent == "conversation" or state.get("conversation"):
        return []
    tasks = list(TASK_MAP.get(intent, ["advisory"]))
    if state.get("needs_location") or not state.get("coordinates"):
        # Without a point, only coast-wide sources make sense: the PFZ bulletin
        # and the advisory knowledge base. Weather/hazard/community are skipped
        # rather than run against a default location.
        tasks = [t for t in tasks if t not in _POINT_WORKERS]
    return tasks


def route_workers(state: AgentState) -> list[Send]:
    """Conditional edge: fan out to the workers required by this intent."""
    tasks = _tasks_for(state)
    payload = {
        "message": state["message"],
        "intent": state.get("intent"),
        "coordinates": state.get("coordinates"),
        "location": state.get("location"),
    }
    if not tasks:
        return [Send("conversation_node", payload)]
    node_map = {
        "weather": "weather_node",
        "geospatial": "geospatial_node",
        "pfz": "pfz_node",
        "advisory": "advisory_node",
        "community": "community_node",
    }
    return [Send(node_map[t], payload) for t in tasks]

# ---------------------------------------------------------------- workers
async def weather_node(state: AgentState) -> dict:
    c = state.get("coordinates") or {}
    if not c:
        raise weather.WeatherUnavailable(
            "No location was resolved, so there are no conditions to fetch for this question."
        )
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
    """The INCOIS bulletin as it actually is — an empty bulletin stays empty."""
    return {"pfz_data": await incois.get_pfz_bulletin()}


async def advisory_node(state: AgentState) -> dict:
    """Knowledge-base matches. A failing vector search fails the run honestly."""
    matches = await advisory.match_advisories(state["message"])
    return {"advisory_data": {"matches": matches}}


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
    lift the final confidence score. Ordinary conversation gathers no evidence,
    so it carries no confidence badge at all.
    """
    if state.get("conversation"):
        return {"confidence": None}
    cd = state.get("community_data") or {}
    reports = community.verify_reports(cd.get("reports") or [], state.get("weather_data"))
    verified = [r for r in reports if r.get("verified")]
    scored = confidence.score_answer(state, verified_reports=verified)
    return {
        "community_data": {**cd, "reports": reports, "verified_count": len(verified)},
        "confidence": scored,
    }

# ---------------------------------------------------------------- synthesizer
CONVERSATION_SYS = (
    "You are THE SEAMONK, a calm, warm marine-intelligence assistant. This message is ordinary "
    "conversation or a general knowledge question — it is NOT a request for sea conditions, and "
    "no marine data was fetched for it. Reply naturally in 1–3 short sentences, in plain English, "
    "in markdown. Be personable and brief: greet back, answer the question, thank them, that kind "
    "of thing. Never invent weather, sea state, hazards or statistics, and never volunteer marine "
    "conditions the user did not ask about. If the user asks what you can do or who you are, say "
    "you are the Seamonk, the assistant of THE SEAMONK maritime intelligence platform, and that "
    "you can help with live marine weather and sea state for any place or coordinate, fishing "
    "zones (PFZ), hazard-zone checks for a position, voyage-safety advisories, fisher community "
    "reports, and the map/analytics console. Do not add a map line or a confidence note."
)

MARINE_SYS = (
    "You are THE SEAMONK, a marine-safety assistant talking with fishers, boat operators and "
    "coastal users. The evidence below was fetched for this question. Write the answer in "
    "markdown, in plain everyday English.\n"
    "Rules:\n"
    "- Answer the question that was actually asked, and keep the answer proportional: a one-line "
    "question gets one or two sentences; 'explain the conditions' or 'detailed conditions' can be "
    "a short paragraph with a few bullets.\n"
    "- Interpret the readings, do not list them. Say what the numbers MEAN for someone on the "
    "water — how rough, how windy, how comfortable, how demanding — instead of restating raw "
    "fields. Combine related readings (wind together with gusts, wave height together with wave "
    "period, air temperature with the sky).\n"
    "- Never dump a block of measurements, and never explain a number with itself.\n"
    "- Follow the question's focus: waves question -> wave and swell conditions; wind question -> "
    "wind and gusts; safety/boat question -> what the sea state means for a small boat; a bare "
    "'weather' question -> the overall picture; a 'what does that mean' question -> explain the "
    "conditions already discussed.\n"
    "- Always make clear which place the readings are for, using the resolved location name. If "
    "the scope says the location is a region or a sea, say plainly that the readings are for the "
    "representative point given and not for the whole area.\n"
    "- This may be a follow-up: keep the location and the topic from the conversation so far "
    "unless the user changed them; if the user names a new place, the answer is for that new "
    "place.\n"
    "- Stay honest and cautious. Never call conditions completely safe; give a safety verdict only "
    "from the sea-state evidence given. Do not invent causes (a cyclone, a front, a warning) that "
    "the data does not show. If a dataset is missing for this location, say so instead of "
    "inventing it, and treat each dataset independently.\n"
    "- If the evidence contains a hazard-zone hit, lead with a prominent ⚠️ warning and a strict "
    "do-not-venture recommendation.\n"
    "- Under about 170 words. Cite sources briefly (Open-Meteo, INCOIS, PostGIS hazard database, "
    "advisory knowledge base) where you use them.\n"
    "- End with a single short '🛰️ Map' line ONLY if the map actually shows something (hazard "
    "polygons, PFZ zones or community pins)."
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


def _num(value, digits: int = 3) -> str:
    return f"{value:.{digits}f}" if isinstance(value, (int, float)) else "?"


def _location_lines(state: AgentState) -> list[str]:
    """How the answer should describe where its readings come from."""
    loc = state.get("location")
    if not loc:
        return ["Location: none resolved for this question."]
    parts = [f"Location: {loc.get('display_name') or loc.get('label')} "
             f"(lat={loc.get('lat')}, lon={loc.get('lon')})",
             f"Location scope: {loc.get('scope')}",
             f"Coordinates were obtained from: {loc.get('source')}"]
    if loc.get("representative"):
        parts.append(
            "IMPORTANT: the coordinates above are a representative point for that larger area "
            "(a water point inside it), NOT the area's centre — say so in the answer."
        )
    if loc.get("scope") == "sea":
        parts.append(
            "IMPORTANT: a sea/bay is a large area; these readings describe the queried point in "
            "it, not the entire water body — do not claim they cover all of it."
        )
    if loc.get("scope") == "region":
        parts.append(
            "IMPORTANT: a region is far larger than one point; say the readings are for the "
            "representative water point above and do not imply they cover the whole region."
        )
    return parts


def _history_lines(state: AgentState) -> list[str]:
    turns = state.get("history") or []
    if not turns:
        return []
    return ["Conversation so far (oldest first):"] + [
        f"{t['role']}: {t['content']}" for t in turns
    ]


def _context(state: AgentState) -> str:
    """Everything the writer is allowed to use, labelled, with availability."""
    parts = [
        f"User's question: {state['message']}",
        f"Intent: {state.get('intent')}",
        f"Is this a follow-up to the previous turn: {'yes' if state.get('is_followup') else 'no'}",
        *_location_lines(state),
        *_history_lines(state),
    ]

    w = state.get("weather_data")
    if w:
        parts.append(
            "WEATHER (Open-Meteo, live): " + ", ".join(
                f"{k}={v}" for k, v in w.items() if k != "forecast_days"
            )
        )
        days = w.get("forecast_days") or []
        if days:
            parts.append("DAY BY DAY (today and the next two days):")
            for d in days:
                fields = ", ".join(f"{k}={v}" for k, v in d.items() if v is not None)
                parts.append(f"  - {fields}")
    else:
        parts.append("WEATHER: no live weather/sea-state reading is available for this question.")

    g = state.get("geospatial_data") or {}
    if g.get("checked"):
        zones = g.get("zones") or []
        if zones:
            parts.append("HAZARD CHECK (PostGIS): HIT -> " + str(zones))
        else:
            parts.append(
                "HAZARD CHECK (PostGIS): no recorded hazard zone contains this exact point. "
                "This only means nothing is recorded here — it does not prove the area is "
                "hazard-free."
            )
    else:
        parts.append("HAZARD CHECK: not performed for this question (no location checked).")

    p = state.get("pfz_data")
    if p:
        feats = (p.get("geojson") or {}).get("features") or []
        names = [f["properties"].get("location_name") for f in feats]
        parts.append(f"PFZ (INCOIS bulletin, {p.get('zone_count', len(feats))} active zones): {names}")
    else:
        parts.append("PFZ: no PFZ bulletin data was retrieved for this question.")

    a = state.get("advisory_data") or {}
    advisory_lines = []
    for m in (a.get("matches") or [])[:2]:
        if m.get("title"):
            advisory_lines.append(
                f"ADVISORY [{m.get('category')}] {m.get('title')}: {(m.get('content') or '')[:400]}"
            )
    parts.append("\n".join(advisory_lines) if advisory_lines
                 else "ADVISORY: nothing relevant found in the advisory knowledge base.")

    cd = state.get("community_data") or {}
    if cd.get("searched"):
        reports = cd.get("reports") or []
        if reports:
            parts.append(f"COMMUNITY REPORTS near the point ({len(reports)} found):")
            for r in reports[:4]:
                trust = "VERIFIED against live sensors" if r.get("verified") else "UNVERIFIED"
                parts.append(
                    f"  - {trust} [{r.get('category')}] at {_num(r.get('lat'))},{_num(r.get('lon'))} "
                    f"on {r.get('observed_at')}: {r.get('description')} — {r.get('verification_note')}"
                )
        else:
            parts.append("COMMUNITY REPORTS: none reported near this point in the last 72 hours.")
    else:
        parts.append("COMMUNITY REPORTS: not searched (no location for this question).")

    conf = state.get("confidence")
    if conf:
        parts.append(
            f"CONFIDENCE (assigned by the platform, shown beside the answer): "
            f"{conf.get('score')}% {conf.get('label')} — factors: {', '.join(conf.get('factors') or [])}"
        )
    return "\n".join(parts)


def _conversation_context(state: AgentState) -> str:
    lines = [f"User's message: {state['message']}"]
    turns = _history_lines(state)
    if turns:
        lines += ["", *turns]
    lines += [
        "",
        "This is ordinary conversation — no marine data was fetched, and none may be invented.",
        "The platform's capabilities (mention only what fits the question): live marine weather "
        "and sea state for any place or coordinates; PFZ fishing-zone advisories; hazard-zone "
        "checks for a position; voyage-safety advisories; verified fisher community reports; and "
        "a map/analytics console with confidence-scored answers in twelve Indian languages.",
    ]
    return "\n".join(lines)


def _prompt_for(state: AgentState) -> tuple[str, str]:
    if state.get("conversation"):
        return CONVERSATION_SYS, _conversation_context(state)
    return MARINE_SYS, _context(state)


async def synthesize_node(state: AgentState) -> dict:
    """gpt-4o natural-language answer. Provider failures propagate — never faked."""
    if state.get("needs_location"):
        return {"response": _clarification(state), "map_features": None}
    map_features = _merge_features(state)
    system, user = _prompt_for(state)
    response = await chat_markdown(system, user)
    # Trimmed payload: the big geojson blobs are already merged into
    # map_features, so drop the per-worker duplicates from the state.
    return {"response": response, "map_features": map_features}


async def synthesize_stream_node(state: AgentState):
    """Streaming twin of synthesize_node for SSE.

    Yields ('__token__', str) chunks as the LLM generates, then a final
    ('result', dict) state update. Provider failures propagate to the API
    layer and reach the user as an honest error — never a canned report.
    """
    if state.get("needs_location"):
        response = _clarification(state)
        yield ("__token__", response)
        yield "result", {"response": response, "map_features": None}
        return

    map_features = _merge_features(state)
    system, user = _prompt_for(state)
    response = ""
    async for token in chat_markdown_stream(system, user):
        response += token
        yield ("__token__", token)
    yield "result", {"response": response, "map_features": map_features}


# ---------------------------------------------------------------- streaming

_STREAM_NODE_MAP = {
    "weather": weather_node,
    "geospatial": geospatial_node,
    "pfz": pfz_node,
    "advisory": advisory_node,
    "community": community_node,
}


def _status(stage: str, **extra) -> tuple[str, dict]:
    return "status", {"stage": stage, "label": STATUS_LABELS.get(stage, stage), **extra}


def _prior_from_context(context: dict | None) -> dict | None:
    """Normalise the caller's carried-over location into a `prior_location`."""
    if not context:
        return None
    lat, lon = context.get("lat"), context.get("lon")
    if lat is None or lon is None:
        return None
    try:
        return {
            "location": context.get("location"),
            "lat": float(lat),
            "lon": float(lon),
            "scope": context.get("scope"),
            "representative": bool(context.get("representative")),
        }
    except (TypeError, ValueError):
        return None


def _final_payload(state: AgentState) -> dict:
    cd = state.get("community_data") or {}
    loc = state.get("location") or None
    return {
        "response": state.get("response", ""),
        "map_features": state.get("map_features")
        or {"type": "FeatureCollection", "features": []},
        "intent": state.get("intent") or "general_advisory",
        "coordinates": state.get("coordinates"),
        # the resolved place travels back so the next turn can be a follow-up
        "location": loc,
        "needs_location": bool(state.get("needs_location")),
        "confidence": state.get("confidence"),
        "community": {
            "count": len(cd.get("reports") or []),
            "verified_count": cd.get("verified_count", 0),
        },
    }


async def run_chat_stream(
    message: str,
    history: list[dict] | None = None,
    context: dict | None = None,
) -> AsyncIterator[tuple[str, dict | str]]:
    """SSE-friendly orchestration mirroring the LangGraph DAG (same nodes).

    Yields ("status", {...}) milestones with human-readable labels,
    ("token", str) synthesis tokens as they are generated, and finally
    ("final", {...}) with the complete trimmed result — including the
    out-of-band `confidence` payload that must never enter the token stream.

    `history` (recent turns) and `context` (the location resolved last time) are
    optional and keep follow-up questions grounded; omitting them keeps the
    original single-message behaviour, so existing clients are unaffected.
    """
    state: AgentState = {"message": message, "history": _last_turns(history)}
    prior = _prior_from_context(context)
    if prior:
        state["prior_location"] = prior

    state.update(await router_node(state))
    yield _status("routed", intent=state.get("intent"))

    if state.get("intent") == "conversation":
        # Ordinary conversation: not one feed is touched.
        state.update(await conversation_node(state))
    else:
        yield _status("locating")
        state.update(await resolve_location_node(state))

    tasks = _tasks_for(state)
    payload = {k: state.get(k) for k in ("message", "intent", "coordinates", "location")}

    async def _run(name: str):
        return name, await _STREAM_NODE_MAP[name](payload)

    # A failing worker fails the run: the exception propagates to the API
    # layer, which reports it to the user as an honest operational error.
    for coro in asyncio.as_completed([_run(t) for t in tasks]):
        name, delta = await coro
        state.update(delta)
        yield _status(name)

    if state.get("needs_location"):
        # A marine question with no resolvable location. Answer by asking for
        # one — never by fetching conditions for some other place.
        yield _status("chatting")
        async for kind, chunk in synthesize_stream_node(state):
            if kind == "__token__":
                yield "token", chunk
            else:
                state.update(chunk)
        yield "final", _final_payload(state)
        return

    if not state.get("conversation"):
        # Verification matrix + confidence scoring (out-of-band of the tokens).
        yield _status("verifying")
        state.update(await verify_node(state))
        yield _status("synthesizing")
    else:
        yield _status("chatting")

    async for kind, chunk in synthesize_stream_node(state):
        if kind == "__token__":
            yield "token", chunk
        else:
            state.update(chunk)

    yield "final", _final_payload(state)

# ---------------------------------------------------------------- graph
def build_graph():
    g = StateGraph(AgentState)
    g.add_node("router", router_node)
    g.add_node("resolve_location", resolve_location_node)
    g.add_node("conversation_node", conversation_node)
    g.add_node("weather_node", weather_node)
    g.add_node("geospatial_node", geospatial_node)
    g.add_node("pfz_node", pfz_node)
    g.add_node("advisory_node", advisory_node)
    g.add_node("community_node", community_node)
    g.add_node("verify", verify_node)
    g.add_node("synthesize", synthesize_node)

    g.add_edge(START, "router")
    # router -> location resolution -> parallel workers (Send fan-out) -> verify
    g.add_edge("router", "resolve_location")
    g.add_conditional_edges(
        "resolve_location",
        route_workers,
        ["conversation_node", "weather_node", "geospatial_node", "pfz_node",
         "advisory_node", "community_node"],
    )
    for w in ("conversation_node", "weather_node", "geospatial_node", "pfz_node",
              "advisory_node", "community_node"):
        g.add_edge(w, "verify")
    g.add_edge("verify", "synthesize")
    g.add_edge("synthesize", END)
    return g.compile()


graph = build_graph()
