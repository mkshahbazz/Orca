# Akatsuki — setup & next steps

Extracted from your coding agent's full scaffold (schema + backend + frontend).
Full source dump is in the uploaded Akatsuki.txt if you need to cross-check anything.

## 0. Upgrading an existing project (community contributions)
If the database already exists, run the additive migration once — it extends
`community_reports` in place (reporter name, media URL/type, six fisher-facing
categories, indexes) and creates the public `community-media` Storage bucket:

```
supabase/migrations/001_community_contribution.sql   -- SQL Editor → Run
```

It creates the table if it is missing as well as extending an existing one, and
every statement is `if not exists` / `drop … if exists`, so running it twice is
harmless and the same paste is correct on any project state. Without it,
`/api/community/*` answers 503 with the migration's name instead of failing
mysteriously.

Verify it took effect:
```bash
curl -s https://orca-backend-nxed.onrender.com/api/community/stats
# {"total":0,"verified":0,...,"contributors":0,"with_media":0,...}
```

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
cp .env.example .env          # fill OPENAI_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
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

## 6. Community contributions (the Contribute page)

`/dashboard/contribute` is the fisher-facing half of the platform. A report has
a photo/clip, a category, a description and a position, and lands in the
**existing** `community_reports` table — there is no second store.

```bash
py scripts/check_community.py          # offline rules: matrix, trust, confidence
py scripts/check_community.py --live   # + probes the deployed API
```

* **Categories**: catch, hazard, sea/ocean condition, fishing-zone condition,
  weather observation, other (the original hazard categories still verify).
* **Verification** runs the moment a report lands: waves/swell/period for sea
  state and hazard claims, wind gusts and storm codes for weather claims, and a
  PostGIS/shapely containment test against the live INCOIS PFZ bulletin for
  catch and fishing-zone claims. `other` is never auto-verified.
* **Confidence**: only verified reports count (+12 each, capped at +18) — exactly
  as before. The factors line now says whether each was sensor- or
  PFZ-corroborated.
* **Media** goes to the public `community-media` Supabase Storage bucket,
  uploaded *through* the API with the service-role key. The key never reaches
  the browser; a 20 MB cap and an image/video type check are enforced server-side.
* **Recognition** is derived from verified counts only:
  `trust = 70% × (verified ÷ reports) + 30% × min(verified, 10) ÷ 10`, with
  badges New Contributor → Trusted Fisher → Verified Observer → Community Expert.

## 7. LLM providers: OpenAI primary, Gemini fallback

`app/llm.py` is the only module the agents call. Each call tries OpenAI first
and, on any failure (quota, exhausted credits, outage, auth), retries the *same*
request on Gemini via `app/services/gemini.py` — in-process, with no second agent
graph and no duplicate classification:

```
router / synthesizer -> llm.chat_json | chat_markdown | chat_markdown_stream
                          OpenAI ──ok──> answer
                             └──fail──> Gemini ──ok──> answer
                                            └──fail──> honest service error
```

* Keys stay server-side: `OPENAI_API_KEY`, `GEMINI_API_KEY`. Neither is ever
  sent to the frontend or committed.
* If OpenAI is not configured at all, Gemini simply serves the request.
* Streaming only falls back *before* the first token — a half-finished answer is
  reported as broken rather than silently restarted.
* If both fail, the UI gets a real error naming both providers. No weather, PFZ,
  hazard or fishing text is ever fabricated to fill the gap.
* `GET /health` reports `llm.primary`, `gemini_configured` and which provider
  served the last request.

## 8. Weather feeds: shared-IP rate limits

Open-Meteo's free endpoints are rate limited **by IP**, and this backend shares
its egress IP with everything else on the host — so a marine answer can fail
with `Daily API request limit exceeded` for reasons that have nothing to do with
this app. How the platform copes, in order:

1. **Caching** — readings live 20 minutes and the dashboard snapshot 3 minutes.
   The upstream publishes on a ~15-minute cadence, so no freshness is lost while
   traffic drops by an order of magnitude.
2. **One short retry** — a 429 that says "try again in one minute" is a burst
   limit and is retried with backoff. A 429 that says "try again tomorrow" is a
   hard daily limit, so it is reported immediately with Open-Meteo's own wording
   instead of making the user wait.
3. **Partial readings** — the wave/SST product and the wind/weather product are
   fetched independently, so one being limited no longer discards the other. The
   result is labelled `partial`, the missing feed is named in the answer, and the
   confidence engine treats it as at most moderate (never high).
4. **Your own quota** — set `OPEN_METEO_API_KEY` and the same products are
   requested from the customer hosts against your account's quota, which removes
   the shared-IP coupling entirely.

## Two things most likely to bite you
1. **pgvector codec**: `pgvector.asyncpg.register_vector(conn)` must run on every connection before
   any `::vector` query, or asyncpg throws "no codec for type vector".
2. **lon/lat order**: PostGIS wants `ST_MakePoint(lon, lat)` — X first. Getting this backwards is the
   #1 bug risk in `check_hazard_zone`.

Notes: RLS is disabled on the tables for local dev — add policies before any production auth.
`/api/chat` needs at least one of `OPENAI_API_KEY` / `GEMINI_API_KEY`, and the
`community-media` bucket must be public-read for contributed photos to render.
