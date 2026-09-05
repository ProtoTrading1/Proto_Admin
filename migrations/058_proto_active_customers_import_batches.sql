-- Applied to production (Proto Trading Website).
--
-- Every CSV upload becomes a named group so a batch can be found, filtered and
-- emailed as a unit. created_at could not do this on its own: an upsert on an
-- existing email refreshes the row without moving created_at, so a re-uploaded
-- contact would stay filed under its first import.

alter table public.proto_active_customers
  add column if not exists import_batch text,
  add column if not exists import_batch_at timestamptz;

create index if not exists proto_active_customers_import_batch_idx
  on public.proto_active_customers (import_batch);

-- Backfill the uploads that predate this column, clustering on created_at.
update public.proto_active_customers
set import_batch = to_char(date_trunc('minute', created_at), 'YYYY-MM-DD HH24:MI') || ' import',
    import_batch_at = date_trunc('minute', created_at)
where import_batch is null;
