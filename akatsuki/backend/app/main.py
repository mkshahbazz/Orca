"""FastAPI app: /health + /api/chat, logs every interaction to user_queries."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client

from app.agents import graph
from app.config import settings
from app.services import geospatial

log = logging.getLogger("marine")

_sb = None
if settings.supabase_url and settings.supabase_service_role_key:
    _sb = create_client(settings.supabase_url, settings.supabase_service_role_key)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await geospatial.init_pool()
    except Exception as exc:                      # allow /health to report degraded
        log.warning("DB pool init failed: %s", exc)
    yield
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


@app.get("/health")
async def health():
    try:
        db = await geospatial.ping()
    except Exception as exc:
        db = False
    return {"status": "ok" if db else "degraded", "database": db,
            "llm_configured": bool(settings.openai_api_key)}


def _log_query(payload: dict) -> None:
    """Supabase REST insert (text/jsonb columns only — safe for PostgREST)."""
    if _sb is None:
        return
    _sb.table("user_queries").insert(payload).execute()


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    result = await graph.ainvoke({"message": req.message})

    coords = result.get("coordinates")
    await asyncio.to_thread(_log_query, {
        "query_text": req.message,
        "intent": result.get("intent"),
        "coordinates": coords if coords else None,
        "response_text": result.get("response"),
        "map_features": result.get("map_features"),
    })

    return ChatResponse(
        response=result["response"],
        map_features=result.get("map_features") or {"type": "FeatureCollection", "features": []},
        intent=result.get("intent") or "general_advisory",
    )
