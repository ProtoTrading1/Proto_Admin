/**
 * Per-customer "last email sent" status (migration 042).
 *
 * Every path that emails a customer calls markCustomerEmailed so Customer
 * Management can show what the last touch was and when. Best-effort: a failure
 * here (e.g. the column not migrated yet, or the email not matching a customer
 * row) must never break the actual email send.
 */

export const CUSTOMER_EMAIL_TYPES = {
  welcome: 'Welcome / approval',
  campaign: 'Campaign',
  order_confirmation: 'Order confirmation',
  trade_application: 'Trade application',
};

export function customerEmailTypeLabel(type) {
  return CUSTOMER_EMAIL_TYPES[type] || (type ? String(type) : '');
}

/**
 * Stamp last_email_type / last_email_at on the matching customer row.
 * Match by id when given, else by case-insensitive email. `at` lets a caller
 * pass a deterministic timestamp; defaults to now.
 */
export async function markCustomerEmailed(supabase, { id = null, email = null, type, at = null } = {}) {
  if (!supabase || !type) return { ok: false, reason: 'missing_args' };
  const patch = { last_email_type: type, last_email_at: at || new Date().toISOString() };
  try {
    let query = supabase.from('customers').update(patch);
    if (id) query = query.eq('id', id);
    else if (email) query = query.ilike('email', String(email).trim());
    else return { ok: false, reason: 'no_selector' };
    const { error } = await query;
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message || 'update_failed' };
  }
}

/** Stamp many customers by email in one pass (best-effort, chunked). */
export async function markCustomersEmailed(supabase, emails, type, at = null) {
  const list = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!supabase || !type || !list.length) return { ok: false, updated: 0 };
  const stamp = at || new Date().toISOString();
  let updated = 0;
  const CHUNK = 200;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    try {
      const { error } = await supabase
        .from('customers')
        .update({ last_email_type: type, last_email_at: stamp })
        .in('email', slice);
      if (!error) updated += slice.length;
    } catch { /* best effort */ }
  }
  return { ok: true, updated };
}

/**
 * Stamp CRM contacts as well as portal customers. Group members and imported
 * leads intentionally do not have rows in `customers`, so updating only that
 * table makes successful broadcasts invisible in Email CRM.
 */
export async function markCrmContactsEmailed(supabase, emails, campaignName, at = null) {
  const list = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!supabase || !campaignName || !list.length) return { ok: false, updated: 0 };
  const stamp = at || new Date().toISOString();
  let updated = 0;
  const CHUNK = 200;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    try {
      const { error } = await supabase
        .from('crm_contacts')
        .update({ last_campaign_name: String(campaignName).trim(), last_sent_at: stamp })
        .in('email', slice);
      if (!error) updated += slice.length;
    } catch { /* analytics must never break a successful send */ }
  }
  return { ok: true, updated };
}
