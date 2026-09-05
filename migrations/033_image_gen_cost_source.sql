-- 033_image_gen_cost_source.sql  (Stock Supabase: yiqsvwajozafvalwcero)
-- Track whether cost_usd came from OpenRouter usage.cost or local estimate.

alter table public.image_gen_cost_logs
  add column if not exists cost_source text not null default 'estimated';

comment on column public.image_gen_cost_logs.cost_source is
  'openrouter = API usage.cost; estimated = local MODEL_PRICING fallback';
