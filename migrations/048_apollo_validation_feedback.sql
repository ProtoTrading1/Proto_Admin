-- 048_apollo_validation_feedback.sql
-- Release 1.2 validation week: business value, decision outcome, immutable audit.

ALTER TABLE public.apollo_notifications
  ADD COLUMN IF NOT EXISTS business_value text,
  ADD COLUMN IF NOT EXISTS decision_outcome text,
  ADD COLUMN IF NOT EXISTS audit_snapshot jsonb;

ALTER TABLE public.apollo_notifications
  DROP CONSTRAINT IF EXISTS apollo_notifications_business_value_check;

ALTER TABLE public.apollo_notifications
  ADD CONSTRAINT apollo_notifications_business_value_check
  CHECK (business_value IS NULL OR business_value IN ('high', 'medium', 'low', 'none'));

ALTER TABLE public.apollo_notifications
  DROP CONSTRAINT IF EXISTS apollo_notifications_decision_outcome_check;

ALTER TABLE public.apollo_notifications
  ADD CONSTRAINT apollo_notifications_decision_outcome_check
  CHECK (
    decision_outcome IS NULL
    OR decision_outcome IN ('no_action_taken', 'investigated', 'action_taken', 'escalated')
  );

CREATE INDEX IF NOT EXISTS apollo_notifications_business_value_idx
  ON public.apollo_notifications (business_value, feedback_at DESC)
  WHERE business_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS apollo_notifications_decision_outcome_idx
  ON public.apollo_notifications (decision_outcome, feedback_at DESC)
  WHERE decision_outcome IS NOT NULL;
