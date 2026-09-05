-- 10000 Club: customers who were pre-registered (proto_active_customers,
-- imported from the spend CSV) get auto-approved the moment they sign up at
-- register.proto.co.za, tagged "10000 club". No customer_code is allocated —
-- codes stay a manual admin step.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];

-- Trigger fires on INSERT no matter which system writes the row (the admin
-- register-account endpoint or the register portal writing directly), so the
-- auto-approval can never be bypassed by a different signup path.
--
-- SECURITY DEFINER + explicit search_path so it resolves/reads
-- public.proto_active_customers regardless of caller context or RLS, and a
-- catch-all EXCEPTION so a convenience feature can NEVER block a signup.
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
        NULL;
      END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_approve_pre_registered ON customers;
CREATE TRIGGER trg_auto_approve_pre_registered
  BEFORE INSERT ON customers
  FOR EACH ROW EXECUTE FUNCTION auto_approve_pre_registered();
