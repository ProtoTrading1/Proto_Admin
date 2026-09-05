-- 036_orders_customer_notes.sql
-- Notes typed by the customer at checkout (before order is fulfilled).

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_notes text DEFAULT '';

COMMENT ON COLUMN public.orders.customer_notes IS
  'Optional notes from the customer at checkout';
