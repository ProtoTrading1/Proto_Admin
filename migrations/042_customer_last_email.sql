-- Per-customer "last email sent" status.
--
-- Records the most recent email dispatched to a customer so the admin can see,
-- at a glance, what the last touch was (welcome / order confirmation /
-- campaign / trade-application) and when. Written by the send paths; read by
-- Customer Management. Purely informational — never gates anything.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS last_email_type text,
  ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

COMMENT ON COLUMN customers.last_email_type IS
  'Type of the most recent email sent to this customer (e.g. welcome, order_confirmation, campaign, trade_application).';
COMMENT ON COLUMN customers.last_email_at IS
  'Timestamp of the most recent email sent to this customer.';
