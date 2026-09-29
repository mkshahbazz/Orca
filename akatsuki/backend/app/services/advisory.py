"""pgvector RAG: cosine similarity over marine_advisories (asyncpg).

Query embeddings come from OpenAI's `text-embedding-3-small` (1536 dims) because
the `marine_advisories.embedding` column and its HNSW index are built for exactly
that model. Embeddings from two different models are not comparable, so the
search deliberately does **not** fall back to another provider's vectors — doing
so would return confident nonsense instead of an error.

What happens when the embedding provider is down is therefore decided by the
caller, not here: `match_advisories` raises :class:`AdvisoryUnavailable`, and the
advisory worker turns that into an explicitly missing dataset. The answer then
says the knowledge base could not be searched, the confidence score loses the
"advisory" evidence it would have had, and nothing is invented to fill the gap.
"""
from app.llm import embed_text
from app.services import geospatial


class AdvisoryUnavailable(RuntimeError):
    """The safety knowledge base could not be searched for this question."""


async def match_advisories(query: str, limit: int = 3) -> list[dict]:
    """Embed the query and return the closest advisory documents."""
    from pgvector.asyncpg import register_vector  # local import keeps startup clean

    from app.llm import LLMError

    if geospatial._pool is None:
        raise AdvisoryUnavailable(
            "The spatial database is unavailable, so the advisory knowledge base "
            "could not be searched."
        )

    try:
        vector = await embed_text(query)
    except LLMError as exc:
        raise AdvisoryUnavailable(
            f"The embedding provider could not be reached, so the advisory knowledge "
            f"base was not searched. {exc}"
        ) from exc
    except Exception as exc:
        raise AdvisoryUnavailable(
            f"The query could not be embedded, so the advisory knowledge base was not "
            f"searched. {type(exc).__name__}: {exc}"
        ) from exc

    sql = """
        SELECT id, title, category, content,
               1 - (embedding <=> $1::vector) AS similarity
        FROM marine_advisories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
    """
    try:
        async with geospatial._pool.acquire() as conn:
            await register_vector(conn)          # enables Python-list vector params
            rows = await conn.fetch(sql, vector, limit)
    except Exception as exc:
        raise AdvisoryUnavailable(
            f"The advisory knowledge base could not be queried. {type(exc).__name__}: {exc}"
        ) from exc
    return [dict(r) | {"similarity": round(r["similarity"], 3)} for r in rows]
