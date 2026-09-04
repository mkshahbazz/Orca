"""OpenAI client: gpt-4o (chat/JSON) + text-embedding-3-small (RAG)."""
import json

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
