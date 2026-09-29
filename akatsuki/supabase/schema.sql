-- ============================================================
-- Marine Geospatial Safety & Fishing Advisory — schema
-- Run in: Supabase Dashboard -> SQL Editor -> New query
-- ============================================================

create extension if not exists postgis;   -- spatial / ST_Contains
create extension if not exists vector;    -- pgvector RAG

-- 1) Hazard zones (geofencing) ---------------------------------
create table if not exists public.hazard_zones (
    id         bigint generated always as identity primary key,
    name       text not null,
    severity   text not null check (severity in ('low','moderate','severe','extreme')),
    geometry   geometry(Polygon, 4326) not null,   -- X=lon, Y=lat
    advisory   text,
    created_at timestamptz not null default now()
);
create index if not exists hazard_zones_geom_idx on public.hazard_zones using gist (geometry);

-- Seed: Bay of Bengal cyclone band (contains 16.0N 86.5E) + Chennai monsoon swell
insert into public.hazard_zones (name, severity, geometry, advisory) values
('Cyclone Alert — Bay of Bengal', 'severe',
 ST_GeomFromText('POLYGON((85.5 14.8, 88.0 14.8, 88.0 18.0, 85.5 18.0, 85.5 14.8))', 4326),
 'Deep depression: wind 45-55 km/h gusting 65 km/h, very rough seas. Small craft must not venture out.'),
('High Wave Alert — Chennai Coast', 'moderate',
 ST_GeomFromText('POLYGON((79.9 12.7, 80.8 12.7, 80.8 13.7, 79.9 13.7, 79.9 12.7))', 4326),
 'Monsoon swell: waves 2.5-3.5 m near coast. Harbour small vessels; avoid offshore fishing.');

-- 2) Potential Fishing Zones (PFZ) --------------------------------
create table if not exists public.pfz_zones (
    id            bigint generated always as identity primary key,
    location_name text not null,
    sst           double precision not null,        -- sea surface temp (°C)
    chlorophyll   double precision not null,        -- mg/m³
    geometry      geometry(Polygon, 4326) not null,
    valid_until   timestamptz not null
);
create index if not exists pfz_zones_geom_idx on public.pfz_zones using gist (geometry);

insert into public.pfz_zones (location_name, sst, chlorophyll, geometry, valid_until) values
('Chennai Offshore PFZ', 29.4, 1.8,
 ST_GeomFromText('POLYGON((80.3 13.2, 80.7 13.2, 80.7 13.8, 80.3 13.8, 80.3 13.2))', 4326),
 now() + interval '48 hours'),
('Paradip–Visakhapatnam PFZ', 29.0, 2.3,
 ST_GeomFromText('POLYGON((84.6 16.4, 85.4 16.4, 85.4 17.2, 84.6 17.2, 84.6 16.4))', 4326),
 now() + interval '48 hours');

-- 3) Marine advisories (pgvector RAG source) -----------------------
create table if not exists public.marine_advisories (
    id         bigint generated always as identity primary key,
    title      text not null,
    content    text not null,
    category   text not null check (category in ('safety','weather','fishing','boundary','navigation')),
    embedding  vector(1536),     -- OpenAI text-embedding-3-small
    created_at timestamptz not null default now()
);
create index if not exists marine_advisories_emb_idx
    on public.marine_advisories using hnsw (embedding vector_cosine_ops);

insert into public.marine_advisories (title, category, content) values
('Cyclone warning — standard operating procedure', 'weather',
 'On cyclone warning: return to harbour, secure loose gear, monitor VHF channel 16. Do not venture beyond 10 nautical miles. Heed port signals (red flag by day / red lantern by night).'),
('Monsoon high-wave alert protocol', 'weather',
 'During monsoon swells exceeding 3 m, small vessels (<15 m) must remain within 5 nautical miles of the coast and wear life jackets at all times. Carry radio and EPIRB.'),
('Thunderstorm and lightning safety at sea', 'safety',
 'If lightning is within 10 nautical miles, lower antennas, keep crew below deck, avoid metal surfaces. Do not fish under an active cumulonimbus cell.'),
('PFZ fishing best practice', 'fishing',
 'Target high-chlorophyll (>1.5 mg/m³) patches identified by satellite for tuna and mackerel. Confirm with local catch reports and validate depth contours before setting nets.'),
('Maritime boundary caution', 'boundary',
 'Fishing across the international maritime boundary is a legal offence and can lead to vessel seizure and crew detention. Cross-check GPS position against the EEZ line before long trips.');

-- 4) Crowdsourced community reports ---------------------------------
-- Tips from fishermen / coastal workers. Never trusted blindly: the backend
-- cross-references each claim with live satellite + weather readings and only
-- then sets `verified` (which is what feeds the confidence score).
create table if not exists public.community_reports (
    id                bigint generated always as identity primary key,
    created_at        timestamptz not null default now(),
    observed_at       timestamptz not null default now(),   -- when it happened
    category          text not null check (category in (
                          -- Contribute page choices
                          'catch','hazard','sea_condition','fishing_zone',
                          'weather_observation','other',
                          -- sensor-corroborated hazard categories
                          'heavy_swell','high_wave','rough_seas','high_wind',
                          'squall','thunderstorm','storm','strong_current',
                          'debris','oil_spill','shoal','fish_sighting')),
    description       text not null,                        -- what was seen
    reporter_role     text,                                 -- fisherman, coast_guard…
    reporter_name     text,                                 -- feeds trust/badges
    media_url         text,                                 -- Supabase Storage URL
    media_type        text check (media_type is null or media_type in ('image','video')),
    lat               double precision not null,
    lon               double precision not null,
    location          geometry(Point, 4326) not null,       -- where (X=lon, Y=lat)
    verified          boolean not null default false,
    verification_note text,
    verification_source text
);
-- Upgrading an existing project instead? Run
--   supabase/migrations/001_community_contribution.sql
-- which adds the same columns, categories, indexes and storage bucket in place.
create index if not exists community_reports_geom_idx
    on public.community_reports using gist (location);
create index if not exists community_reports_observed_at_idx
    on public.community_reports (observed_at desc);
create index if not exists community_reports_reporter_idx
    on public.community_reports (reporter_name);
create index if not exists community_reports_verified_idx
    on public.community_reports (verified, observed_at desc);
create index if not exists community_reports_category_idx
    on public.community_reports (category, observed_at desc);

-- Storage bucket for contributed photos/video (public read, server-side write).
insert into storage.buckets (id, name, public)
values ('community-media', 'community-media', true)
on conflict (id) do update set public = true;
update storage.buckets
   set file_size_limit = 20971520,
       allowed_mime_types = array[
         'image/jpeg','image/png','image/webp','image/heic','image/heif',
         'video/mp4','video/quicktime','video/webm','video/3gpp','video/x-matroska'
       ]
 where id = 'community-media';

-- Keep `location` in sync with the lat/lon pair on every insert.
create or replace function public.sync_community_location()
returns trigger language plpgsql as $$
begin
    new.location := ST_SetSRID(ST_MakePoint(new.lon, new.lat), 4326);
    return new;
end;
$$;

drop trigger if exists community_reports_sync_location on public.community_reports;
create trigger community_reports_sync_location
    before insert or update of lat, lon on public.community_reports
    for each row execute function public.sync_community_location();

-- Seed: one report the sensors can confirm (swell near Paradip) and one they
-- cannot (debris near Chennai) — good for exercising the verification matrix.
insert into public.community_reports
    (observed_at, category, description, reporter_role, lat, lon) values
(now() - interval '6 hours', 'heavy_swell',
 'Heavy rolling swell breaking over the sandbar; small boats turning back.',
 'fisherman', 19.25, 86.85),
(now() - interval '20 hours', 'debris',
 'Large drifting log and tangled net about 3 nm offshore.',
 'coastal_worker', 13.15, 80.35);

-- 5) Chat / query log ------------------------------------------------
create table if not exists public.user_queries (
    id            bigint generated always as identity primary key,
    created_at    timestamptz not null default now(),
    query_text    text not null,
    intent        text,
    coordinates   jsonb,          -- {"lat": .., "lon": ..}
    response_text text,
    map_features  jsonb           -- GeoJSON FeatureCollection
);

-- 6) PostGIS spatial function -----------------------------------------
create or replace function public.check_hazard_zone(lat double precision, lon double precision)
returns table (id bigint, name text, severity text, advisory text)
language sql stable
as $$
    select h.id, h.name, h.severity, h.advisory
    from public.hazard_zones h
    where ST_Contains(h.geometry, ST_SetSRID(ST_MakePoint(lon, lat), 4326));  -- lon FIRST
$$;

-- 7) pgvector cosine-similarity RPC -------------------------------------
create or replace function public.match_advisories(query_embedding vector(1536), match_count int default 3)
returns table (id bigint, title text, category text, content text, similarity double precision)
language sql stable
as $$
    select a.id, a.title, a.category, a.content, 1 - (a.embedding <=> query_embedding) as similarity
    from public.marine_advisories a
    where a.embedding is not null
    order by a.embedding <=> query_embedding
    limit match_count;
$$;

-- Sanity check: this must return the cyclone row
-- select * from public.check_hazard_zone(16.0, 86.5);

-- 8) Performance indexes (optimization pass) ----------------------------
-- PFZ bulletin query filters on valid_until and sorts by chlorophyll.
create index if not exists pfz_zones_valid_until_idx on public.pfz_zones (valid_until);
create index if not exists pfz_zones_chlorophyll_idx on public.pfz_zones (chlorophyll desc);
-- user_queries grows unbounded; keep recent-first lookups/cleanup fast.
create index if not exists user_queries_created_at_idx on public.user_queries (created_at desc);

-- Sanity check: this must return the two seeded community reports
-- select * from public.community_reports;
