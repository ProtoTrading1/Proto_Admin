-- Separate a deferred trade application from both pending review and an
-- approved-but-deactivated portal account.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS application_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS application_hold_reason text,
  ADD COLUMN IF NOT EXISTS application_held_at timestamptz;

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_application_status_check;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_application_status_check
  CHECK (application_status IN ('pending', 'on_hold', 'deactivated'));

CREATE INDEX IF NOT EXISTS customers_application_review_idx
  ON public.customers (is_approved, application_status, created_at DESC);

COMMENT ON COLUMN public.customers.application_status IS
  'Customer access state: pending, on_hold, or deactivated. Approved customers are identified by is_approved.';
COMMENT ON COLUMN public.customers.application_hold_reason IS
  'Optional internal reason explaining why a trade application is on hold.';
