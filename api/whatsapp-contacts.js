import { requireAdminKey } from './_admin-auth.js';
import { getWhatsappDbClient, resolveWhatsappAudience } from './_whatsapp-audience.js';
import { formatWhatsappPhone } from './_whatsapp-phone.js';

/**
 * The WhatsApp CRM contact list.
 *
 * Built from the SAME resolver the send path uses, so what the admin sees is
 * exactly who a broadcast would reach — a separate query here would eventually
 * drift and the counts would start lying.
 *
 * GET ?filter=sendable|blocked|all&business_type=&search=&page=&pageSize=
 */

const PAGE_SIZE_MAX = 200;

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.parseInt(String(req.query.pageSize || '50'), 10) || 50));
  const filter = ['sendable', 'blocked', 'all'].includes(String(req.query.filter || ''))
    ? String(req.query.filter)
    : 'sendable';
  const businessType = String(req.query.business_type || '').trim();
  const search = String(req.query.search || '').trim().toLowerCase();

  try {
    const sb = getWhatsappDbClient();
    const { recipients, skipped } = await resolveWhatsappAudience(sb, {
      audience: businessType ? 'business-type' : 'all',
      businessTypes: businessType ? [businessType] : [],
    });

    const sendable = recipients.map((r) => ({ ...r, sendable: true, blockedReason: null }));
    const blocked = skipped.map((r) => ({ ...r, sendable: false, blockedReason: r.reason || 'Not reachable' }));
    const pool = filter === 'sendable' ? sendable : filter === 'blocked' ? blocked : [...sendable, ...blocked];

    const matched = search
      ? pool.filter((r) => [r.businessName, r.contactName, r.email, r.phone]
        .some((value) => String(value || '').toLowerCase().includes(search)))
      : pool;

    const from = (page - 1) * pageSize;
    const pageRows = matched.slice(from, from + pageSize);

    // Sync state comes from the mirror table, and only for the rows on screen.
    let syncByPhone = new Map();
    if (pageRows.length) {
      const { data } = await sb
        .from('whatsapp_contacts')
        .select('phone, sync_status, sync_error, wati_synced_at, allow_broadcast, last_broadcast_at, last_outbound_status')
        .in('phone', pageRows.map((r) => r.phone).filter(Boolean));
      syncByPhone = new Map((data || []).map((row) => [row.phone, row]));
    }

    return res.status(200).json({
      rows: pageRows.map((r) => {
        const sync = syncByPhone.get(r.phone) || {};
        return {
          customerId: r.customerId,
          phone: r.phone,
          phoneDisplay: formatWhatsappPhone(r.phone),
          phoneKind: r.phoneKind,
          email: r.email,
          contactName: r.contactName,
          businessName: r.businessName,
          businessType: r.businessType,
          sendable: r.sendable,
          blockedReason: r.blockedReason,
          syncStatus: sync.sync_status || 'pending',
          syncError: sync.sync_error || null,
          watiSyncedAt: sync.wati_synced_at || null,
          allowBroadcast: sync.allow_broadcast ?? null,
          lastBroadcastAt: sync.last_broadcast_at || null,
        };
      }),
      total: matched.length,
      page,
      pageSize,
      counts: {
        sendable: sendable.length,
        blocked: blocked.length,
        optedOut: blocked.filter((r) => r.blockedReason === 'Opted out of WhatsApp').length,
        unusableNumber: blocked.filter((r) => r.blockedReason !== 'Opted out of WhatsApp').length,
      },
    });
  } catch (err) {
    console.error('whatsapp-contacts:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load WhatsApp contacts' });
  }
}
