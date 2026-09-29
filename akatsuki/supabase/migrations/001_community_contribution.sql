-- ============================================================
-- 001 · Community contributions (Contribute page + recognition)
-- Run in: Supabase Dashboard -> SQL Editor -> New query
--
-- ADDITIVE and IDEMPOTENT. It brings `public.community_reports` to the shape the
-- Contribute page needs whether that table is missing entirely (a project set up
-- without this section of schema.sql) or already exists in an earlier form, so
-- the same paste is correct in both cases and safe to run twice.
--
-- It does NOT touch hazard_zones, pfz_zones, marine_advisories or user_queries.
-- ============================================================

create extension if not exists postgis;

-- 1) The table itself ------------------------------------------------------
-- Notes on the shape:
--   · `location` is derived from lat/lon by a trigger below, so callers only
--     ever send numbers (X = lon, Y = lat — PostGIS order).
--   · category carries the six fisher-facing choices plus the original
--     sensor-corroborated hazard categories, so old rows stay valid.
create table if not exists public.community_reports (
    id                  bigint generated always as identity primary key,
    created_at          timestamptz not null default now(),
    observed_at         timestamptz not null default now(),
    category            text not null,
    description         text not null,
    reporter_role       text,
    reporter_name       text,
    media_url           text,
    media_type          text,
    lat                 double precision not null,
    lon                 double precision not null,
    location            geometry(Point, 4326),
    verified            boolean not null default false,
    verification_note   text,
    verification_source text
);

-- 2) Columns an earlier version may be missing ----------------------------
alter table public.community_reports
    add column if not exists reporter_name       text,
    add column if not exists media_url           text,
    add column if not exists media_type          text,
    add column if not exists reporter_role       text,
    add column if not exists verified            boolean not null default false,
    add column if not exists verification_note    text,
    add column if not exists verification_source  text,
    add column if not exists observed_at         timestamptz not null default now(),
    add column if not exists created_at          timestamptz not null default now();

comment on column public.community_reports.reporter_name is
    'Display name the contributor filed under; drives the trust/badge aggregate.';
comment on column public.community_reports.media_url is
    'Public Supabase Storage URL of the attached photo/video.';
comment on column public.community_reports.verification_source is
    'Which feed corroborated the report: a live weather source, or the INCOIS PFZ bulletin.';

-- 3) Keep `location` in sync with lat/lon ---------------------------------
-- The trigger is the only writer of the geometry column, so the API never has
-- to know about PostGIS at all.
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

-- Backfill any row written before the trigger existed, then lock the column
-- down so a position-less report can never be stored.
update public.community_reports
   set location = ST_SetSRID(ST_MakePoint(lon, lat), 4326)
 where location is null;

alter table public.community_reports alter column location set not null;

-- 4) Constraints ----------------------------------------------------------
-- Dropped and re-added so a fresh table and an older one converge on exactly
-- the same rule; the new list is a superset of the original, so no stored row
-- can violate it.
alter table public.community_reports
    drop constraint if exists community_reports_category_check;
alter table public.community_reports
    add constraint community_reports_category_check check (category in (
        -- Contribute page choices
        'catch', 'hazard', 'sea_condition', 'fishing_zone',
        'weather_observation', 'other',
        -- original sensor-corroborated hazard categories (kept)
        'heavy_swell', 'high_wave', 'rough_seas', 'high_wind', 'squall',
        'thunderstorm', 'storm', 'strong_current', 'debris', 'oil_spill',
        'shoal', 'fish_sighting'
    ));

alter table public.community_reports
    drop constraint if exists community_reports_media_type_check;
alter table public.community_reports
    add constraint community_reports_media_type_check
        check (media_type is null or media_type in ('image', 'video'));

-- 5) Indexes --------------------------------------------------------------
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

-- 6) Storage bucket for contributed photos and video ----------------------
-- Public-read so the browser can render `media_url` directly; writes go through
-- the backend only (service-role key), which is why there is no anon insert
-- policy. Guarded, because the storage schema only exists on Supabase.
do $$
begin
    if to_regclass('storage.buckets') is null then
        raise notice 'storage schema not present — skipping the community-media bucket';
        return;
    end if;

    insert into storage.buckets (id, name, public)
    values ('community-media', 'community-media', true)
    on conflict (id) do update set public = true;

    update storage.buckets
       set file_size_limit = 20971520,               -- 20 MB, mirrored by the API
           allowed_mime_types = array[
             'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
             'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
             'video/x-matroska'
           ]
     where id = 'community-media';

    if not exists (
        select 1 from pg_policies
         where schemaname = 'storage'
           and tablename  = 'objects'
           and policyname = 'community_media_public_read'
    ) then
        create policy community_media_public_read
            on storage.objects for select
            using (bucket_id = 'community-media');
    end if;
end $$;

-- 7) Sanity checks --------------------------------------------------------
-- The table is now present with the contribution columns:
--   select count(*) from public.community_reports;                       -- 0 or more
--   select column_name from information_schema.columns
--    where table_name = 'community_reports' and column_name in
--          ('reporter_name','media_url','media_type','location');        -- 4 rows
-- The bucket exists:
--   select id, public, file_size_limit from storage.buckets where id = 'community-media';
-- Contributor trust, exactly as the API computes it:
--   select coalesce(nullif(btrim(reporter_name), ''), 'Anonymous') as name,
--          count(*) as contributions,
--          count(*) filter (where verified) as verified
--     from public.community_reports group by 1 order by 3 desc;
