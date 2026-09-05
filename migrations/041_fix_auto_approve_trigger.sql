-- HOTFIX for migration 040: the auto-approve trigger could raise inside the
-- signup flow (unqualified table name resolved under the auth flow's
-- search_path, and/or RLS on proto_active_customers), which surfaced to users
-- as "Database error creating new user" and blocked account creation.
--
-- This hardens the function so it:
--   1. runs SECURITY DEFINER with an explicit search_path (resolves + reads
--      public.proto_active_customers regardless of caller context / RLS), and
--   2. swallows ANY error — auto-approval is a convenience and must never
--      block a signup.

CREATE OR REPLACE FUNCTION auto_approve_pre_registered()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.email IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.proto_active_customers p
      WHERE lower(p.email) = lower(NEW.email)
    ) THEN
      NEW.is_approved := true;
      BEGIN
        IF NOT (coalesce(NEW.tags, '{}'::text[]) @> ARRAY['10000 club']) THEN
          NEW.tags := array_append(coalesce(NEW.tags, '{}'::text[]), '10000 club');
        END IF;
      EXCEPTION WHEN undefined_column THEN
        -- tags column not present yet — approval alone is enough.
        NULL;
      END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never let auto-approval block account creation.
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_approve_pre_registered ON customers;
CREATE TRIGGER trg_auto_approve_pre_registered
  BEFORE INSERT ON customers
  FOR EACH ROW EXECUTE FUNCTION auto_approve_pre_registered();
