import { createClient } from '@supabase/supabase-js';

export const SITE_CONFIG_BUCKET = 'site-config';

export function getPortalAdminClient() {
  const url = process.env.VITE_SUPABASE_URL;
  // Prefer Supabase's current server-only secret keys while retaining the
  // legacy service-role variable during a controlled credential migration.
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export async function readSiteConfigJson(file, fallback = {}, { cacheNonce = null } = {}) {
  try {
    const supabase = getPortalAdminClient();
    const { data, error } = await supabase.storage
      .from(SITE_CONFIG_BUCKET)
      .download(file, cacheNonce == null ? {} : { cacheNonce: String(cacheNonce) }, { cache: 'no-store' });
    if (error) return fallback;
    const text = await data.text();
    if (!String(text || '').trim()) return fallback;
    try {
      return JSON.parse(text);
    } catch {
      console.warn(`readSiteConfigJson: invalid JSON in ${file}`);
      return fallback;
    }
  } catch (err) {
    console.warn(`readSiteConfigJson: ${file}`, err?.message || err);
    return fallback;
  }
}

export async function writeSiteConfigJson(file, payload) {
  const supabase = getPortalAdminClient();
  await supabase.storage.createBucket(SITE_CONFIG_BUCKET, { public: false }).catch(() => {});
  const body = JSON.stringify({ ...payload, updatedAt: new Date().toISOString() });
  const { error } = await supabase.storage.from(SITE_CONFIG_BUCKET).upload(file, body, {
    contentType: 'application/json',
    cacheControl: '0',
    upsert: true,
  });
  if (error) throw error;
  return JSON.parse(body);
}

function notifyLogFile(orderId) {
  return `orders/notify/${orderId}.json`;
}

export async function readOrderNotifyLog(orderId) {
  if (!orderId) return null;
  const data = await readSiteConfigJson(notifyLogFile(orderId), null);
  if (!data) return null;
  return data.orderId === orderId || data.sent != null ? data : null;
}

export async function writeOrderNotifyLog(orderId, payload) {
  if (!orderId) return null;
  return writeSiteConfigJson(notifyLogFile(orderId), { orderId: String(orderId), ...payload });
}
