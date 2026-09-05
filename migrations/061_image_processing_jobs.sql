-- 061_image_processing_review_jobs (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- Durable, owner-only review records for the Image Processing Centre.
-- Generated files remain in staging until an owner explicitly applies an
-- approved version to the matching live SKU and image slot.

-- The old preview experiment used image_processing_jobs. It is intentionally
-- left untouched: production uses these isolated review tables instead.

create table if not exists public.image_processing_review_jobs (
  id uuid primary key default gen_random_uuid(),
  environment text not null default 'production'
    check (environment in ('production', 'preview', 'development')),
  sku text not null,
  target_slot smallint not null check (target_slot between 1 and 4),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready_for_review', 'approved', 'applying', 'applied', 'discarded', 'needs_attention', 'expired')),
  treatment text not null
    check (treatment in ('standard', 'transparent', 'fine_detail')),
  treatment_reason text not null,
  product_title text,
  source_type text not null
    check (source_type in ('nutstore', 'upload', 'url')),
  source_url text,
  source_nutstore_path text,
  source_storage_path text,
  source_content_type text,
  processed_url text,
  processed_storage_path text,
  processed_model text,
  processed_version text,
  expected_live_url text,
  review_notes text,
  error_message text,
  queued_by text,
  approved_by text,
  approved_at timestamptz,
  applied_by text,
  applied_at timestamptz,
  applied_image_url text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one active review can target the same live image slot in an environment.
create unique index if not exists image_processing_review_jobs_open_slot_idx
  on public.image_processing_review_jobs (environment, sku, target_slot)
  where status in ('queued', 'processing', 'ready_for_review', 'approved', 'applying', 'needs_attention');

create index if not exists image_processing_review_jobs_environment_updated_idx
  on public.image_processing_review_jobs (environment, updated_at desc);

create table if not exists public.image_processing_review_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.image_processing_review_jobs(id) on delete restrict,
  event text not null
    check (event in ('queued', 'processing_started', 'review_ready', 'manual_candidate_ready', 'review_approved', 'apply_started', 'applied', 'discarded', 'failed', 'expired')),
  actor text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists image_processing_review_job_events_job_created_idx
  on public.image_processing_review_job_events (job_id, created_at asc);

alter table public.image_processing_review_jobs enable row level security;
alter table public.image_processing_review_job_events enable row level security;

revoke all on public.image_processing_review_jobs from anon, authenticated;
revoke all on public.image_processing_review_job_events from anon, authenticated;
grant all on public.image_processing_review_jobs to service_role;
grant all on public.image_processing_review_job_events to service_role;
