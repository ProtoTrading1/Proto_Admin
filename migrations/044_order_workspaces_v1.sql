-- 044_order_workspaces_v1.sql
-- Explicit durable model for Apollo Orders Workspace v1.
--
-- This is intentionally separate from the existing checkout/fulfillment orders
-- table. Orders Workspace is Apollo's customer-order notebook replacement:
-- durable workspace, customer snapshot, lines, tasks, promises, reminders,
-- files, and immutable timeline.

CREATE TABLE IF NOT EXISTS public.order_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'Draft',
  priority text NOT NULL DEFAULT 'Normal',
  command text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  due_date date,
  supplier text,
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT 'apollo',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT order_workspaces_status_check CHECK (
    status IN (
      'Draft',
      'Pending Review',
      'Quoted',
      'Waiting Supplier',
      'Ordered',
      'Waiting Arrival',
      'Ready',
      'Delivered',
      'Closed'
    )
  ),
  CONSTRAINT order_workspaces_priority_check CHECK (
    priority IN ('Low', 'Normal', 'High', 'Urgent')
  )
);

CREATE TABLE IF NOT EXISTS public.order_workspace_customers (
  workspace_id uuid PRIMARY KEY REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL DEFAULT '',
  account text NOT NULL DEFAULT '',
  contact text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.order_workspace_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  sku text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  requested_qty numeric NOT NULL DEFAULT 0,
  confirmed_qty numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Draft',
  supplier text NOT NULL DEFAULT '',
  price numeric,
  availability text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT 'apollo',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_workspace_lines_status_check CHECK (
    status IN ('Draft', 'Pending Review', 'Confirmed', 'Unavailable', 'Cancelled')
  )
);

CREATE TABLE IF NOT EXISTS public.order_workspace_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  owner text NOT NULL DEFAULT '',
  due_date date,
  status text NOT NULL DEFAULT 'Open',
  completed_by text,
  completed_at timestamptz,
  created_by text NOT NULL DEFAULT 'apollo',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_workspace_tasks_status_check CHECK (status IN ('Open', 'Completed', 'Cancelled'))
);

CREATE TABLE IF NOT EXISTS public.order_workspace_promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  promise_text text NOT NULL,
  made_by text NOT NULL DEFAULT 'apollo',
  made_to text NOT NULL DEFAULT '',
  due_date date,
  status text NOT NULL DEFAULT 'Open',
  completed_at timestamptz,
  related_task_id uuid REFERENCES public.order_workspace_tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_workspace_promises_status_check CHECK (status IN ('Open', 'Completed', 'Cancelled'))
);

CREATE TABLE IF NOT EXISTS public.order_workspace_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'Open',
  created_by text NOT NULL DEFAULT 'apollo',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_workspace_reminders_status_check CHECK (status IN ('Open', 'Completed', 'Cancelled'))
);

CREATE TABLE IF NOT EXISTS public.order_workspace_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  filename text NOT NULL,
  file_type text NOT NULL DEFAULT 'Attachment',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_path text NOT NULL,
  uploaded_by text NOT NULL DEFAULT 'apollo',
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.order_workspace_timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.order_workspaces(id) ON DELETE CASCADE,
  actor text NOT NULL DEFAULT 'apollo',
  event_type text NOT NULL,
  summary text NOT NULL,
  ref_table text,
  ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.reject_order_workspace_timeline_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'order workspace timeline is append-only';
END;
$$;

DROP TRIGGER IF EXISTS order_workspace_timeline_no_update ON public.order_workspace_timeline;
CREATE TRIGGER order_workspace_timeline_no_update
BEFORE UPDATE OR DELETE ON public.order_workspace_timeline
FOR EACH ROW EXECUTE FUNCTION public.reject_order_workspace_timeline_update();

CREATE INDEX IF NOT EXISTS order_workspaces_customer_id_idx ON public.order_workspaces (customer_id);
CREATE INDEX IF NOT EXISTS order_workspaces_status_idx ON public.order_workspaces (status);
CREATE INDEX IF NOT EXISTS order_workspaces_due_date_idx ON public.order_workspaces (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_workspaces_updated_at_idx ON public.order_workspaces (updated_at DESC);
CREATE INDEX IF NOT EXISTS order_workspace_lines_workspace_idx ON public.order_workspace_lines (workspace_id);
CREATE INDEX IF NOT EXISTS order_workspace_tasks_workspace_idx ON public.order_workspace_tasks (workspace_id, status);
CREATE INDEX IF NOT EXISTS order_workspace_promises_workspace_idx ON public.order_workspace_promises (workspace_id, status);
CREATE INDEX IF NOT EXISTS order_workspace_reminders_workspace_idx ON public.order_workspace_reminders (workspace_id, status, due_date);
CREATE INDEX IF NOT EXISTS order_workspace_files_workspace_idx ON public.order_workspace_files (workspace_id);
CREATE INDEX IF NOT EXISTS order_workspace_timeline_workspace_idx ON public.order_workspace_timeline (workspace_id, created_at DESC);

ALTER TABLE public.order_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_promises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_workspace_timeline ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.order_workspaces IS 'Apollo Orders Workspace v1 durable business objects.';
COMMENT ON TABLE public.order_workspace_timeline IS 'Append-only audit timeline for Orders Workspace. No updates or deletes.';
COMMENT ON TABLE public.order_workspace_promises IS 'First-class operational promises Apollo must not forget.';

