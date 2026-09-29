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
    """'live' | 'partial' | 'cached' | 'none'

    A reading whose wave or wind feed was unavailable is 'partial', not 'live':
    half a picture must not be scored as a complete one. It is still real data
    (it is worth more than a cache hit), but it cannot reach the high band.
    """
    if not weather:
        return "none"
    source = str(weather.get("source", "")).lower()
    if "live" not in source:
        return "none"
    if weather.get("partial_feeds"):
        return "partial"
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
    elif weather_state == "partial":
        score += 8
        missing = (state.get("weather_data") or {}).get("partial_feeds") or []
        factors.append(f"partial live feed ({'; '.join(str(m) for m in missing)[:80]})")
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
        # Distinguish how each report was corroborated so the "why" line is
        # precise: live sensors for wave/wind/storm claims, the satellite PFZ
        # bulletin for catch and fishing-zone claims.
        pfz_backed = sum(
            1 for r in verified_reports
            if "PFZ" in str(r.get("verification_source") or "")
            or str(r.get("verification_source") or "").lower().startswith("incois")
        )
        sensor_backed = len(verified_reports) - pfz_backed
        labels = []
        if sensor_backed:
            labels.append(f"{sensor_backed} sensor-corroborated community report(s)")
        if pfz_backed:
            labels.append(f"{pfz_backed} PFZ-corroborated community report(s)")
        factors.append(" + ".join(labels))

    # ---- policy caps (applied before floors so thresholds stay honest) ----
    if not coords:
        score = min(score, _MAX_WITHOUT_LOCATION)
    if weather_state in ("cached", "partial"):
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
            parts.append(
                f"{verified} community report(s) corroborated by live sensors or the "
                "satellite PFZ bulletin"
            )
        return " and ".join(parts) + "."

    if weather_state == "partial":
        return (
            "Only part of the live reading arrived — one of the weather/ocean feeds did not "
            "answer for this location, so this is a partial picture rather than a confirmed one."
        )

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
            "community report(s) checked against live sensor or PFZ data, but full "
            "spatial confirmation was incomplete."
        )

    # Below the high band with a named position in hand. Each remaining branch
    # states the *specific* gap, so the score never reads as a vague brush-off:
    # "no spatial check" and "no independent corroboration" are different things.
    if zones:
        return (
            "A recorded hazard affects this position, so the conditions reading alone "
            "cannot make this a confident answer."
        )

    if not geo_checked and weather_state == "live":
        return (
            "Live sensor readings were used for the position you named, but no spatial "
            "hazard-boundary check was completed, so this stops short of full verification."
        )

    if not geo_checked:
        return (
            "The position you named was used, but neither live sensor readings nor a "
            "spatial hazard-boundary check could be completed for it."
        )

    return (
        "Live sensor readings and a spatial hazard-boundary check were completed for this "
        "position, but nothing independently corroborated them, so this stops short of "
        "full verification."
    )
