import { createClient } from '@supabase/supabase-js';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';

export function confirmationMetaPath(orderId) {
  return `orders/confirmation/${orderId}.json`;
}

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

let _hasConfirmationSentAtColumn = null;

/** Cached probe — true when orders.confirmation_sent_at exists. */
export async function ordersHasConfirmationSentAt(supabase = getAdminClient()) {
  if (_hasConfirmationSentAtColumn != null) return _hasConfirmationSentAtColumn;
  const { error } = await supabase.from('orders').select('confirmation_sent_at').limit(1);
  if (error) {
    _hasConfirmationSentAtColumn = false;
    return false;
  }
  _hasConfirmationSentAtColumn = true;
  return true;
}

export function resetConfirmationSentAtColumnCache() {
  _hasConfirmationSentAtColumn = null;
}

export async function readOrderConfirmationSent(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return null;

  const supabase = getAdminClient();
  if (await ordersHasConfirmationSentAt(supabase)) {
    const { data } = await supabase
      .from('orders')
      .select('confirmation_sent_at')
      .eq('id', id)
      .maybeSingle();
    if (data?.confirmation_sent_at) {
      return { orderId: id, sentAt: data.confirmation_sent_at };
    }
  }

  const stored = await readSiteConfigJson(confirmationMetaPath(id), null);
  if (!stored) return null;
  return stored.orderId === id || stored.sentAt
    ? { orderId: id, sentAt: stored.sentAt || stored.updatedAt }
    : null;
}

/** Write site-config marker and orders.confirmation_sent_at when the column exists. */
export async function markOrderConfirmationSent(orderId, { sentAt = new Date().toISOString() } = {}) {
  const id = String(orderId || '').trim();
  if (!id) throw new Error('orderId required');

  const meta = { orderId: id, sentAt, updatedAt: sentAt };
  await writeSiteConfigJson(confirmationMetaPath(id), meta);

  const supabase = getAdminClient();
  if (await ordersHasConfirmationSentAt(supabase)) {
    const { error } = await supabase
      .from('orders')
      .update({ confirmation_sent_at: sentAt })
      .eq('id', id);
    if (error) throw error;
  }

  return meta;
}
