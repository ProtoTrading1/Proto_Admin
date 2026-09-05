-- 054: Auto-approval requires a REAL pre-registered account, not just an email.
--
-- Bug: eduv9269101@vossie.net signed up and was auto-approved into the "10000
-- club" without ever being pre-registered.
--
-- Cause: the app and the database disagreed about what "pre-registered" means.
-- api/_customer-onboard.js (isVerifiedProtoActiveMatch) requires a NON-EMPTY
-- proto_active_customers.account_code, so the JS path correctly declined. The
-- BEFORE INSERT trigger from 040/041 only checked that the email EXISTED in
-- proto_active_customers — and that address had a row with account_code = ''.
-- The trigger fires on every insert, so it won regardless of what the app
-- decided.
--
-- Rule (from the business): if a customer is not on the pre-registration list
-- they do NOT get automatically approved. A row with a blank account_code is
-- not a pre-registration.
--
-- This migration is the checked-in form of a fix already applied to the portal
-- database; it is idempotent and safe to re-run.

CREATE OR REPLACE FUNCTION public.auto_approve_pre_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF NEW.email IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.proto_active_customers p
      WHERE lower(p.email) = lower(NEW.email)
        -- Must be a REAL pre-registered account, not a placeholder row.
        AND coalesce(btrim(p.account_code), '') <> ''
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
    -- Never let auto-approval block account creation.
    NULL;
  END;
  RETURN NEW;
END;
$function$;

-- Revoke approvals the old trigger granted on a blank-account_code row. Only
-- touches accounts whose allowlist entry has no account code, so genuine
-- pre-registered members and admin-approved customers are untouched.
UPDATE public.customers c
   SET is_approved = false,
       tags = array_remove(coalesce(c.tags, '{}'::text[]), '10000 club')
  FROM public.proto_active_customers p
 WHERE lower(p.email) = lower(c.email)
   AND coalesce(btrim(p.account_code), '') = ''
   AND c.is_approved IS TRUE;
