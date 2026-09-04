"""Fill marine_advisories.embedding for rows where it is NULL.

Rows are listed via the Supabase REST API (per spec); the vector column is
written through asyncpg + pgvector because PostgREST cannot reliably cast
JSON/text into a `vector` column.

Run from backend/:  python -m app.scripts.seed_embeddings
"""
import asyncio

import asyncpg
from supabase import create_client

from app.config import settings
from app.llm import embed_text


async def main() -> None:
    if not all((settings.openai_api_key, settings.supabase_url,
                settings.supabase_service_role_key, settings.database_url)):
        raise SystemExit("Fill backend/.env first (see .env.example).")

    sb = create_client(settings.supabase_url, settings.supabase_service_role_key)
    rows = (sb.table("marine_advisories")
              .select("id,title,content")
              .is_("embedding", "null")
              .execute()).data
    if not rows:
        print("Nothing to seed — all advisories already embedded.")
        return

    conn = await asyncpg.connect(settings.database_url)
    try:
        for row in rows:
            vec = await embed_text(f"{row['title']}\n{row['content']}")
            await conn.execute(
                "UPDATE marine_advisories SET embedding = $1::vector WHERE id = $2",
                vec, row["id"],
            )
            print(f"  seeded id={row['id']} :: {row['title']}")
    finally:
        await conn.close()
    print(f"Done — embedded {len(rows)} advisory row(s).")


if __name__ == "__main__":
    asyncio.run(main())
