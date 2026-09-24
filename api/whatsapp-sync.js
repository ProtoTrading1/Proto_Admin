import { requireCronOrAdminKey } from './_admin-auth.js';
import {
  WatiNotConfiguredError,
  watiCrmConfig,
  watiListContacts,
  watiUpsertContact,
} from './_wati-client.js';
import {
  getWhatsappDbClient,
  recordWhatsappOptOut,
  resolveWhatsappAudience,
} from './_whatsapp-audience.js';

export const config = { maxDuration: 300 };

/**
 * Two-way contact sync between the portal's consented customers and WATI.
 *
 * Push: every customer with accept_whatsapp = true and a usable number becomes
 * a WATI contact. Customers who never ticked the box are never pushed — WATI
 * only ever holds people who agreed to be there.
 *
 * Pull: a customer who opts out inside WhatsApp (tapping "Stop promotions", or
 * telling WATI's own flow to stop) has allowBroadcast flipped in WATI and
 * nothing in our database. Reading it back is the only way that opt-out reaches
 * the suppression list, so the pull half is not optional.
 *
 * Runs on a cron; the Sync button in the admin calls the same handler.
 */

// A cold start with ~1 500 contacts cannot push them all inside one function
// invocation, so each run takes a bounded slice, oldest-synced first, and the
// cron finishes the list over the following runs.
const PUSH_LIMIT_PER_RUN = 250;
const PUSH_CONCURRENCY = 5;

async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export default async function handler(req, res) {
  if (!(await requireCronOrAdminKey(req, res))) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const { configured } = watiCrmConfig();
  if (!configured) {
    return res.status(503).json({
      error: 'WATI is not connected. Set WATI_API_TOKEN in Vercel, then run the sync again.',
      configured: false,
    });
  }

  const syncedAt = new Date().toISOString();
  const sb = getWhatsappDbClient();

  try {
    const { recipients, skipped } = await resolveWhatsappAudience(sb, { audience: 'all' });

    // 1. Mirror the eligible set locally first. Even if WATI is slow or
    //    rate-limits us, the admin screens stay accurate.
    const mirrorRows = recipients.map((r) => ({
      phone: r.phone,
      customer_id: r.customerId,
      email: r.email,
      contact_name: r.contactName,
      business_name: r.businessName,
      business_type: r.businessType,
      phone_kind: r.phoneKind,
      accept_whatsapp: true,
      is_team: false,
      updated_at: syncedAt,
    }));
    for (let i = 0; i < mirrorRows.length; i += 500) {
      const { error } = await sb
        .from('whatsapp_contacts')
        .upsert(mirrorRows.slice(i, i + 500), { onConflict: 'phone' });
      if (error) throw error;
    }

    // A customer who untick the opt-in, or whose number stopped being usable,
    // must lose its eligible flag here or it would linger as a synced contact.
    const eligiblePhones = new Set(recipients.map((r) => r.phone));
    const { data: mirrored } = await sb
      .from('whatsapp_contacts')
      .select('phone, sync_status, wati_synced_at, accept_whatsapp')
      .eq('is_team', false);
    const staleMirror = (mirrored || [])
      .filter((row) => row.accept_whatsapp && !eligiblePhones.has(row.phone))
      .map((row) => row.phone);
    for (let i = 0; i < staleMirror.length; i += 500) {
      await sb
        .from('whatsapp_contacts')
        .update({ accept_whatsapp: false, sync_status: 'pending', updated_at: syncedAt })
        .in('phone', staleMirror.slice(i, i + 500));
    }

    // 2. Push a bounded slice to WATI, never-synced numbers first.
    const syncedByPhone = new Map((mirrored || []).map((row) => [row.phone, row]));
    const pushQueue = recipients
      .slice()
      .sort((a, b) => {
        const left = syncedByPhone.get(a.phone)?.wati_synced_at || '';
        const right = syncedByPhone.get(b.phone)?.wati_synced_at || '';
        return String(left).localeCompare(String(right));
      })
      .slice(0, PUSH_LIMIT_PER_RUN);

    let pushed = 0;
    let pushFailed = 0;
    const pushErrors = [];

    await mapWithConcurrency(pushQueue, PUSH_CONCURRENCY, async (recipient) => {
      let patch;
      try {
        const result = await watiUpsertContact(recipient.phone, {
          name: recipient.contactName || recipient.businessName || 'Customer',
          customParams: [
            { name: 'business_name', value: recipient.businessName || '' },
            { name: 'contact_name', value: recipient.contactName || '' },
            { name: 'business_type', value: recipient.businessType || '' },
            { name: 'email', value: recipient.email || '' },
            { name: 'source', value: 'proto_portal' },
          ],
        });
        if (result.ok) {
          pushed += 1;
          patch = {
            sync_status: 'synced',
            sync_error: null,
            wati_contact_id: result.contact?.id || null,
            allow_broadcast: result.contact?.allowBroadcast ?? true,
            wati_synced_at: syncedAt,
            updated_at: syncedAt,
          };
        } else {
          pushFailed += 1;
          if (pushErrors.length < 20) pushErrors.push({ phone: recipient.phone, error: result.error });
          patch = {
            sync_status: /not a whatsapp number/i.test(result.error || '') ? 'not_whatsapp' : 'failed',
            sync_error: String(result.error || '').slice(0, 300),
            wati_synced_at: syncedAt,
            updated_at: syncedAt,
          };
        }
      } catch (err) {
        pushFailed += 1;
        if (pushErrors.length < 20) pushErrors.push({ phone: recipient.phone, error: err?.message || 'Push failed' });
        patch = {
          sync_status: 'failed',
          sync_error: String(err?.message || 'Push failed').slice(0, 300),
          updated_at: syncedAt,
        };
      }
      await sb.from('whatsapp_contacts').update(patch).eq('phone', recipient.phone);
    });

    // 3. Pull WATI's own view back, so an in-WhatsApp opt-out reaches the
    //    suppression list.
    let watiContacts = [];
    let pullError = null;
    try {
      watiContacts = await watiListContacts();
    } catch (err) {
      pullError = err?.message || 'Could not read the WATI contact list';
    }

    let newOptOuts = 0;
    for (const contact of watiContacts) {
      if (contact.allowBroadcast !== false && contact.optedIn !== false) continue;
      if (!eligiblePhones.has(contact.phone)) continue;
      try {
        const result = await recordWhatsappOptOut(sb, {
          phone: contact.phone,
          source: 'wati_contact_sync',
          reason: 'Broadcasts switched off on the WATI contact',
        });
        if (result.ok && !result.existing) newOptOuts += 1;
      } catch (err) {
        console.error('whatsapp-sync opt-out:', err?.message || err);
      }
    }

    return res.status(200).json({
      ok: true,
      syncedAt,
      eligible: recipients.length,
      blocked: skipped.length,
      pushedThisRun: pushed,
      pushFailed,
      pushErrors,
      pushQueueRemaining: Math.max(0, recipients.length - PUSH_LIMIT_PER_RUN),
      watiContactsRead: watiContacts.length,
      newOptOutsFromWati: newOptOuts,
      deactivatedLocally: staleMirror.length,
      pullError,
    });
  } catch (err) {
    if (err instanceof WatiNotConfiguredError) {
      return res.status(503).json({ error: err.message, configured: false });
    }
    console.error('whatsapp-sync:', err?.message || err);
    return res.status(500).json({ error: err.message || 'WhatsApp contact sync failed' });
  }
}
