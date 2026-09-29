-- ============================================================
-- 001 · Community contributions (Contribute page + recognition)
-- Run in: Supabase Dashboard -> SQL Editor -> New query
--
-- ADDITIVE ONLY. The community_reports table already existed with the
-- verification columns the agents use; this migration extends it in place
-- rather than creating a parallel store, so existing rows, the PostGIS
-- `location` column, its trigger and every existing query keep working.
-- ============================================================

-- 1) Contributor identity + media metadata -------------------------------
alter table public.community_reports
    add column if not exists reporter_name text,
    add column if not exists media_url     text,
    add column if not exists media_type    text;   -- 'image' | 'video'

comment on column public.community_reports.reporter_name is
    'Display name the contributor filed under; drives the trust/badge aggregate.';
comment on column public.community_reports.media_url is
    'Public Supabase Storage URL of the attached photo/video.';
comment on column public.community_reports.verification_source is
    'Which feed corroborated the report: a live weather source, or the INCOIS PFZ bulletin.';

-- 2) Extend the category vocabulary -------------------------------------
-- The Contribute page offers six choices a fisherman immediately understands;
-- the original hazard categories stay valid so nothing already stored breaks.
alter table public.community_reports
    drop constraint if exists community_reports_category_check;

alter table public.community_reports
    add constraint community_reports_category_check check (category in (
        -- fisher-facing contribution categories
        'catch', 'hazard', 'sea_condition', 'fishing_zone',
        'weather_observation', 'other',
        -- original sensor-corroborated hazard categories (kept)
        'heavy_swell', 'high_wave', 'rough_seas', 'high_wind', 'squall',
        'thunderstorm', 'storm', 'strong_current', 'debris', 'oil_spill',
        'shoal', 'fish_sighting'
    ));

-- Media, when present, must be one of the two kinds the API accepts.
alter table public.community_reports
    drop constraint if exists community_reports_media_type_check;
alter table public.community_reports
    add constraint community_reports_media_type_check
        check (media_type is null or media_type in ('image', 'video'));

-- 3) Indexes for the Contribute page reads ------------------------------
-- Newest-reports listing, contributor aggregation, and verified-only filters.
create index if not exists community_reports_reporter_idx
    on public.community_reports (reporter_name);
create index if not exists community_reports_verified_idx
    on public.community_reports (verified, observed_at desc);
create index if not exists community_reports_category_idx
    on public.community_reports (category, observed_at desc);

-- 4) Storage bucket for contributed photos and video --------------------
-- Public-read so the browser can render media_url directly; writes go through
-- the backend only (service-role key), which is why there is no anon policy.
insert into storage.buckets (id, name, public)
values ('community-media', 'community-media', true)
on conflict (id) do update set public = true;

-- Hard size cap enforced by the bucket itself (the API also validates type and
-- size before forwarding a single byte).
update storage.buckets
   set file_size_limit = 20971520,               -- 20 MB
       allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
         'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
         'video/x-matroska'
       ]
 where id = 'community-media';

-- Public read access to the bucket's objects (uploads stay server-side).
do $$
begin
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

-- 5) Sanity checks ------------------------------------------------------
-- Every report carries a position (the original trigger fills `location`):
--   select count(*) from public.community_reports where location is null;  -- 0
-- Category distribution after the Contribute page has been used:
--   select category, count(*), count(*) filter (where verified) as verified
--     from public.community_reports group by 1 order by 2 desc;
-- Contributor trust, exactly as the API computes it:
--   select coalesce(nullif(btrim(reporter_name), ''), 'Anonymous') as name,
--          count(*) as contributions,
--          count(*) filter (where verified) as verified
--     from public.community_reports group by 1 order by 3 desc;
