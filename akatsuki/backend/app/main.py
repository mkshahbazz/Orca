"""FastAPI app: /health, /api/chat and /api/chat/stream (SSE).

Streaming: /api/chat/stream emits `status` milestones while the agents work,
then `token` events as the synthesizer LLM generates, then a final trimmed
`final` event — time-to-first-byte collapses to router latency + first token.

Logging: every interaction is written to user_queries fire-and-forget — the
client response never waits on the Supabase round-trip.

The structural skeleton is unchanged: FastAPI orchestrates the LangGraph
agent platform, PostGIS/Supabase storage and the external data services
(Open-Meteo/MOSDAC-style weather, INCOIS PFZ, VEDAS-style advisory RAG).
"""
import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from supabase import create_client

from app.agents import graph, run_chat_stream
from app.config import settings
from app.dashboard import router as dashboard_router
from app.services import bhashini, geospatial, weather

log = logging.getLogger("marine")

_sb = None
if settings.supabase_url and settings.supabase_service_role_key:
    _sb = create_client(settings.supabase_url, settings.supabase_service_role_key)

_background_tasks: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await geospatial.init_pool()
    except Exception as exc:                      # allow /health to report degraded
        log.warning("DB pool init failed: %s", exc)
    await weather.startup()                       # shared httpx client
    yield
    for task in list(_background_tasks):          # don't kill pending logs mid-write
        task.cancel()
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


EMPTY_FC = {"type": "FeatureCollection", "features": []}


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
    return {"status": "ok" if db else "degraded", "database": db,
            "llm_configured": bool(settings.openai_api_key)}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    final: dict = {}
    async for kind, payload in run_chat_stream(req.message):
        if kind == "final":
            final = payload
    answer = final.get("response", "")
    if req.language and req.language != "en":
        answer = await bhashini.translate(answer, "en", req.language)
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
        language=req.language if (req.language and req.language != "en") else "en",
    )


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE: status milestones -> token stream -> trimmed final event."""

    async def event_stream():
        final: dict = {}
        try:
            translated: str | None = None
            async for kind, payload in run_chat_stream(req.message):
                if kind == "final":
                    final = payload
                    answer = payload.get("response", "")
                    if req.language and req.language != "en":
                        answer = await bhashini.translate(answer, "en", req.language)
                        translated = answer
                    # trimmed wire payload — internals (coordinates etc.)
                    # stay server-side; the UI only needs these three keys
                    wire = {
                        "response": answer,
                        "map_features": payload.get("map_features") or EMPTY_FC,
                        "intent": payload.get("intent") or "general_advisory",
                        "language": (req.language or "en") if translated is not None else "en",
                    }
                elif kind == "token":
                    # once translation is known it replaces the streamed English
                    wire = payload if translated is None else ""
                else:
                    wire = payload
                yield f"event: {kind}\ndata: {json.dumps(wire)}\n\n"
        except Exception as exc:
            log.exception("agent stream failed")
            yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"
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
