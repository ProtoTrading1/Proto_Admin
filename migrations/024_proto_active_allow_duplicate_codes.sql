-- Required for Sync proto active list (1078 rows).
-- Migration 022 added a unique index on account_code; multiple customers legitimately
-- share the same 6-char prefix (e.g. two FRIEND accounts with different emails).

DROP INDEX IF EXISTS public.proto_active_customers_account_code_unique_idx;

-- Non-unique lookup index (safe to re-create)
CREATE INDEX IF NOT EXISTS proto_active_customers_account_code_idx
  ON public.proto_active_customers (account_code);
