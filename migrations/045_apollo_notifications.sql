-- 045_apollo_notifications.sql
-- Apollo Operational Release 1.1 foundation: proactive notification queue.
--
-- Notifications are generated from Apollo business objects and power the Daily
-- Brief question: "What is in danger of being forgotten today?"

CREATE TABLE IF NOT EXISTS public.apollo_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  source_type text NOT NULL,
  source_id uuid,
  workspace_id uuid REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  recommendation text NOT NULL DEFAULT '',
  action_label text NOT NULL DEFAULT '',
  action_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  priority_score integer NOT NULL DEFAULT 50,
  due_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apollo_notifications_severity_check CHECK (severity IN ('urgent', 'attention', 'opportunity', 'info', 'healthy')),
  CONSTRAINT apollo_notifications_status_check CHECK (status IN ('open', 'resolved', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS apollo_notifications_status_priority_idx
  ON public.apollo_notifications (status, priority_score DESC, detected_at DESC);

CREATE INDEX IF NOT EXISTS apollo_notifications_workspace_idx
  ON public.apollo_notifications (workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS apollo_notifications_due_idx
  ON public.apollo_notifications (due_at)
  WHERE due_at IS NOT NULL AND status = 'open';

ALTER TABLE public.apollo_notifications ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.apollo_notifications IS
  'Apollo proactive notification queue for Daily Brief and operational reminders.';
COMMENT ON COLUMN public.apollo_notifications.dedupe_key IS
  'Stable key used by notification generators so repeated scans update existing open notifications instead of duplicating them.';

