-- Portal project: kyodrsqnmihwoplkhwwf
--
-- Fixes a real break in migration 062: uploading a group always failed with
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- 062 made the uniqueness index an EXPRESSION index on
-- (group_id, lower(btrim(email))). PostgREST's upsert emits
-- ON CONFLICT (group_id, email), and Postgres will only match that against a
-- unique index on those exact columns — an expression index does not qualify,
-- so every insert raised instead of skipping the duplicate.
--
-- A plain index is equivalent here because the API never stores a
-- non-normalised address: validateMemberPayload lowercases and trims every
-- email before it reaches the database, and that is covered by tests. Losing
-- the expression costs nothing and makes the conflict target resolvable.

drop index if exists public.email_group_members_unique;

create unique index if not exists email_group_members_unique
  on public.email_group_members (group_id, email);
