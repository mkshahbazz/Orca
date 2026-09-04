# Akatsuki — setup & next steps

Extracted from your coding agent's full scaffold (schema + backend + frontend).
Full source dump is in the uploaded Akatsuki.txt if you need to cross-check anything.

## 1. Supabase (dashboard, not terminal)
Create project → SQL Editor → paste `supabase/schema.sql` → Run. Verify:
```sql
select count(*) from hazard_zones;                    -- 2
select * from public.check_hazard_zone(16.0, 86.5);   -- cyclone row
select * from public.check_hazard_zone(10.0, 80.0);   -- empty = safe
```

## 2. Backend
```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
python -m app.scripts.seed_embeddings    # "Done — embedded 5 advisory row(s)."
uvicorn app.main:app --reload --port 8000
```

## 3. Frontend
```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev                  # http://localhost:3000
```

## 4. End-to-end verification
```bash
curl http://localhost:8000/health
# {"status":"ok","database":true,"llm_configured":true}

curl -X POST http://localhost:8000/api/chat -H "Content-Type: application/json" \
  -d '{"message":"Can I fish at 16.0, 86.5?"}'
# expect intent:"hazard_check", response with warning, map_features red polygon

curl -X POST http://localhost:8000/api/chat -H "Content-Type: application/json" \
  -d '{"message":"Where is the best PFZ today?"}'
# expect intent:"pfz_search", green PFZ polygons in map_features
```
Then open the UI and ask the same questions — the map should auto-fly to each zone.
Check Supabase → Table Editor → user_queries: every interaction should be logged.

## Two things most likely to bite you
1. **pgvector codec**: `pgvector.asyncpg.register_vector(conn)` must run on every connection before
   any `::vector` query, or asyncpg throws "no codec for type vector".
2. **lon/lat order**: PostGIS wants `ST_MakePoint(lon, lat)` — X first. Getting this backwards is the
   #1 bug risk in `check_hazard_zone`.

Notes: RLS is disabled on the tables for local dev — add policies before any production auth.
The only hard external dependency for `/api/chat` is your OpenAI key.
