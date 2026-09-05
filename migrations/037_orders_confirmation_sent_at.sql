-- 037_orders_confirmation_sent_at.sql
-- Persist order-confirmation "sent to customer" on orders for tab filters + pagination.
-- Backfill legacy site-config markers: node scripts/backfill-confirmation-sent-at.mjs

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;

COMMENT ON COLUMN public.orders.confirmation_sent_at IS
  'When the order confirmation email was sent to the customer; moves order from Confirmation to Payment tab';

CREATE INDEX IF NOT EXISTS orders_confirmation_sent_at_idx
  ON public.orders (confirmation_sent_at)
  WHERE confirmation_sent_at IS NOT NULL;

-- Denormalized line-item haystack for admin order search (jsonb ilike is not supported in PostgREST).
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS items_search text
  GENERATED ALWAYS AS (
    trim(both from coalesce(items::text, '') || ' ' || coalesce(original_items::text, ''))
  ) STORED;
