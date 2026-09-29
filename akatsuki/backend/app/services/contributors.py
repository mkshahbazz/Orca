"""Contributor recognition — trust derived only from verified contributions.

There is no separate reputation store to fall out of sync: every number here is
aggregated from the `community_reports` rows a person actually filed, and the
`verified` flag on those rows was set by the verification matrix (live sensor
or PFZ cross-checks), never by the contributor themselves.

That keeps the badges honest:

    New Contributor      filed reports, nothing corroborated yet
    Trusted Fisher       at least 3 reports, at least 1 sensor-confirmed
    Verified Observer    5+ corroborated reports and a trust score >= 70
    Community Expert     15+ corroborated reports and a trust score >= 85

Nobody can call themselves an expert: the badge is a statement about how many
of their observations the sensors could independently confirm, and nothing else.

Trust score (0-100) blends consistency with volume:

    score = 70 * (verified / contributions) + 30 * min(verified, 10) / 10

so one lucky confirmed report cannot outrank a long, consistent record, and a
100% record still needs ten confirmations to reach 100.
"""
import logging

from app.services import geospatial

log = logging.getLogger("marine.contributors")

BADGES = {
    "expert": "Community Expert",
    "observer": "Verified Observer",
    "trusted": "Trusted Fisher",
    "new": "New Contributor",
}

BADGE_TONE = {
    "expert": "ok",
    "observer": "ok",
    "trusted": "info",
    "new": "info",
}

# Thresholds live in one place so the copy in the UI and the maths here agree.
OBSERVER_MIN_VERIFIED = 5
OBSERVER_MIN_TRUST = 70
EXPERT_MIN_VERIFIED = 15
EXPERT_MIN_TRUST = 85
TRUSTED_MIN_VERIFIED = 1
TRUSTED_MIN_CONTRIBUTIONS = 3


def trust_score(contributions: int, verified: int) -> int:
    """0-100, blending how consistent a contributor is with how often they are right."""
    if contributions <= 0:
        return 0
    consistency = verified / contributions
    volume = min(verified, 10) / 10
    return int(round(70 * consistency + 30 * volume))


def badge_key(contributions: int, verified: int, score: int) -> str:
    """The highest badge this record actually earns."""
    if verified >= EXPERT_MIN_VERIFIED and score >= EXPERT_MIN_TRUST:
        return "expert"
    if verified >= OBSERVER_MIN_VERIFIED and score >= OBSERVER_MIN_TRUST:
        return "observer"
    if verified >= TRUSTED_MIN_VERIFIED and contributions >= TRUSTED_MIN_CONTRIBUTIONS:
        return "trusted"
    return "new"


def contributor_payload(
    name: str, contributions: int, verified: int, last_at=None
) -> dict:
    """One contributor's trust card (pure — no I/O, so it is easy to test)."""
    contributions = int(contributions or 0)
    verified = int(verified or 0)
    score = trust_score(contributions, verified)
    key = badge_key(contributions, verified, score)
    return {
        "name": name,
        "contributions": contributions,
        "verified": verified,
        "unverified": max(0, contributions - verified),
        "trust_score": score,
        "badge": BADGES[key],
        "badge_key": key,
        "badge_tone": BADGE_TONE[key],
        "last_report_at": last_at.isoformat() if hasattr(last_at, "isoformat") else last_at,
    }


_SQL = """
    SELECT COALESCE(NULLIF(BTRIM(reporter_name), ''), 'Anonymous') AS name,
           COUNT(*)::int AS contributions,
           COUNT(*) FILTER (WHERE verified)::int AS verified,
           MAX(observed_at) AS last_at
    FROM community_reports
    WHERE ($1::text IS NULL OR BTRIM(reporter_name) ILIKE $1)
    GROUP BY 1
    ORDER BY verified DESC, contributions DESC, name ASC
    LIMIT $2
"""


async def leaderboard(limit: int = 25) -> list[dict]:
    """Every contributor with their derived counts, newest evidence first."""
    pool = geospatial._pool
    if pool is None:
        raise RuntimeError(
            "The spatial database is unavailable, so contributor records cannot be read."
        )
    async with pool.acquire() as conn:
        rows = await conn.fetch(_SQL, None, max(1, min(limit, 100)))
    return [
        contributor_payload(r["name"], r["contributions"], r["verified"], r["last_at"])
        for r in rows
    ]


async def for_name(name: str) -> dict | None:
    """One contributor's card, or None when they have filed nothing yet."""
    pool = geospatial._pool
    if pool is None:
        raise RuntimeError(
            "The spatial database is unavailable, so contributor records cannot be read."
        )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_SQL, name.strip(), 1)
    if not row:
        return None
    return contributor_payload(row["name"], row["contributions"], row["verified"], row["last_at"])
