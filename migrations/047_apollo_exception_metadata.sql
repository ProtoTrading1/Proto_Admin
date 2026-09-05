-- 047_apollo_exception_metadata.sql
-- Apollo Operational Release 1.2: exception metadata for "Apollo notices".

ALTER TABLE public.apollo_notifications
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS business_impact text,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS feedback_status text,
  ADD COLUMN IF NOT EXISTS feedback_note text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS feedback_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS feedback_at timestamptz;

ALTER TABLE public.apollo_notifications
  DROP CONSTRAINT IF EXISTS apollo_notifications_severity_check;

ALTER TABLE public.apollo_notifications
  ADD CONSTRAINT apollo_notifications_severity_check
  CHECK (
    severity IN (
      'urgent',
      'attention',
      'opportunity',
      'healthy',
      'info',
      'review',
      'action',
      'critical'
    )
  );

ALTER TABLE public.apollo_notifications
  DROP CONSTRAINT IF EXISTS apollo_notifications_business_impact_check;

ALTER TABLE public.apollo_notifications
  ADD CONSTRAINT apollo_notifications_business_impact_check
  CHECK (business_impact IS NULL OR business_impact IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE public.apollo_notifications
  DROP CONSTRAINT IF EXISTS apollo_notifications_feedback_status_check;

ALTER TABLE public.apollo_notifications
  ADD CONSTRAINT apollo_notifications_feedback_status_check
  CHECK (
    feedback_status IS NULL
    OR feedback_status IN ('useful', 'false_positive', 'needs_threshold_adjustment', 'ignore_permanently')
  );

CREATE INDEX IF NOT EXISTS apollo_notifications_impact_priority_idx
  ON public.apollo_notifications (business_impact, priority_score DESC, detected_at DESC)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS apollo_notifications_feedback_idx
  ON public.apollo_notifications (feedback_status, feedback_at DESC)
  WHERE feedback_status IS NOT NULL;
