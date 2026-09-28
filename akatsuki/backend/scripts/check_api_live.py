"""The required behaviours, checked over real HTTP against a running server.

Unlike `check_conversation.py` (which stubs the provider so the pipeline can be
inspected), this one talks to the actual `/api/chat` and `/api/chat/stream`
endpoints, so the wire format, the SSE milestones and the fallback writer are
exercised exactly as a browser would exercise them.

Usage:
    .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000
    .venv/Scripts/python.exe scripts/check_api_live.py [base-url]
"""

import json
import os
import re
import sys
import urllib.request

BASE = (
    sys.argv[1] if len(sys.argv) > 1
    else os.environ.get("SEAMONK_API") or "http://127.0.0.1:8000"
).rstrip("/")
PASS, FAIL = [], []


def chat(message, context=None, history=None):
    body = {"message": message}
    if context:
        body["context"] = context
    if history:
        body["history"] = history
    req = urllib.request.Request(
        BASE + "/api/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode())


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  <- ' + str(detail)}")


def prior(out):
    """The context a client sends back for the next question (ChatContext shape)."""
    loc = out.get("location") or {}
    return {
        "location": loc.get("label"),
        "lat": loc.get("lat"),
        "lon": loc.get("lon"),
        "scope": loc.get("scope"),
        "representative": bool(loc.get("representative")),
    }


def show(tag, out):
    text = " ".join(out["response"].split())
    loc = out.get("location") or {}
    print(f"\n[{tag}] intent={out['intent']} needs_location={out['needs_location']} "
          f"location={loc.get('label')} ({loc.get('lat')},{loc.get('lon')}) scope={loc.get('scope')}")
    print("  " + (text[:420] + ("…" if len(text) > 420 else "")))
    return out


def main():
    print("\n=== REQUIREMENT 1: ordinary conversation ===")
    for msg in ["Hello", "How are you?", "What can you do?"]:
        out = chat(msg)
        show(msg, out)
        check(f"{msg!r} -> conversation intent", out["intent"] == "conversation", out["intent"])
        check(f"{msg!r} -> no marine processing", "Sea state" not in out["response"]
              and "Waves" not in out["response"] and "wind" not in out["response"].lower())

    out = chat("Hi, what is the weather in Chennai?")
    show("Hi, what is the weather in Chennai?", out)
    check("greeting + weather stays a weather request", out["intent"] != "conversation", out["intent"])

    print("\n=== REQUIREMENT 3: locations ===")
    chennai = chat("What is the weather in Chennai?")
    show("Chennai", chennai)
    check("Chennai resolves to Chennai", (chennai.get("location") or {}).get("label", "").lower().startswith("chennai"))

    odisha = chat("What are the weather conditions in Odisha?")
    show("Odisha", odisha)
    check("Odisha is not West Bengal", "bengal" not in (odisha.get("location") or {}).get("label", "").lower()
          and (odisha.get("location") or {}).get("label") == "Odisha")

    kerala = chat("What are the marine conditions in Kerala?")
    show("Kerala", kerala)
    check("Kerala resolves to Kerala", (kerala.get("location") or {}).get("label") == "Kerala")

    bob = chat("What are the marine conditions in the Bay of Bengal?")
    show("Bay of Bengal", bob)
    check("Bay of Bengal handled as a sea", (bob.get("location") or {}).get("scope") == "sea")

    coords = chat("What are the conditions at 16.0, 86.5?")
    show("coordinates", coords)
    loc = coords.get("location") or {}
    check("coordinates used exactly", abs(loc.get("lat", 0) - 16.0) < 0.01 and abs(loc.get("lon", 0) - 86.5) < 0.01, loc)

    ambiguous = chat("What is the weather like?")
    show("ambiguous", ambiguous)
    check("asks for a location instead of guessing", ambiguous["needs_location"] is True,
          ambiguous["needs_location"])

    print("\n=== REQUIREMENT 2: follow-ups ===")
    ctx = prior(chennai)
    wind = chat("Is the wind strong?", context=ctx)
    show("follow-up: wind", wind)
    check("follow-up keeps Chennai", (wind.get("location") or {}).get("label") == "Chennai", wind.get("location"))  # noqa: E501
    check("wind answer is an interpretation, not a field", "wind" in wind["response"].lower())

    explain = chat("Can you explain those conditions?", context=ctx)
    show("follow-up: explain", explain)
    check("explanation keeps Chennai", (explain.get("location") or {}).get("label") == "Chennai")

    tomorrow = chat("What about tomorrow?", context=ctx)
    show("follow-up: tomorrow", tomorrow)
    check("tomorrow keeps Chennai", (tomorrow.get("location") or {}).get("label") == "Chennai")
    check("tomorrow carries day-by-day forecast figures",
          bool(re.search(r"\d{4}-\d{2}-\d{2}", tomorrow["response"]))
          or "Day by day" in tomorrow["response"])

    switch = chat("What about Kerala?", context=ctx)
    show("location change -> Kerala", switch)
    check("location change wins over context", (switch.get("location") or {}).get("label") == "Kerala",
          switch.get("location"))

    marine = chat("What are the marine conditions in Chennai?")
    show("marine Chennai", marine)
    boats = chat("Is it suitable for small boats?", context=prior(marine))
    show("follow-up: small boats", boats)
    check("safety follow-up keeps Chennai", (boats.get("location") or {}).get("label") == "Chennai")
    check("safety follow-up carries a verdict", "small" in boats["response"].lower())

    thanks = chat("Thanks!", context=prior(marine))
    show("Thanks!", thanks)
    check("thanks is conversation, no new report", thanks["intent"] == "conversation"
          and "Sea state" not in thanks["response"], thanks["intent"])

    print("\n=== streaming (SSE) ===")
    req = urllib.request.Request(
        BASE + "/api/chat/stream",
        data=json.dumps({"message": "What is the weather in Kochi?"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    stages = []
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode().strip()
            if line.startswith("event:"):
                stages.append(line[6:].strip())
    print("  stream events:", stages)
    check("stream still emits milestones", len(stages) >= 3, stages)
    check("stream ends with the final payload", stages and stages[-1] == "final", stages[-1] if stages else None)

    print(f"\n{'=' * 60}\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("failed:")
        for name in FAIL:
            print("  -", name)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
