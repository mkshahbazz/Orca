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
from app.services import geospatial, weather

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
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    response: str
    map_features: dict
    intent: str


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
    _spawn_log_query({
        "query_text": req.message,
        "intent": final.get("intent"),
        "coordinates": final.get("coordinates"),
        "response_text": final.get("response"),
        "map_features": final.get("map_features"),
    })
    return ChatResponse(
        response=final.get("response", ""),
        map_features=final.get("map_features") or EMPTY_FC,
        intent=final.get("intent") or "general_advisory",
    )


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE: status milestones -> token stream -> trimmed final event."""

    async def event_stream():
        final: dict = {}
        try:
            async for kind, payload in run_chat_stream(req.message):
                if kind == "final":
                    final = payload
                    # trimmed wire payload — internals (coordinates etc.)
                    # stay server-side; the UI only needs these three keys
                    wire = {
                        "response": payload.get("response", ""),
                        "map_features": payload.get("map_features") or EMPTY_FC,
                        "intent": payload.get("intent") or "general_advisory",
                    }
                elif kind == "token":
                    wire = payload
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
