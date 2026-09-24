/**
 * WhatsApp consent gate and audience resolver.
 *
 * This is the one place that answers "may we WhatsApp this person?", and every
 * send path goes through it — including a "selected contacts" send, where the
 * browser supplies the phone list. A stale tab could otherwise hold a number
 * that opted out five minutes ago, so the list from the client is treated as a
 * FILTER over the eligible set, never as the set itself.
 *
 * Three conditions, all required:
 *   1. customers.accept_whatsapp = true          (the opt-in the customer gave)
 *   2. the number normalizes to a valid one      (_whatsapp-phone.js)
 *   3. no row in whatsapp_opt_outs               (the opt-out outranks 1)
 */

import { createClient } from '@supabase/supabase-js';
import { normalizeWhatsappPhone } from './_whatsapp-phone.js';

const CUSTOMER_PAGE_SIZE = 1000;

export function getWhatsappDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export const VALID_WHATSAPP_AUDIENCE = new Set(['all', 'business-type', 'selected']);

/**
 * What a customer can reply to stop receiving broadcasts.
 *
 * Deliberately narrow and anchored: "stop" matches, "stop sending the red ones
 * please" matches, but "don't stop the order" does not silently unsubscribe a
 * paying customer mid-conversation.
 */
const OPT_OUT_PATTERNS = [
  /^\s*stop\b/i,
  /^\s*unsubscribe\b/i,
  /^\s*opt[\s-]?out\b/i,
  /^\s*remove me\b/i,
  /^\s*no more (messages|adverts|specials|whatsapps?)\b/i,
  // "Please stop sending me specials" — the polite form is the common one, and
  // missing it means a customer who asked nicely keeps getting broadcasts.
  /^\s*please\s+(stop|unsubscribe|remove)\b/i,
  /^\s*(please\s+)?stop\s+(sending|messaging|whatsapping|texting)\b/i,
  /^\s*(please\s+)?(stop|unsubscribe|remove)\s+(me|us)?\s*(from)?\s*(your)?\s*(list|broadcasts?|messages?|specials?)\b/i,
];

export function isOptOutMessage(text) {
  const body = String(text || '').trim();
  if (!body || body.length > 160) return false;
  return OPT_OUT_PATTERNS.some((re) => re.test(body));
}

/** Every suppressed number, as bare digits. */
export async function loadOptOutPhones(sb) {
  const phones = new Set();
  for (let from = 0; ; from += CUSTOMER_PAGE_SIZE) {
    const { data, error } = await sb
      .from('whatsapp_opt_outs')
      .select('phone')
      .range(from, from + CUSTOMER_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) {
      const phone = String(row.phone || '').replace(/\D/g, '');
      if (phone) phones.add(phone);
    }
    if ((data || []).length < CUSTOMER_PAGE_SIZE) break;
  }
  return phones;
}

/** Every customer who ticked the WhatsApp opt-in, newest first. */
async function fetchOptInCustomers(sb, { businessTypes = [] } = {}) {
  const rows = [];
  for (let from = 0; ; from += CUSTOMER_PAGE_SIZE) {
    let query = sb
      .from('customers')
      .select('id, email, phone, name, first_name, contact_name, business_name, business_type, is_approved, created_at')
      .eq('accept_whatsapp', true)
      .order('created_at', { ascending: false })
      .range(from, from + CUSTOMER_PAGE_SIZE - 1);
    if (businessTypes.length) query = query.in('business_type', businessTypes);

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < CUSTOMER_PAGE_SIZE) break;
  }
  return rows;
}

function contactNameOf(customer) {
  return customer.contact_name || customer.first_name || customer.name || '';
}

function businessNameOf(customer) {
  return customer.business_name || customer.name || '';
}

/**
 * Resolve an audience into sendable recipients plus an itemised list of who was
 * held back and why.
 *
 * The `skipped` list is the point of this function's shape: "we sent to 1 412 of
 * 1 566" is only trustworthy if the admin can see that 98 were landlines, 41
 * opted out and 15 numbers are malformed. Silently shrinking the audience is
 * how a broadcast quietly stops reaching half the list.
 *
 * @param {'all'|'business-type'|'selected'} audience
 * @param {string[]} businessTypes  filter for 'business-type'
 * @param {string[]} phones         for 'selected' — filters the eligible set
 */
export async function resolveWhatsappAudience(sb, { audience = 'all', businessTypes = [], phones = [] } = {}) {
  const types = (Array.isArray(businessTypes) ? businessTypes : []).map((t) => String(t).trim()).filter(Boolean);
  const customers = await fetchOptInCustomers(sb, {
    businessTypes: audience === 'business-type' ? types : [],
  });
  const optOuts = await loadOptOutPhones(sb);

  const requested = new Set(
    (Array.isArray(phones) ? phones : [])
      .map((p) => normalizeWhatsappPhone(p).phone)
      .filter(Boolean),
  );

  const recipients = [];
  const skipped = [];
  const seen = new Set();

  for (const customer of customers) {
    const { phone, valid, kind, reason } = normalizeWhatsappPhone(customer.phone);
    const base = {
      customerId: customer.id,
      email: String(customer.email || '').trim().toLowerCase() || null,
      contactName: contactNameOf(customer),
      businessName: businessNameOf(customer),
      businessType: customer.business_type || null,
      phone,
      phoneKind: kind,
    };

    if (!valid) {
      skipped.push({ ...base, reason: reason || 'Unusable phone number' });
      continue;
    }
    // Two customer rows can carry the same number (a business and its owner).
    // One number, one WhatsApp message.
    if (seen.has(phone)) continue;
    seen.add(phone);

    if (optOuts.has(phone)) {
      skipped.push({ ...base, reason: 'Opted out of WhatsApp' });
      continue;
    }
    if (audience === 'selected' && !requested.has(phone)) continue;

    recipients.push(base);
  }

  // A phone the browser asked for that never appeared in the eligible set is
  // worth naming: it means the contact lost consent, opted out, or was edited.
  if (audience === 'selected') {
    for (const phone of requested) {
      if (seen.has(phone)) continue;
      skipped.push({ phone, reason: 'No longer eligible (opt-in withdrawn or number changed)' });
    }
  }

  return { recipients, skipped, optOutCount: optOuts.size };
}

/**
 * Suppress a number. Idempotent — the first opt-out keeps its original
 * timestamp, because "when did they opt out" is a compliance answer and must
 * not be overwritten by a later duplicate reply.
 */
export async function recordWhatsappOptOut(sb, { phone, customerId = null, email = null, source = 'customer_reply', reason = null }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { ok: false, error: 'A phone number is required' };

  const { data: existing, error: lookupError } = await sb
    .from('whatsapp_opt_outs')
    .select('phone, opted_out_at')
    .eq('phone', digits)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return { ok: true, phone: digits, existing: true };

  const { error } = await sb.from('whatsapp_opt_outs').insert({
    phone: digits,
    customer_id: customerId,
    email: email ? String(email).trim().toLowerCase() : null,
    source,
    reason: reason ? String(reason).slice(0, 500) : null,
    opted_out_at: new Date().toISOString(),
  });
  if (error) throw error;

  // Mirror it onto the contact mirror so the Contacts screen shows the change
  // without waiting for the next sync.
  await sb
    .from('whatsapp_contacts')
    .update({ allow_broadcast: false, updated_at: new Date().toISOString() })
    .eq('phone', digits);

  return { ok: true, phone: digits, existing: false };
}

/** Remove a suppression (admin correcting a mistake, or a re-consent). */
export async function removeWhatsappOptOut(sb, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { ok: false, error: 'A phone number is required' };
  const { error } = await sb.from('whatsapp_opt_outs').delete().eq('phone', digits);
  if (error) throw error;
  await sb
    .from('whatsapp_contacts')
    .update({ allow_broadcast: true, updated_at: new Date().toISOString() })
    .eq('phone', digits);
  return { ok: true, phone: digits };
}
