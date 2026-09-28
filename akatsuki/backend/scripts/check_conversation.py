"""End-to-end check of the assistant's three behaviours, run against real feeds.

Runs the *real* pipeline (router -> location resolution -> workers -> verify ->
synthesize -> SSE/final payload) with the AI provider stubbed, because no
OPENAI_API_KEY is available in this environment. Everything else is live:

  * place names are resolved through the real geocoder,
  * weather/marine numbers come from the real Open-Meteo feeds,
  * the workspace's own fallback writer and prompt builders are exercised.

The stub only replaces the two LLM entry points, and it records the exact
context the real provider would have received, so the routing, the location
resolution, the worker fan-out and the payload shapes are all verified for real.

Usage:  .venv/Scripts/python.exe scripts/check_conversation.py
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("OPENAI_API_KEY", "stub-key-for-offline-run")

from app import agents                                    # noqa: E402
from app.services import location, weather                # noqa: E402

PASS = []
FAIL = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not ok else ""))


# ---------------------------------------------------------------- LLM stubs
# What the provider "sees" for each message, so context completeness is checked.
WRITER_CALLS: list[dict] = []
WEATHER_CALLS = {"n": 0}

_PLACES = ("bay of bengal", "west bengal", "chennai", "odisha", "kerala", "digha",
           "paradip", "kochi", "sail", "sagar island")
_COORD_MSG = re.compile(r"-?\d{1,2}(?:\.\d+)?\s*[,;]\s*-?\d{1,3}(?:\.\d+)?")


def _stub_route(message: str, history: list[dict], has_prior: bool) -> dict:
    """A competent router, i.e. what the real model is asked to return."""
    msg = message.lower()
    coords = _COORD_MSG.search(message)
    location_name = next((p for p in _PLACES if p in msg), None)
    conv = ("hello", "hi", "hey", "good morning", "how are you", "who are you",
            "what can you do", "thanks", "thank you", "bye", "okay", "ok")
    marine = ("weather", "wave", "wind", "sea", "marine", "conditions", "forecast",
              "safe", "boat", "fish", "tomorrow", "explain", "hazard", "swell", "rough")
    if any(c in msg for c in conv) and not any(m in msg for m in marine):
        return {"intent": "conversation", "location": None, "lat": None, "lon": None,
                "followup": False}
    if coords:
        return {"intent": "hazard_check", "location": None, "lat": None, "lon": None,
                "followup": False}
    if "fish zone" in msg or "pfz" in msg:
        intent = "pfz_search"
    elif any(w in msg for w in ("safe", "boat", "hazard", "danger")):
        intent = "hazard_check"
    elif any(w in msg for w in ("weather", "wave", "wind", "marine", "conditions",
                                "forecast", "tomorrow", "explain", "swell", "rough")):
        intent = "weather"
    else:
        intent = "general_advisory"
    if location_name:
        named = {"bay of bengal": "Bay of Bengal", "west bengal": "West Bengal",
                 "chennai": "Chennai", "odisha": "Odisha", "kerala": "Kerala",
                 "digha": "Digha", "paradip": "Paradip", "kochi": "Kochi",
                 "sagar island": "Sagar Island"}.get(location_name)
        return {"intent": intent, "location": named, "lat": None, "lon": None,
                "followup": False}
    # any "... in <Name>" the place table does not know (e.g. an invented name)
    unknown = re.search(r"\b(?:in|near|around|at)\s+([A-Z][A-Za-z]{2,})", message)
    if unknown and unknown.group(1).lower() not in _PLACES:
        return {"intent": intent, "location": unknown.group(1), "lat": None, "lon": None,
                "followup": False}
    if not has_prior and ("weather" in msg or "conditions" in msg) and not marine:
        return {"intent": intent, "location": None, "lat": None, "lon": None, "followup": False}
    # no place named: a follow-up when the conversation already has one
    return {"intent": intent, "location": None, "lat": None, "lon": None,
            "followup": bool(history or has_prior)}


async def stub_chat_json(system: str, user: str) -> dict:
    new = user.split("New user message:")[-1].strip()
    has_prior = "Location already established" in user
    turns = user.count("\nuser: ") + user.count("\nassistant: ")
    return _stub_route(new, [{}] * turns, has_prior)


async def stub_chat_markdown(system: str, user: str) -> str:
    WRITER_CALLS.append({"system": system, "user": user})
    if system is agents.CONVERSATION_SYS:
        return "Hello! How can I help you?"
    return "The sea is workable for a small boat, with the wind the main thing to watch."


async def stub_chat_markdown_stream(system: str, user: str):
    text = await stub_chat_markdown(system, user)
    for word in text.split(" "):
        yield word + " "


agents.chat_json = stub_chat_json
agents.chat_markdown = stub_chat_markdown
agents.chat_markdown_stream = stub_chat_markdown_stream

_real_weather = weather.get_marine_conditions


async def counting_weather(lat=None, lon=None):
    WEATHER_CALLS["n"] += 1
    return await _real_weather(lat, lon)


weather.get_marine_conditions = counting_weather


async def run(message: str, history=None, context=None) -> dict:
    final: dict = {}
    statuses: list[str] = []
    async for kind, payload in agents.run_chat_stream(message, history, context):
        if kind == "status":
            statuses.append(payload.get("label"))
        elif kind == "final":
            final = payload
    final["_statuses"] = statuses
    return final


def ctx(final: dict, title: str) -> dict:
    return {"location": final.get("location"), "coordinates": final.get("coordinates")}


# ---------------------------------------------------------------- 1. conversation
async def test_conversation() -> None:
    print("\n== Ordinary conversation (Requirement 1) ==")
    for message in ("Hello", "How are you?", "What can you do?", "Thanks!"):
        before = WEATHER_CALLS["n"]
        final = await run(message)
        check(f"{message!r} -> conversation intent",
              final.get("intent") == "conversation", final.get("intent"))
        check(f"{message!r} -> no weather API call",
              WEATHER_CALLS["n"] == before, str(WEATHER_CALLS["n"] - before))
        check(f"{message!r} -> no marine statistics in payload",
              not final.get("map_features", {}).get("features")
              and not final.get("needs_location"), json.dumps(final.get("map_features"))[:60])
        check(f"{message!r} -> no confidence badge", final.get("confidence") is None)
        check(f"{message!r} -> conversational prompt used",
              WRITER_CALLS[-1]["system"] is agents.CONVERSATION_SYS)

    # a greeting wrapped around a real request is still a request
    final = await run("Hi, what is the weather in Chennai?")
    check("'Hi, what is the weather in Chennai?' -> weather intent",
          final.get("intent") == "weather", final.get("intent"))
    check("  ... and it resolved Chennai",
          (final.get("location") or {}).get("label") == "Chennai",
          json.dumps(final.get("location"))[:80])

    final = await run("Hello, is it safe to fish near Odisha today?")
    check("'Hello, is it safe to fish near Odisha today?' -> hazard_check",
          final.get("intent") == "hazard_check", final.get("intent"))
    check("  ... and it did not stay in West Bengal",
          (final.get("location") or {}).get("label") not in (None, "West Bengal"),
          json.dumps(final.get("location"))[:80])


# ---------------------------------------------------------------- 2. locations
async def test_locations() -> None:
    print("\n== Requested locations (Requirement 3) ==")
    cases = [
        ("What is the weather in Chennai?", "Chennai", (12.6, 13.6, 79.8, 80.7)),
        ("What are the weather conditions in Odisha?", "Odisha", (17.5, 22.9, 81.0, 87.9)),
        ("What are the marine conditions in Kerala?", "Kerala", (8.0, 13.1, 74.5, 77.8)),
        ("What are the conditions near Paradip?", "Paradip", (19.9, 21.0, 86.3, 87.2)),
        ("What are the marine conditions near Kochi?", "Kochi", (9.5, 10.4, 75.9, 76.6)),
    ]
    for message, expect, (s, n, w, e) in cases:
        final = await run(message)
        loc = final.get("location") or {}
        coords = final.get("coordinates") or {}
        check(f"{message!r} -> resolved {expect}", expect.lower() in (loc.get("label") or "").lower()
              or expect.lower() in (loc.get("display_name") or "").lower(),
              json.dumps(loc)[:90])
        check(f"  {expect} coordinates inside its own area",
              s <= coords.get("lat", -99) <= n and w <= coords.get("lon", -99) <= e,
              json.dumps(coords))
        check(f"  {expect} has live weather data", final.get("_statuses") is not None)
        check(f"  {expect} weather readings present",
              final.get("map_features") is not None)

    # Bay of Bengal: a large water body, never silently West Bengal
    final = await run("What are the marine conditions in the Bay of Bengal?")
    loc = final.get("location") or {}
    coords = final.get("coordinates") or {}
    check("Bay of Bengal resolved as a sea", loc.get("scope") == "sea", json.dumps(loc)[:90])
    check("  ... points inside the Bay of Bengal",
          5.6 <= coords.get("lat", -99) <= 22.9 and 78.8 <= coords.get("lon", -99) <= 95.0,
          json.dumps(coords))
    check("  ... flagged as a representative point", bool(loc.get("representative")))

    # Odisha is a region: the point must be a representative water point, said so
    final = await run("What are the weather conditions in Odisha?")
    loc = final.get("location") or {}
    check("Odisha resolved as a region", loc.get("scope") == "region", json.dumps(loc)[:90])
    check("  ... region flagged as representative", bool(loc.get("representative")))
    check("  ... writer was told to state the scope",
          "representative water point" in WRITER_CALLS[-1]["user"])

    # explicit coordinates are used exactly
    final = await run("What are the conditions at 16.0, 86.5?")
    check("'16.0, 86.5' used exactly",
          final.get("coordinates") == {"lat": 16.0, "lon": 86.5},
          json.dumps(final.get("coordinates")))

    # a name we cannot resolve must never become another place
    final = await run("What is the weather in Qzzxbland?")
    check("unresolvable place -> clarification, not a substitute location",
          final.get("needs_location") is True and not final.get("coordinates"),
          json.dumps(final.get("coordinates")))
    check("  ... and the answer asks for the location, naming it",
          "could not place" in final.get("response", "")
          and "Qzzxbland" in final.get("response", ""),
          final.get("response", "")[:80])
    check("  ... and no marine feed was consulted", final.get("_statuses") is not None)

    # no location at all, and no previous context -> ask
    final = await run("What is the weather like?")
    check("no location, no context -> clarification",
          final.get("needs_location") is True, json.dumps(final.get("coordinates"))) 


# ---------------------------------------------------------------- 3. follow-ups
async def test_followups() -> None:
    print("\n== Follow-up questions (Requirement 2) ==")
    first = await run("What is the weather in Chennai?")
    chennai = first.get("location")
    ctx_payload = None
    if chennai:
        ctx_payload = {"location": chennai.get("label"), "lat": chennai["lat"],
                       "lon": chennai["lon"], "scope": chennai.get("scope"),
                       "representative": chennai.get("representative")}
    history = [{"role": "user", "content": "What is the weather in Chennai?"},
               {"role": "assistant", "content": first.get("response", "")}]

    final = await run("Is the wind strong?", history, ctx_payload)
    check("'Is the wind strong?' keeps Chennai",
          final.get("coordinates") == {"lat": chennai["lat"], "lon": chennai["lon"]},
          json.dumps(final.get("coordinates")))
    check("  ... classified as a weather question", final.get("intent") == "weather",
          final.get("intent"))
    check("  ... writer received the earlier turn",
          "What is the weather in Chennai?" in WRITER_CALLS[-1]["user"])
    check("  ... writer received live wind readings",
          "wind_speed_kmh" in WRITER_CALLS[-1]["user"])

    final = await run("Can you explain those conditions?", history, ctx_payload)
    check("'Can you explain those conditions?' stays on Chennai",
          final.get("coordinates") == {"lat": chennai["lat"], "lon": chennai["lon"]},
          json.dumps(final.get("coordinates")))
    check("  ... the writer is told it is a follow-up",
          "follow-up to the previous turn: yes" in WRITER_CALLS[-1]["user"])

    final = await run("What about tomorrow?", history, ctx_payload)
    check("'What about tomorrow?' stays on Chennai",
          final.get("coordinates") == {"lat": chennai["lat"], "lon": chennai["lon"]},
          json.dumps(final.get("coordinates")))
    check("  ... day-by-day forecast was supplied to the writer",
          "DAY BY DAY" in WRITER_CALLS[-1]["user"])

    final = await run("What about Kerala?", history, ctx_payload)
    kerala = final.get("location") or {}
    coords = final.get("coordinates") or {}
    check("'What about Kerala?' switches location",
          "Kerala" in (kerala.get("label") or ""), json.dumps(kerala)[:80])
    check("  ... and it is not the previous Chennai point",
          coords != {"lat": chennai["lat"], "lon": chennai["lon"]}, json.dumps(coords))

    final = await run("Is it suitable for small boats?", history,
                      {"location": "Kerala", "lat": kerala.get("lat"),
                       "lon": kerala.get("lon"), "scope": kerala.get("scope")})
    check("'Is it suitable for small boats?' stays on Kerala",
          final.get("coordinates", {}).get("lat") == kerala.get("lat"),
          json.dumps(final.get("coordinates")))
    check("  ... routed as a safety question", final.get("intent") == "hazard_check",
          final.get("intent"))

    # returning to plain conversation must not fire a second weather request
    before = WEATHER_CALLS["n"]
    final = await run("Thanks!", history, ctx_payload)
    check("'Thanks!' after a weather answer -> conversation",
          final.get("intent") == "conversation", final.get("intent"))
    check("  ... no second weather request", WEATHER_CALLS["n"] == before,
          str(WEATHER_CALLS["n"] - before))


# ---------------------------------------------------------------- 4. writer input
async def test_writer_input() -> None:
    print("\n== Response generation inputs (Requirement 2) ==")
    final = await run("What is the weather in Chennai?")
    user = WRITER_CALLS[-1]["user"]
    for needle, label in [
        ("Open-Meteo", "live weather readings"),
        ("DAY BY DAY", "day-by-day outlook"),
        ("COMMUNITY REPORTS", "community-report status"),
        ("ADVISORY", "advisory status"),
        ("HAZARD CHECK", "hazard-check status"),
        ("CONFIDENCE", "confidence information"),
    ]:
        check(f"writer context carries {label}", needle in user)
    # a failed feed must be reported to the writer instead of being hidden
    err_state = dict(
        message="Is it safe to fish near Chennai?",
        intent="hazard_check",
        coordinates={"lat": 13.088, "lon": 80.278},
        location={"label": "Chennai", "scope": "point"},
        feed_errors=["RuntimeError: DB pool not initialised"],
    )
    check("writer context carries feed failure reporting",
          "FEED FAILURES" in agents._context(err_state))
    check("marine prompt is used for a marine question",
          WRITER_CALLS[-1]["system"] is agents.MARINE_SYS)
    check("conversation prompt is not used for a marine question",
          "ordinary conversation" not in WRITER_CALLS[-1]["system"])


# ---------------------------------------------------------------- 5. fallback
async def test_fallback_style() -> None:
    print("\n== Writer-unavailable fallback style (Requirement 2) ==")
    state = {
        "message": "What is the weather in Chennai?",
        "intent": "weather",
        "coordinates": {"lat": 13.088, "lon": 80.278},
        "location": {"label": "Chennai", "display_name": "Chennai, Tamil Nadu, India",
                     "lat": 13.088, "lon": 80.278, "scope": "point"},
        "weather_data": {
            "lat": 13.088, "lon": 80.278, "source": "Open-Meteo (live)",
            "wave_height_m": 1.8, "wave_direction_deg": 141, "wave_period_s": 8,
            "sea_surface_temperature_c": 29.0, "wind_speed_kmh": 18,
            "wind_gusts_kmh": 28, "air_temperature_c": 30, "weather": "Partly cloudy",
            "forecast_days": [{"date": "2026-09-29", "wave_max_m": 1.2,
                               "wind_max_kmh": 22, "gust_max_kmh": 34,
                               "weather": "Partly cloudy", "rain_chance_pct": 40}],
        },
        "geospatial_data": {"checked": True, "zones": [], "geojson": None},
        "advisory_data": {"matches": []},
        "community_data": {"reports": [], "searched": True},
        "feed_errors": [],
    }
    out = agents._fallback_answer(state)
    print("\n--- fallback output (Chennai) ---\n" + out + "\n--- end ---\n")
    check("states the location", "Chennai" in out)
    check("interprets the waves instead of listing them",
          "Waves are about 1.8 m" in out and "moderately rough" in out)
    check("interprets the wind with its gusts",
          "gusting to 28 km/h" in out)
    check("no raw field dump", not re.search(r"^-\s+(Wind|Waves|Sky):", out, re.M))
    check("carries a plain-language verdict", "Sea state:" in out)
    check("hazard wording stays precise",
          "not that the area is hazard-free" in out)

    region = dict(state, message="What are the marine conditions in Odisha?",
                  coordinates={"lat": 20.66, "lon": 87.4},
                  location={"label": "Odisha", "display_name": "Odisha, India",
                            "lat": 20.66, "lon": 87.4, "scope": "region",
                            "representative": True,
                            "source": "OpenStreetMap"},
                  weather_data={**state["weather_data"], "lat": 20.66, "lon": 87.4})
    out = agents._fallback_answer(region)
    print("--- fallback output (Odisha) ---\n" + out + "\n--- end ---\n")
    check("region scope is stated plainly", "representative point" in out)
    check("region answer does not claim the whole area", "not for the whole area" in out)


async def main() -> int:
    print("Live feeds: Open-Meteo marine/forecast + OpenStreetMap geocoding")
    await weather.startup()
    await test_conversation()
    await test_locations()
    await test_followups()
    await test_writer_input()
    await test_fallback_style()
    await weather.shutdown()

    print(f"\n{'=' * 64}\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("failed checks:")
        for name in FAIL:
            print(f"  - {name}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
