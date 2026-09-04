"""pgvector RAG: cosine similarity over marine_advisories (asyncpg)."""
from app.llm import embed_text
from app.services import geospatial


async def match_advisories(query: str, limit: int = 3) -> list[dict]:
    """Embed the query and return the closest advisory documents."""
    from pgvector.asyncpg import register_vector  # local import keeps startup clean

    if geospatial._pool is None:
        raise RuntimeError("DB pool not initialised — call init_pool() first")

    vector = await embed_text(query)
    sql = """
        SELECT id, title, category, content,
               1 - (embedding <=> $1::vector) AS similarity
        FROM marine_advisories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
    """
    async with geospatial._pool.acquire() as conn:
        await register_vector(conn)          # enables Python-list vector params
        rows = await conn.fetch(sql, vector, limit)
    return [dict(r) | {"similarity": round(r["similarity"], 3)} for r in rows]
