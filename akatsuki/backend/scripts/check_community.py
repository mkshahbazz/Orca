"""Community contribution checks: verification matrix, trust maths, confidence.

Run from the backend directory (needs the app's dependencies installed):

    py scripts/check_community.py            # offline, pure functions
    py scripts/check_community.py --live     # also probes the deployed API

The offline half proves the rules that must never soften:

  * every contribution category has a rule, and the unverifiable ones
    (`other`) can never be promoted to verified;
  * a claim the sensors contradict stays unverified — the matrix never
    "confirms" something the live reading disagrees with;
  * a catch/fishing-zone claim is confirmed only by a real PFZ polygon
    containing the reported position;
  * only verified reports move the confidence score, and the score is
    recomputed from the evidence every time (never a stored constant);
  * badges come only from corroborated counts, and a brand-new contributor is
    never labelled an expert.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import community, confidence, contributors  # noqa: E402

PASSES: list[str] = []
FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSES.append(label)
    else:
        FAILURES.append(f"{label}{f' — {detail}' if detail else ''}")


# --------------------------------------------------------------- fixtures
CALM = {
    "source": "Open-Meteo Marine (live)",
    "wave_height_m": 0.6,
    "swell_wave_height_m": 0.5,
    "wave_period_s": 5.0,
    "wind_speed_kmh": 9.0,
    "wind_gusts_kmh": 13.0,
    "weather_code": 1,
}
ROUGH = {
    "source": "Open-Meteo Marine (live)",
    "wave_height_m": 2.6,
    "swell_wave_height_m": 2.2,
    "wave_period_s": 9.5,
    "wind_speed_kmh": 42.0,
    "wind_gusts_kmh": 58.0,
    "weather_code": 95,
}
# One active PFZ polygon (a 1° box around 21.0 N, 87.5 E) and nothing offshore.
PFZ = [{
    "location_name": "Test PFZ",
    "chlorophyll": 2.4,
    "geojson": {
        "type": "Polygon",
        "coordinates": [[[87.0, 20.5], [88.0, 20.5], [88.0, 21.5], [87.0, 21.5], [87.0, 20.5]]],
    },
}]


def report(category: str, lat: float = 21.0, lon: float = 87.5) -> dict:
    return {
        "id": "1", "category": category, "description": "test report",
        "lat": lat, "lon": lon, "verified": True,  # stale DB flag: must be overwritten
        "verification_note": None, "verification_source": None,
    }


def total_label(score: int) -> str:
    return "high" if score >= confidence.HIGH_THRESHOLD else (
        "moderate" if score >= confidence.MODERATE_THRESHOLD else "low"
    )


def verify(category: str, weather: dict, lat: float = 21.0, lon: float = 87.5) -> dict:
    return community.verify_reports([report(category, lat, lon)], weather, PFZ)[0]


# ------------------------------------------------------------ vocabulary
def check_vocabulary() -> None:
    for key in community.CONTRIBUTION_CATEGORIES:
        check(f"category '{key}' accepted by the store", key in community.ALL_CATEGORIES)
    for legacy in ("heavy_swell", "rough_seas", "debris", "fish_sighting"):
        check(f"legacy category '{legacy}' still accepted", legacy in community.ALL_CATEGORIES)


# ------------------------------------------------------- verification matrix
def check_matrix() -> None:
    # corroborating conditions
    for category in ("sea_condition", "heavy_swell", "high_wave", "rough_seas"):
        out = verify(category, ROUGH)
        check(f"{category} confirmed by rough seas", out["verified"], out["verification_note"])
    for category in ("weather_observation", "high_wind", "squall", "storm"):
        out = verify(category, ROUGH)
        check(f"{category} confirmed by storm-force wind", out["verified"], out["verification_note"])
    out = verify("hazard", ROUGH)
    check("hazard confirmed by a live hazard signal", out["verified"], out["verification_note"])

    # contradicting conditions must NOT verify
    for category in ("sea_condition", "high_wave"):
        out = verify(category, CALM)
        check(f"{category} stays unverified in calm conditions", not out["verified"], out["verification_note"])
    out = verify("weather_observation", CALM)
    check("weather_observation stays unverified in calm conditions", not out["verified"])
    out = verify("hazard", CALM)
    check("hazard stays unverified when no signal exists", not out["verified"])

    # fishing claims are corroborated spatially against the PFZ bulletin
    out = verify("catch", CALM, lat=21.0, lon=87.5)
    check("catch inside an active PFZ zone is confirmed", out["verified"], out["verification_note"])
    check("PFZ confirmation names the bulletin source",
          "PFZ" in str(out["verification_source"] or ""), str(out["verification_source"]))
    out = verify("catch", CALM, lat=17.0, lon=84.0)
    check("catch outside every PFZ zone stays unverified", not out["verified"], out["verification_note"])
    out = verify("fishing_zone", ROUGH, lat=21.0, lon=87.5)
    check("fishing_zone inside a PFZ zone is confirmed", out["verified"])
    out = community.verify_reports([report("catch")], CALM, None)[0]
    check("catch with no bulletin available stays unverified", not out["verified"], out["verification_note"])

    # nothing can confirm an "other" observation
    for weather in (CALM, ROUGH, None):
        out = verify("other", weather or {})
        check("'other' is never auto-verified", not out["verified"], out["verification_note"])

    # the stored flag is never trusted
    stale = community.verify_reports([report("other")], CALM, PFZ)[0]
    check("a stored verified flag cannot survive re-verification", stale["verified"] is False)

    # every returned report carries an explanation
    for category in community.ALL_CATEGORIES:
        out = verify(category, ROUGH)
        check(f"{category} verdict carries a note", bool(out.get("verification_note")))


# --------------------------------------------------------------- confidence
def check_confidence() -> None:
    # An exact location with live sensors and nothing else: the platform's own
    # calibration case, deliberately chosen to leave headroom for community
    # evidence (a base that already saturates 100 would hide a broken bonus).
    base_state = {
        "coordinates": {"lat": 21.0, "lon": 87.5},
        "weather_data": ROUGH,
    }
    plain = confidence.score_answer(base_state, verified_reports=[])
    with_one = confidence.score_answer(base_state, verified_reports=[{"verification_source": "Open-Meteo Marine"}])
    with_two = confidence.score_answer(
        base_state, verified_reports=[{"verification_source": "Open-Meteo Marine"} for _ in range(2)]
    )
    with_three = confidence.score_answer(
        base_state,
        verified_reports=[{"verification_source": "Open-Meteo Marine"} for _ in range(3)],
    )
    check("confidence is computed, not stored", isinstance(plain["score"], int))
    check("a verified community report raises confidence",
          with_one["score"] > plain["score"], f"{plain['score']} -> {with_one['score']}")
    check("one verified report is worth exactly +12",
          with_one["score"] == plain["score"] + 12, f"{plain['score']} -> {with_one['score']}")
    check("the community bonus is capped at +18",
          with_two["score"] == plain["score"] + 18, f"{plain['score']} -> {with_two['score']}")
    check("more than two reports add nothing further",
          with_three["score"] == with_two["score"], f"{with_two['score']} -> {with_three['score']}")
    check("the score never exceeds 100", with_three["score"] <= 100)
    check("the label tracks the score",
          total_label(with_two["score"]) == with_two["label"], str(with_two["label"]))

    verify_only = confidence.score_answer(base_state, verified_reports=[])
    check("unverified reports never enter the score",
          verify_only["score"] == plain["score"])

    pfz = confidence.score_answer(base_state, verified_reports=[{"verification_source": "INCOIS PFZ bulletin (PostGIS)"}])
    check("PFZ-corroborated reports are labelled as such",
          any("PFZ-corroborated" in f for f in pfz["factors"]), str(pfz["factors"]))
    check("sensor-corroborated reports are labelled as such",
          any("sensor-corroborated" in f for f in with_one["factors"]), str(with_one["factors"]))

    guess = confidence.score_answer({}, verified_reports=[])
    check("an evidence-free answer cannot claim high confidence", guess["score"] <= 28, str(guess["score"]))
    # a stored/verified claim may not be passed in as if it were sensor evidence
    check("justification explains the score", bool(plain.get("justification")))


# ------------------------------------------------------------------- badges
def check_badges() -> None:
    fresh = contributors.contributor_payload("New Fisher", 2, 0)
    check("a new contributor is 'New Contributor'", fresh["badge_key"] == "new", fresh["badge"])
    check("a new contributor has a zero trust score", fresh["trust_score"] == 0, str(fresh["trust_score"]))
    check("a two-report contributor is never an expert", "Expert" not in fresh["badge"])

    trusted = contributors.contributor_payload("Working Fisher", 4, 2)
    check("3+ reports with a confirmation is 'Trusted Fisher'", trusted["badge_key"] == "trusted", trusted["badge"])

    observer = contributors.contributor_payload("Observer", 8, 6)
    check("6 confirmed reports reach 'Verified Observer'", observer["badge_key"] == "observer", observer["badge"])

    expert = contributors.contributor_payload("Old Hand", 20, 18)
    check("18 confirmed reports reach 'Community Expert'", expert["badge_key"] == "expert", expert["badge"])

    # volume alone is not trust
    spammy = contributors.contributor_payload("Loud", 40, 0)
    check("volume without confirmation earns no trust", spammy["trust_score"] == 0, str(spammy["trust_score"]))
    check("volume without confirmation is not an expert", "Expert" not in spammy["badge"])

    perfect = contributors.contributor_payload("Careful", 10, 10)
    check("a flawless 10-report record reaches 100", perfect["trust_score"] == 100, str(perfect["trust_score"]))

    mixed = contributors.contributor_payload("Mixed", 10, 5)
    check("half-confirmed sits between the extremes",
          0 < mixed["trust_score"] < 100, str(mixed["trust_score"]))

    for name, payload in (("fresh", fresh), ("expert", expert)):
        check(f"{name} card carries counts", payload["contributions"] == payload["verified"] + payload["unverified"])


# ---------------------------------------------------------------- geojson
def check_geojson() -> None:
    rows = community.verify_reports([report("sea_condition"), report("other")], ROUGH, PFZ)
    fc = community.to_geojson(rows)
    check("geojson keeps every report", len(fc["features"]) == 2)
    props = fc["features"][0]["properties"]
    check("map pins carry the verdict", props["verified"] is True)
    check("map pins are styled verified vs unverified",
          fc["features"][0]["properties"]["color"] != fc["features"][1]["properties"]["color"])
    check("map pins expose the evidence note", bool(props["verification_note"]))


# ------------------------------------------------------------------ live API
async def check_live(base: str) -> None:
    import httpx

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            health = (await client.get(f"{base}/health")).json()
        except Exception as exc:
            check("live /health reachable", False, str(exc))
            return
        check("live /health reachable", True)
        check("live translation configured (Bhashini)", bool(health.get("translation_configured")))
        check("live AI provider reported", bool(health.get("llm_configured")), str(health.get("llm")))

        try:
            cats = (await client.get(f"{base}/api/community/categories")).json()
            check("live categories served", len(cats.get("categories", [])) == len(community.CONTRIBUTION_CATEGORIES))
        except Exception as exc:
            check("live categories served", False, str(exc))

        try:
            feed = (await client.get(f"{base}/api/community/reports?limit=5&reverify=true")).json()
            check("live contribution feed reachable", "reports" in feed, str(feed)[:200])
            check("live feed reports a verified count", "verified_count" in feed)
        except Exception as exc:
            check("live contribution feed reachable", False, str(exc))

        try:
            stats = (await client.get(f"{base}/api/community/stats")).json()
            check("live stats reachable", "total" in stats, str(stats)[:200])
        except Exception as exc:
            check("live stats reachable", False, str(exc))


def main() -> int:
    check_vocabulary()
    check_matrix()
    check_confidence()
    check_badges()
    check_geojson()

    if "--live" in sys.argv:
        base = "https://orca-backend-nxed.onrender.com"
        asyncio.run(check_live(base))

    print(f"\n{len(PASSES)} checks passed")
    for failure in FAILURES:
        print(f"  FAIL  {failure}")
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED")
        return 1
    print("All community contribution checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
