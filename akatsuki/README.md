# Akatsuki — setup & next steps

Extracted from your coding agent's full scaffold (schema + backend + frontend).
Full source dump is in the uploaded Akatsuki.txt if you need to cross-check anything.

## 1. Supabase (dashboard, not terminal)
Create project → SQL Editor → paste `supabase/schema.sql` → Run. Verify:
```sql
select count(*) from hazard_zones;                    -- 2
select * from public.check_hazard_zone(16.0, 86.5);   -- cyclone row
select * from public.check_hazard_zone(10.0, 80.0);   -- empty = safe
select count(*) from community_reports;               -- 2 (crowdsourced tips)
```

## 2. Backend
```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
                              # (optional) set BHASHINI_INFERENCE_KEY for regional-language replies
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

## 5. Confidence meter, community reports & translation

Each answer now ships a **self-assessment** alongside the markdown: a 0–100 score,
a `high|moderate|low` label and a one-sentence justification. It travels in the
SSE `final` event (never in the token stream), so it cannot interrupt the typing
effect. Green ≥85, amber ≥60, red below — the justification is in the badge tooltip.

* Ask `Can I fish at 16.0, 86.5?` — exact location + live sensors + a spatial check
  scores high; add a sensor-corroborated community report and the score rises by 12.
* Ask something vague (`what should I know about monsoons?`) — knowledge-base-only
  answers stay moderate.
* Kill the network / leave the DB unconfigured — the answer reports the outage
  instead of printing invented numbers (there is no fabricated fallback any more).

Crowdsourced tips live in `community_reports` (what was seen, where, when). The
`community` worker searches within 75 km / 72 h of the queried point, then the
verification matrix cross-checks each claim against live wave/wind/storm data.
Only **verified** reports lift the confidence score; all of them (verified in cyan,
unverified in amber) are drawn as interactive pins on the map.

Translation is two-way: a regional-language question is translated to English
*before* the agents see it, and the English safety report is translated back
before display. The UI shows live backend milestones (`Translating question…`,
`Checking weather buoys…`, `Writing safety report…`) instead of a frozen spinner.

## Two things most likely to bite you
1. **pgvector codec**: `pgvector.asyncpg.register_vector(conn)` must run on every connection before
   any `::vector` query, or asyncpg throws "no codec for type vector".
2. **lon/lat order**: PostGIS wants `ST_MakePoint(lon, lat)` — X first. Getting this backwards is the
   #1 bug risk in `check_hazard_zone`.

Notes: RLS is disabled on the tables for local dev — add policies before any production auth.
The only hard external dependency for `/api/chat` is your OpenAI key.
