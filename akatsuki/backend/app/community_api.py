"""Community contribution API — the Contribute page's backend.

Everything here reuses what the platform already has:

  * the **existing** `community_reports` table and its PostGIS `location`
    column (no second store, no duplicated schema);
  * the **existing** verification matrix in `services/community.py` — a
    submitted report is cross-checked against live weather/ocean readings and
    the INCOIS PFZ bulletin the moment it lands, and only a corroborated report
    is allowed to raise the confidence of a later answer;
  * the **existing** confidence engine, which already grants +12 per verified
    community report near a queried point;
  * Supabase Storage for photos/video, reached only from the server.

Route map:

    GET    /api/community/categories      vocabulary + badge thresholds
    GET    /api/community/reports         recent (or nearby) reports
    POST   /api/community/reports         file one contribution
    POST   /api/community/reports/{id}/verify   re-run the matrix
    POST   /api/community/media           upload a photo/video
    GET    /api/community/contributors    contributor trust leaderboard
    GET    /api/community/contributors/{name}
    GET    /api/community/stats           headline counts
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.services import community, contributors, storage, weather
from app.services.contributors import contributor_payload

log = logging.getLogger("marine.community_api")

router = APIRouter(prefix="/api/community", tags=["community"])

MAX_DESCRIPTION = 1200
MAX_NAME = 48


# ------------------------------------------------------------------ models
class ReportIn(BaseModel):
    """One fisher contribution. Only category/description/position are required."""

    category: str = Field(..., description="One of /api/community/categories")
    description: str
    lat: float
    lon: float
    reporter_name: str | None = None
    reporter_role: str | None = None
    media_url: str | None = None
    media_type: str | None = None
    observed_at: datetime | None = None


def _clean_name(name: str | None) -> str:
    cleaned = (name or "").strip()[:MAX_NAME]
    return cleaned or "Anonymous"


def _validate(body: ReportIn) -> None:
    if body.category not in community.ALL_CATEGORIES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"“{body.category}” is not a valid report category. Choose one of: "
                + ", ".join(community.CONTRIBUTION_CATEGORIES)
            ),
        )
    text = (body.description or "").strip()
    if len(text) < 5:
        raise HTTPException(
            status_code=422,
            detail="Please describe what you saw in at least a few words (5 characters minimum).",
        )
    if len(text) > MAX_DESCRIPTION:
        raise HTTPException(
            status_code=422,
            detail=f"The description is {len(text)} characters; the limit is {MAX_DESCRIPTION}.",
        )
    if not (-90.0 <= body.lat <= 90.0 and -180.0 <= body.lon <= 180.0):
        raise HTTPException(
            status_code=422,
            detail="The position is outside the valid latitude/longitude range.",
        )
    if body.observed_at:
        ts = body.observed_at
        now = datetime.now(ts.tzinfo) if ts.tzinfo else datetime.now(timezone.utc).replace(tzinfo=None)
        if ts > now + timedelta(hours=6):
            raise HTTPException(
                status_code=422,
                detail="The observation time is in the future — a report has to have happened already.",
            )


# ------------------------------------------------------------- verification
async def _live_reading(lat: float, lon: float) -> dict | None:
    """One live reading, or None when the feed cannot be reached.

    None is not an error here: the matrix then reports the report as
    unverified *because no reading was available*, which is the honest outcome.
    """
    try:
        return await weather.get_marine_conditions(lat, lon)
    except weather.WeatherUnavailable as exc:
        log.warning("no live reading for verification at %s,%s: %s", lat, lon, exc)
        return None


def _point_key(report: dict) -> tuple[float, float] | None:
    try:
        return (round(float(report["lat"]), 2), round(float(report["lon"]), 2))
    except (KeyError, TypeError, ValueError):
        return None


async def _reverify_rows(rows: list[dict]) -> list[dict]:
    """Re-run the matrix for many reports, one live lookup per distinct point.

    Reports are grouped to the nearest 0.01° so a cluster of reports from the
    same fishing ground costs a single weather call, and the groups are fetched
    concurrently. The original order is restored, and a row whose position is
    unusable is returned with its stored verdict rather than dropped.
    """
    keys = [k for k in {_point_key(r) for r in rows} if k]
    readings = dict(zip(keys, await asyncio.gather(*(_live_reading(*k) for k in keys))))

    groups: dict[tuple[float, float] | None, list[dict]] = {}
    for row in rows:
        groups.setdefault(_point_key(row), []).append(row)

    checked: dict[str, dict] = {}
    for key, group in groups.items():
        verdicts = await community.verify_reports_for_point(group, readings.get(key) if key else None)
        for verdict in verdicts:
            checked[str(verdict["id"])] = verdict
    return [checked.get(str(r["id"]), r) for r in rows]


async def _verify_one(report: dict) -> dict:
    """Run the verification matrix for a single freshly stored report.

    A sensor outage leaves the report **unverified** (with the reason attached)
    rather than blocked — a human observation is still worth showing, it simply
    may not raise confidence.
    """
    lat, lon = report.get("lat"), report.get("lon")
    live: dict | None = None
    if lat is not None and lon is not None:
        live = await _live_reading(float(lat), float(lon))
    checked = await community.verify_reports_for_point([report], live)
    verified = checked[0]
    await community.save_verification(
        str(report["id"]),
        bool(verified.get("verified")),
        str(verified.get("verification_note") or ""),
        verified.get("verification_source"),
    )
    return verified


# ------------------------------------------------------------------ routes
@router.get("/categories")
async def categories():
    """The six contribution choices, plus how much the matrix can confirm each."""
    return {
        "categories": [
            {
                "id": key,
                "label": label,
                "verifiable": key not in ("other",),
                "evidence": {
                    "catch": "Active INCOIS PFZ zone at the reported position",
                    "fishing_zone": "Active INCOIS PFZ zone at the reported position",
                    "sea_condition": "Live wave height / swell period for that point",
                    "weather_observation": "Live wind gusts or an active storm cell",
                    "hazard": "Live wave, wind or storm signal for that point",
                    "other": "No independent feed can confirm it — shown as unverified",
                }[key],
            }
            for key, label in community.CONTRIBUTION_CATEGORIES.items()
        ],
        "badges": [
            {
                "key": "new",
                "label": contributors.BADGES["new"],
                "rule": "Submitted reports, none corroborated by sensors yet",
            },
            {
                "key": "trusted",
                "label": contributors.BADGES["trusted"],
                "rule": f"{contributors.TRUSTED_MIN_CONTRIBUTIONS}+ reports with at least "
                        f"{contributors.TRUSTED_MIN_VERIFIED} corroborated",
            },
            {
                "key": "observer",
                "label": contributors.BADGES["observer"],
                "rule": f"{contributors.OBSERVER_MIN_VERIFIED}+ corroborated reports and a "
                        f"trust score of {contributors.OBSERVER_MIN_TRUST}+",
            },
            {
                "key": "expert",
                "label": contributors.BADGES["expert"],
                "rule": f"{contributors.EXPERT_MIN_VERIFIED}+ corroborated reports and a "
                        f"trust score of {contributors.EXPERT_MIN_TRUST}+",
            },
        ],
        "trust_formula": "70% × (verified ÷ contributions) + 30% × min(verified, 10) ÷ 10",
    }


@router.get("/reports")
async def list_reports(
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float = Query(community.DEFAULT_RADIUS_KM, gt=0, le=500),
    max_age_hours: int = Query(community.DEFAULT_MAX_AGE_HOURS, gt=0, le=24 * 365),
    limit: int = Query(40, gt=0, le=100),
    verified_only: bool = False,
    reverify: bool = Query(
        False,
        description="Re-run the verification matrix against live readings for these reports.",
    ),
):
    """Recent contributions, or every contribution near a point.

    `reverify` costs one live weather lookup per distinct location, which is why
    it is opt-in on the map feed (the stored verdict from submission time is
    used there) and on by default for the Contribute page's small window.
    `POST /reports/{id}/verify` re-checks a single report on demand.
    """
    if lat is not None and lon is not None:
        rows = await community.find_nearby_reports(
            lat, lon, radius_km=radius_km, max_age_hours=max_age_hours, limit=limit
        )
    else:
        rows = await community.list_reports(
            limit=limit, verified_only=verified_only, max_age_hours=max_age_hours
        )

    if reverify and rows:
        rows = await _reverify_rows(rows)
        if verified_only:
            rows = [r for r in rows if r.get("verified")]

    return {
        "count": len(rows),
        "verified_count": sum(1 for r in rows if r.get("verified")),
        "reverified": bool(reverify),
        "reports": rows,
        "geojson": community.to_geojson(rows),
    }


@router.post("/reports")
async def create_report(body: ReportIn):
    """File one contribution and verify it immediately."""
    _validate(body)
    name = _clean_name(body.reporter_name)
    try:
        report = await community.insert_report(
            category=body.category,
            description=body.description.strip(),
            lat=body.lat,
            lon=body.lon,
            reporter_name=name,
            reporter_role=(body.reporter_role or "").strip()[:48] or None,
            media_url=body.media_url,
            media_type=body.media_type,
            observed_at=body.observed_at,
        )
    except Exception as exc:
        log.error("failed to store community report: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"The report could not be saved — the spatial database is unavailable. {exc}",
        ) from exc

    try:
        report = await _verify_one(report)
    except Exception as exc:  # the report is stored; verification just failed
        log.warning("verification of report %s failed: %s", report.get("id"), exc)
        report = {
            **report,
            "verified": False,
            "verification_note": f"Stored, but verification could not run: {exc}",
            "verification_source": None,
        }

    trust = await contributors.for_name(name)
    return {
        "report": report,
        "contributor": trust,
        "message": (
            "Report saved and confirmed against live sensor data — thank you, this now "
            "raises confidence for everyone asking about this area."
            if report.get("verified")
            else "Report saved. No live reading could confirm it yet, so it is shown as an "
                 "unverified observation and does not change confidence."
        ),
    }


@router.post("/reports/{report_id}/verify")
async def reverify(report_id: int):
    """Re-run the verification matrix for one stored report (one live lookup)."""
    rows = await community.list_reports(limit=100, max_age_hours=24 * 365)
    match = next((r for r in rows if str(r.get("id")) == str(report_id)), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Report {report_id} was not found.")
    try:
        return {"report": await _verify_one(match)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Verification could not run: {exc}") from exc


@router.post("/media")
async def upload_media(
    file: UploadFile = File(...),
    reporter_name: str | None = Form(None),
):
    """Upload a photo or video clip to Supabase Storage.

    The file is proxied through the API so the service-role key never reaches the
    browser; the response is the public URL to attach to the report.
    """
    data = await file.read()
    log.info("community media upload: %s (%s, %d bytes)", file.filename, file.content_type, len(data))
    try:
        stored = await asyncio.to_thread(
            storage.upload_media, data, file.filename or "upload", file.content_type or ""
        )
    except storage.StorageNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except storage.StorageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {**stored, "reporter_name": _clean_name(reporter_name)}


@router.get("/contributors")
async def contributor_leaderboard(limit: int = Query(25, gt=0, le=100)):
    """Contributors ranked by corroborated observations (never by volume alone)."""
    try:
        return {"contributors": await contributors.leaderboard(limit)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/contributors/{name}")
async def contributor_card(name: str):
    try:
        card = await contributors.for_name(name)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if card is None:
        return {
            "contributor": contributor_payload(_clean_name(name), 0, 0),
            "message": "No contributions filed under this name yet.",
        }
    return {"contributor": card}


@router.get("/stats")
async def stats(max_age_hours: int = Query(24 * 30, gt=0, le=24 * 365)):
    """Headline counts for the Contribute page."""
    try:
        return await community.report_stats(max_age_hours=max_age_hours)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
