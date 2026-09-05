-- 035_orders_delivery_method.sql
-- Persist checkout courier choice on orders for PDF/email confirmation.
-- Values: "Proto Trading delivers" or "Customer's own courier".

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_method text;

COMMENT ON COLUMN public.orders.delivery_method IS
  'Customer courier choice at checkout: Proto Trading delivers or Customer''s own courier';
