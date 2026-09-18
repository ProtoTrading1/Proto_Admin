/**
 * Instore review is deliberately test-branch-only until the storefront and
 * checkout contract exists.  Do not relax this guard by copying production
 * STOCK_SUPABASE_* values into a preview deployment.
 */
export function getInstorePreviewSafety(env = process.env) {
  if (env.INSTORE_ADMIN_PREVIEW_ONLY !== 'true') {
    return { ok: false, error: 'Instore admin is disabled: preview-only mode is required.' };
  }
  if (String(env.VERCEL_ENV || '').toLowerCase() === 'production') {
    return { ok: false, error: 'Instore admin preview cannot run in a production deployment.' };
  }

  const ref = String(env.INSTORE_ADMIN_TEST_PROJECT_REF || '').trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(ref)) {
    return { ok: false, error: 'Instore admin is disabled: a test project ref is required.' };
  }

  // Deliberately do not fall back to VITE_STOCK_SUPABASE_URL. That variable
  // could be a production value embedded for another part of the dashboard.
  const rawUrl = String(env.STOCK_SUPABASE_POOLER_URL || env.STOCK_SUPABASE_URL || '').trim();
  if (!rawUrl) return { ok: false, error: 'Instore admin is disabled: a server-only test database URL is required.' };
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== `${ref}.supabase.co`) {
      return { ok: false, error: 'Instore admin is disabled: the database URL does not match the named test branch.' };
    }
  } catch {
    return { ok: false, error: 'Instore admin is disabled: the test database URL is invalid.' };
  }
  if (!String(env.STOCK_SUPABASE_KEY || '').trim()) {
    return { ok: false, error: 'Instore admin is disabled: a server-only test database key is required.' };
  }
  return {
    ok: true,
    projectRef: ref,
    // This is intentionally opt-in. A connected Preview remains read-only
    // unless its exact branch is configured for disposable workflow testing.
    allowTestWrites: env.INSTORE_ADMIN_TEST_WRITES === 'true',
  };
}
