"""FastAPI app: /health, /api/chat and /api/chat/stream (SSE).

Streaming: /api/chat/stream emits `status` milestones while the agents work,
then `token` events as the synthesizer LLM generates, then a final trimmed
`final` event — time-to-first-byte collapses to router latency + first token.
The `confidence` payload rides in the `final` event only, so it never intrudes
on the token stream the UI renders as a typing effect.

Two-way translation: an inbound regional-language question is translated to
English *before* the agents see it, and the English safety report is translated
back to the user's language before it is shown.

Failure policy: provider/database failures are reported to the UI as a genuine
`error` event. No fake weather report is fabricated anywhere.

Logging: every interaction is written to user_queries fire-and-forget — the
client response never waits on the Supabase round-trip.
"""
import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from supabase import create_client

from app import llm
from app.agents import STATUS_LABELS, run_chat_stream
from app.config import settings
from app.dashboard import router as dashboard_router
from app.services import bhashini, geospatial, weather

log = logging.getLogger("marine")

_sb = None

_background_tasks: set[asyncio.Task] = set()


def _init_supabase() -> bool:
    """Create the Supabase REST client only once credentials are confirmed."""
    global _sb
    if settings.supabase_url and settings.supabase_service_role_key:
        _sb = create_client(settings.supabase_url, settings.supabase_service_role_key)
        return True
    _sb = None
    return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Order matters: environment/secrets are fully loaded by the time the
    # lifespan runs, so every external client is built here — never at import.
    try:
        await geospatial.init_pool()
    except Exception as exc:                      # allow /health to report degraded
        log.warning("DB pool init failed: %s", exc)
    await weather.startup()                       # shared httpx client

    # AI provider: confirm the credential is present before building the client.
    if llm.startup():
        log.info("AI provider client initialised (model=%s)", llm.CHAT_MODEL)
    else:
        log.error("OPENAI_API_KEY is missing — /api/chat will report the AI service as unavailable")

    if _init_supabase():
        log.info("Supabase logging client initialised")
    else:
        log.warning("Supabase logging not configured — query log disabled")

    if not bhashini.is_configured():
        log.warning("Bhashini translation not configured — answers will stay in English")

    yield

    for task in list(_background_tasks):          # don't kill pending logs mid-write
        task.cancel()
    llm.shutdown()
    await weather.shutdown()
    await geospatial.close_pool()


app = FastAPI(title="Marine Geospatial Safety & Fishing Advisory", lifespan=lifespan)
app.include_router(dashboard_router)  # additive read-only dashboard endpoints
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    # Optional Bhashini ISO-639 code (hi/bn/ta/...). "en" (default) returns
    # the answer in English exactly as before — existing clients unaffected.
    language: str | None = None


class ChatResponse(BaseModel):
    response: str
    map_features: dict
    intent: str
    # "en" when no translation was requested; target code otherwise
    language: str = "en"
    # out-of-band self-assessment: {"score", "label", "justification", "factors"}
    confidence: dict | None = None
    community: dict | None = None


EMPTY_FC = {"type": "FeatureCollection", "features": []}


def _target_language(requested: str | None) -> str:
    """Resolve the effective reply language (English when unconfigured)."""
    if not requested or requested == "en" or not bhashini.is_configured():
        return "en"
    return requested


def _translation_notice(requested: str | None) -> str | None:
    """Honest note when a language was asked for but cannot be delivered.

    Returned only when the user explicitly chose a non-English language and
    Bhashini credentials are absent on the server — the answer stays in
    English and says so, rather than silently ignoring the request.
    """
    if (
        requested
        and requested != "en"
        and requested in bhashini.SUPPORTED_LANGUAGES
        and not bhashini.is_configured()
    ):
        name = bhashini.SUPPORTED_LANGUAGES.get(requested, requested)
        return (
            f"_(You asked for {name}. Translation is not configured on this "
            "deployment yet, so this answer is in English.)_"
        )
    return None


def _friendly_error(exc: Exception) -> str:
    """Turn an internal exception into an honest, user-facing explanation."""
    if isinstance(exc, llm.LLMNotConfigured):
        return "The AI service is not configured on the server, so no answer could be generated."
    if isinstance(exc, llm.LLMError):
        return "The AI service is temporarily unavailable (the model request failed). Please try again."
    if isinstance(exc, weather.WeatherUnavailable):
        return f"Live marine weather and sea-state data are temporarily unavailable. {exc}"
    if "DATABASE" in str(exc).upper() or "database_url" in str(exc).lower():
        return "The spatial/hazard database is unavailable, so this answer could not be verified."
    return f"Marine intelligence service error: {exc}"


def sse(event: str, payload) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


def _log_query(payload: dict) -> None:
    """Supabase REST insert (text/jsonb columns only — safe for PostgREST)."""
    if _sb is None:
        return
    try:
        _sb.table("user_queries").insert(payload).execute()
    except Exception as exc:
        log.warning("query log failed: %s", exc)


def _spawn_log_query(payload: dict) -> None:
    """Fire-and-forget logging; tracked so shutdown can cancel cleanly."""
    task = asyncio.create_task(asyncio.to_thread(_log_query, payload))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


@app.get("/health")
async def health():
    try:
        db = await geospatial.ping()
    except Exception:
        db = False
    return {
        "status": "ok" if (db and llm.is_configured()) else "degraded",
        "database": db,
        "llm_configured": llm.is_configured(),
        "translation_configured": bhashini.is_configured(),
        "community_reports": db,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    target = _target_language(req.language)
    message = req.message
    if target != "en":
        message = await bhashini.translate(req.message, target, "en")

    final: dict = {}
    try:
        async for kind, payload in run_chat_stream(message):
            if kind == "final":
                final = payload
    except Exception as exc:
        # No fake report: report the outage as an actual error.
        log.exception("agent run failed")
        raise HTTPException(status_code=503, detail=_friendly_error(exc)) from exc

    answer = final.get("response", "")
    if target != "en":
        answer = await bhashini.translate(answer, "en", target)
    else:
        notice = _translation_notice(req.language)
        if notice:
            answer = f"{answer}\n\n{notice}"

    _spawn_log_query({
        "query_text": req.message,
        "intent": final.get("intent"),
        "coordinates": final.get("coordinates"),
        "response_text": answer,
        "map_features": final.get("map_features"),
    })
    return ChatResponse(
        response=answer,
        map_features=final.get("map_features") or EMPTY_FC,
        intent=final.get("intent") or "general_advisory",
        language=target,
        confidence=final.get("confidence"),
        community=final.get("community"),
    )


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE: status milestones -> token stream -> trimmed final event.

    When a regional language is requested the English tokens are intentionally
    withheld (the UI shows a "Translating…" status instead) and only the
    translated report is delivered, so the user never sees text flip language
    mid-answer.
    """

    async def event_stream():
        final: dict = {}
        target = _target_language(req.language)
        translating = target != "en"
        try:
            message = req.message
            if translating:
                yield sse("status", {
                    "stage": "translating_in",
                    "label": f"Translating question from {bhashini.SUPPORTED_LANGUAGES.get(target, target)}…",
                })
                message = await bhashini.translate(req.message, target, "en")
                yield sse("status", {
                    "stage": "translated_in",
                    "label": STATUS_LABELS["routed"],
                })

            async for kind, payload in run_chat_stream(message):
                if kind == "final":
                    final = payload
                    answer = payload.get("response", "")
                    if translating:
                        yield sse("status", {
                            "stage": "translating_out",
                            "label": f"Translating safety report into "
                                     f"{bhashini.SUPPORTED_LANGUAGES.get(target, target)}…",
                        })
                        answer = await bhashini.translate(answer, "en", target)
                    # trimmed wire payload — internals (coordinates etc.)
                    # stay server-side; the UI only needs these keys
                    if target == "en":
                        notice = _translation_notice(req.language)
                        if notice:
                            answer = f"{answer}\n\n{notice}"
                    yield sse("final", {
                        "response": answer,
                        "map_features": payload.get("map_features") or EMPTY_FC,
                        "intent": payload.get("intent") or "general_advisory",
                        "language": target,
                        # confidence rides out-of-band and never enters the token stream
                        "confidence": payload.get("confidence"),
                        "community": payload.get("community"),
                    })
                elif kind == "token":
                    # never stream English tokens when a translated answer is coming
                    if translating:
                        continue
                    yield sse("token", payload)
                else:
                    yield sse(kind, payload)
        except Exception as exc:
            log.exception("agent stream failed")
            yield sse("error", {"message": _friendly_error(exc), "code": type(exc).__name__})
            return
        _spawn_log_query({
            "query_text": req.message,
            "intent": final.get("intent"),
            "coordinates": final.get("coordinates"),
            "response_text": final.get("response"),
            "map_features": final.get("map_features"),
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
