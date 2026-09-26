"""OpenAI client: gpt-4o (chat/JSON) + text-embedding-3-small (RAG)."""
import json
from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings

CHAT_MODEL = "gpt-4o"
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536

_client = AsyncOpenAI(api_key=settings.openai_api_key)


async def embed_text(text: str) -> list[float]:
    """Single text -> embedding vector (1536 dims)."""
    resp = await _client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    return resp.data[0].embedding


async def chat_json(system: str, user: str) -> dict:
    """Structured JSON reply from gpt-4o (JSON mode). Prompt must mention 'json'."""
    resp = await _client.chat.completions.create(
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
    resp = await _client.chat.completions.create(
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
    stream = await _client.chat.completions.create(
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
