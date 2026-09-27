"""Answer-confidence engine.

Produces a self-assessment for every answer the assistant gives:

    {"score": 92, "label": "high", "justification": "...", "factors": [...]}

The result is a *separate* payload from the conversational markdown, so it can
be shipped out-of-band (see the `final` SSE event) and never disturbs the live
token stream rendered in the chat window.

Scoring is a transparent additive model over the evidence actually gathered:

    exact location ............ +15
    live (uncached) weather ... +20
    cached weather ............ +10
    spatial boundary check .... +10
    clear zone / confirmed hazard ... +6
    satellite PFZ data ........ +4
    safety knowledge base ..... +4
    each verified community report ... +12 (capped at +18)

Calibration: the blueprint's headline case — an exact location, live sensor
readings and a confirmed-clear spatial check — totals 86%, i.e. just past the
high threshold, which leaves room for a verified community report (+12) to
visibly raise the score instead of pinning it at 100.

Caps encode the rules the platform promises:
  * high (>=85%) only with a real location, live sensors and a spatial check;
  * cached data or a vague question stays moderate;
  * a guess made with no data at all cannot exceed 28%.
"""

from typing import Any

HIGH_THRESHOLD = 85
MODERATE_THRESHOLD = 60

# floors / ceilings that encode "cached or vague -> never high"
_MAX_WITHOUT_LOCATION = 79
_MAX_WITH_CACHED_ONLY = 80
_MIN_VAGUE_GROUNDED = 62
_MIN_KNOWLEDGE_BASE = 64
_MAX_PURE_GUESS = 28


def _weather_state(weather: dict | None) -> str:
    """'live' | 'cached' | 'none'"""
    if not weather:
        return "none"
    source = str(weather.get("source", "")).lower()
    if "live" not in source:
        return "none"
    return "cached" if weather.get("cached") else "live"


def _knowledge_base_hits(state: dict) -> list[dict]:
    """Advisory rows that actually came back from the vector search."""
    matches = (state.get("advisory_data") or {}).get("matches") or []
    return [m for m in matches if m.get("similarity") is not None]


def score_answer(
    state: dict[str, Any],
    verified_reports: list[dict] | None = None,
) -> dict[str, Any]:
    """Compute the confidence payload for a finished agent state."""
    verified_reports = verified_reports or []

    score = 35
    factors: list[str] = []

    coords = state.get("coordinates")
    if coords:
        score += 15
        factors.append("exact location")
    else:
        factors.append("no explicit location")

    weather_state = _weather_state(state.get("weather_data"))
    if weather_state == "live":
        score += 20
        factors.append("live weather sensors")
    elif weather_state == "cached":
        score += 10
        factors.append("cached weather sensors")

    geo = state.get("geospatial_data") or {}
    geo_checked = bool(geo.get("checked"))
    zones = geo.get("zones") or []
    if geo_checked:
        score += 10
        factors.append("spatial hazard-boundary check")
        if zones:
            score += 6
            factors.append(f"confirmed active hazard ({len(zones)})")
        else:
            score += 6
            factors.append("confirmed clear hazard boundary")

    pfz = state.get("pfz_data") or {}
    if pfz.get("zone_count") and "mock" not in str(pfz.get("source", "")).lower():
        score += 4
        factors.append("satellite-derived PFZ data")

    advisories = _knowledge_base_hits(state)
    if advisories:
        score += 4
        factors.append("safety knowledge base")

    if verified_reports:
        bonus = min(18, 12 * len(verified_reports))
        score += bonus
        factors.append(f"{len(verified_reports)} verified community report(s)")

    # ---- policy caps (applied before floors so thresholds stay honest) ----
    if not coords:
        score = min(score, _MAX_WITHOUT_LOCATION)
    if weather_state == "cached":
        score = min(score, _MAX_WITH_CACHED_ONLY)

    # ---- floors: vague-but-grounded answers are moderate, not useless ----
    if not coords:
        score = max(score, _MIN_VAGUE_GROUNDED)
    if advisories and weather_state != "live":
        score = max(score, _MIN_KNOWLEDGE_BASE)

    # ---- nothing at all: this is a guess and must read as one ----
    if not coords and weather_state == "none" and not geo_checked and not advisories:
        score = min(score, _MAX_PURE_GUESS)

    score = int(max(0, min(100, round(score))))
    label = "high" if score >= HIGH_THRESHOLD else (
        "moderate" if score >= MODERATE_THRESHOLD else "low"
    )

    return {
        "score": score,
        "label": label,
        "justification": _justification(
            label=label,
            coords=bool(coords),
            weather_state=weather_state,
            geo_checked=geo_checked,
            zones=bool(zones),
            advisories=bool(advisories),
            verified=len(verified_reports),
        ),
        "factors": sorted(set(factors)),
    }


def _justification(
    *,
    label: str,
    coords: bool,
    weather_state: str,
    geo_checked: bool,
    zones: bool,
    advisories: bool,
    verified: int,
) -> str:
    """One sentence explaining exactly why this score was assigned."""
    parts: list[str] = []

    if label == "high":
        parts.append("Verified against live weather sensor feeds")
        if geo_checked:
            parts.append("an authoritative spatial hazard-boundary check")
        if verified:
            parts.append(f"{verified} community report(s) corroborated by live sensor data")
        return " and ".join(parts) + "."

    if weather_state == "cached":
        tail = " and authoritative spatial hazard checks" if geo_checked else ""
        corroborated = f", plus {verified} sensor-corroborated community report(s)" if verified else ""
        return (
            "Based on cached weather buoy readings"
            f"{tail}{corroborated} — live feeds could not be re-confirmed for this answer."
        )

    if not coords:
        if advisories and weather_state != "none":
            return (
                "Combines the published safety knowledge base with live sensor readings "
                "for a default area — the question named no specific location."
            )
        if advisories:
            return (
                "General guidance drawn from the published safety knowledge base; "
                "no specific location or live sensor reading was confirmed."
            )
        if weather_state == "live":
            return (
                "Live sensor readings were used, but the question named no specific "
                "location, so this is general guidance rather than a verified position."
            )
        if weather_state == "cached":
            return (
                "Based on cached sensor readings for a default area; the question named "
                "no specific location and live feeds were not re-confirmed."
            )
        return "Little concrete data was available — this is an unverified general answer."

    if verified:
        return (
            f"Located from an explicit position and corroborated by {verified} "
            "community report(s) verified against live sensor data, but full spatial "
            "confirmation was incomplete."
        )

    if zones:
        return "Confidence is limited because verification relied on partial evidence for this location."

    return (
        "Confidence is low because live sensor readings and spatial boundary checks "
        "were unavailable for this location."
    )
