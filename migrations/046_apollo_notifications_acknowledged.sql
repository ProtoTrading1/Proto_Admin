-- 046_apollo_notifications_acknowledged.sql
-- Release 1.1 production gate: support acknowledged notifications without
-- treating them as resolved or dismissed.

ALTER TABLE public.apollo_notifications
  DROP CONSTRAINT IF EXISTS apollo_notifications_status_check;

ALTER TABLE public.apollo_notifications
  ADD CONSTRAINT apollo_notifications_status_check
  CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed'));
