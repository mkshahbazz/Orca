"""OpenAI client: gpt-4o (chat/JSON) + text-embedding-3-small (RAG).

The client is created *lazily* on first use. Previously it was constructed at
import time, which meant an empty/missing OPENAI_API_KEY killed the process the
instant the module was imported — before the app's lifespan had confirmed that
credentials were loaded. `startup()` is now called from the FastAPI lifespan and
`_get_client()` re-checks on every call, so a missing key surfaces as a clear
runtime error (reported to the UI) instead of a silent boot crash.
"""
import json
from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings

CHAT_MODEL = "gpt-4o"
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536


class LLMError(RuntimeError):
    """Base class for AI-provider failures surfaced to the user interface."""


class LLMNotConfigured(LLMError):
    """Raised when the provider credentials were never supplied."""


class LLMUnavailable(LLMError):
    """Raised when the provider rejects/blocks a request (quota, outage, ...)."""


_client: AsyncOpenAI | None = None


def startup() -> bool:
    """Validate credentials and (re)build the client. Returns True when usable.

    Deliberately does **no** network I/O: it only confirms that the required
    secrets are present so the switch happens after the environment is loaded.
    """
    global _client
    if not settings.openai_api_key.strip():
        _client = None
        return False
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return True


def shutdown() -> None:
    global _client
    _client = None


def is_configured() -> bool:
    return bool(settings.openai_api_key.strip())


async def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not startup():
            raise LLMNotConfigured(
                "OPENAI_API_KEY is not configured on the server — the AI service is unavailable."
            )
    return _client


async def embed_text(text: str) -> list[float]:
    """Single text -> embedding vector (1536 dims)."""
    client = await _get_client()
    resp = await client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    return resp.data[0].embedding


async def chat_json(system: str, user: str) -> dict:
    """Structured JSON reply from gpt-4o (JSON mode). Prompt must mention 'json'."""
    client = await _get_client()
    resp = await client.chat.completions.create(
        model=CHAT_MODEL,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return json.loads(resp.choices[0].message.content or "{}")


async def chat_markdown(system: str, user: str) -> str:
    """Free-form markdown reply from gpt-4o (final answer synthesis)."""
    client = await _get_client()
    resp = await client.chat.completions.create(
        model=CHAT_MODEL,
        temperature=0.3,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return resp.choices[0].message.content or ""


async def chat_markdown_stream(system: str, user: str) -> AsyncIterator[str]:
    """Streaming variant of chat_markdown — yields tokens as they arrive
    so callers can push them to clients (lower time-to-first-byte)."""
    client = await _get_client()
    stream = await client.chat.completions.create(
        model=CHAT_MODEL,
        temperature=0.3,
        stream=True,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    async for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content
