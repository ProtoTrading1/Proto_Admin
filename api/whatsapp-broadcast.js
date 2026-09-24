import { requireAdminKey, verifyAdminUser } from './_admin-auth.js';
import { WatiNotConfiguredError, watiCrmConfig } from './_wati-client.js';
import { getWhatsappDbClient, VALID_WHATSAPP_AUDIENCE } from './_whatsapp-audience.js';
import { runWhatsappBroadcast } from './_whatsapp-broadcast.js';
import { formatWhatsappPhone } from './_whatsapp-phone.js';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
};

const RECIPIENT_PAGE_SIZE_MAX = 500;

/**
 * Send a WhatsApp broadcast, and read back what happened.
 *
 * POST                 → send (or `dryRun: true` to count the audience first)
 * GET                  → broadcast history
 * GET ?id=<broadcast>  → one broadcast: funnel counts + per-recipient rows
 *
 * The audience is always re-resolved server-side. The browser may narrow the
 * send with a phone list, but it can never widen it past the consent gate.
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const sb = getWhatsappDbClient();

  if (req.method === 'GET') {
    const broadcastId = String(req.query.id || '').trim();
    try {
      if (broadcastId) return res.status(200).json(await readBroadcastDetail(sb, req, broadcastId));
      return res.status(200).json(await readBroadcastHistory(sb, req));
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status === 500) console.error('whatsapp-broadcast GET:', err?.message || err);
      return res.status(status).json({ error: err.message || 'Failed to load broadcasts' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const audience = String(body.audience || 'all').trim();
  if (!VALID_WHATSAPP_AUDIENCE.has(audience)) {
    return res.status(400).json({ error: 'Choose everyone, a business type, or specific contacts.' });
  }
  const dryRun = body.dryRun === true;

  const templateName = String(body.templateName || '').trim();
  if (!dryRun && !templateName) {
    return res.status(400).json({ error: 'Choose an approved WhatsApp template.' });
  }

  const { configured } = watiCrmConfig();
  if (!configured && !dryRun) {
    return res.status(503).json({ error: 'WATI is not connected. Set WATI_API_TOKEN in Vercel first.' });
  }

  // Template parameters arrive keyed by position ('1', '2', …) — that is what
  // WhatsApp's {{1}} placeholders are. Anything else is ignored rather than
  // guessed at, so a malformed payload cannot smuggle a body past the template.
  const parameters = {};
  for (const [key, value] of Object.entries(body.parameters || {})) {
    if (/^\d+$/.test(key)) parameters[key] = String(value ?? '').slice(0, 1000);
  }

  const trackedUrl = String(body.trackedUrl || '').trim();
  if (trackedUrl && !/^https:\/\/[^\s]+$/i.test(trackedUrl)) {
    return res.status(400).json({ error: 'The tracked link must be a full https:// URL.' });
  }

  try {
    const user = await verifyAdminUser(req);
    const outcome = await runWhatsappBroadcast(sb, {
      audience,
      businessTypes: Array.isArray(body.businessTypes) ? body.businessTypes : [],
      phones: Array.isArray(body.phones) ? body.phones : [],
      templateName,
      templateLanguage: body.templateLanguage || null,
      templateBody: body.templateBody || '',
      broadcastName: body.broadcastName || '',
      parameters,
      trackedUrl,
      createdBy: user?.email || 'admin',
      dryRun,
    });

    if (!outcome.ok && !outcome.total) return res.status(400).json(outcome);
    return res.status(outcome.failed ? 207 : 200).json(outcome);
  } catch (err) {
    if (err instanceof WatiNotConfiguredError) return res.status(503).json({ error: err.message });
    console.error('whatsapp-broadcast POST:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Broadcast failed' });
  }
}

async function readBroadcastHistory(sb, req) {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize || '25'), 10) || 25));

  const { data, error, count } = await sb
    .from('whatsapp_broadcasts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;

  return {
    rows: (data || []).map(shapeBroadcast),
    total: count || 0,
    page,
    pageSize,
  };
}

/**
 * Recompute the funnel from the recipient rows rather than trusting the
 * counters on the broadcast. Delivery webhooks arrive for minutes or hours
 * after the send, and a counter that is only written at send time would show
 * "0 read" forever.
 */
async function readBroadcastDetail(sb, req, broadcastId) {
  const { data: broadcast, error } = await sb
    .from('whatsapp_broadcasts')
    .select('*')
    .eq('id', broadcastId)
    .maybeSingle();
  if (error) throw error;
  if (!broadcast) {
    const notFound = new Error('That broadcast no longer exists.');
    notFound.statusCode = 404;
    throw notFound;
  }

  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(RECIPIENT_PAGE_SIZE_MAX, Math.max(1, Number.parseInt(String(req.query.pageSize || '100'), 10) || 100));
  const statusFilter = String(req.query.status || '').trim();
  const clickedOnly = String(req.query.clicked || '') === 'true';

  let query = sb
    .from('whatsapp_messages')
    .select('phone, contact_name, business_name, email, status, error, sent_at, delivered_at, read_at, replied_at, click_count, first_clicked_at, last_clicked_at', { count: 'exact' })
    .eq('broadcast_id', broadcastId)
    .eq('direction', 'out')
    .order('click_count', { ascending: false })
    .order('read_at', { ascending: false, nullsFirst: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (statusFilter) query = query.eq('status', statusFilter);
  if (clickedOnly) query = query.gt('click_count', 0);

  const [recipientsResult, funnel] = await Promise.all([
    query,
    readFunnel(sb, broadcastId),
  ]);
  if (recipientsResult.error) throw recipientsResult.error;

  return {
    broadcast: { ...shapeBroadcast(broadcast), funnel },
    recipients: (recipientsResult.data || []).map((row) => ({
      phone: row.phone,
      phoneDisplay: formatWhatsappPhone(row.phone),
      contactName: row.contact_name,
      businessName: row.business_name,
      email: row.email,
      status: row.status,
      error: row.error,
      sentAt: row.sent_at,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
      repliedAt: row.replied_at,
      clickCount: row.click_count || 0,
      firstClickedAt: row.first_clicked_at,
      lastClickedAt: row.last_clicked_at,
    })),
    total: recipientsResult.count || 0,
    page,
    pageSize,
  };
}

/** Exact counts per stage, via count-only queries (no row transfer). */
async function readFunnel(sb, broadcastId) {
  const base = () => sb
    .from('whatsapp_messages')
    .select('phone', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('direction', 'out');

  const [targeted, sent, delivered, read, replied, failed, clicked] = await Promise.all([
    base(),
    base().in('status', ['sent', 'delivered', 'read']),
    base().not('delivered_at', 'is', null),
    base().not('read_at', 'is', null),
    base().not('replied_at', 'is', null),
    base().eq('status', 'failed'),
    base().gt('click_count', 0),
  ]);

  return {
    targeted: targeted.count || 0,
    sent: sent.count || 0,
    delivered: delivered.count || 0,
    read: read.count || 0,
    replied: replied.count || 0,
    failed: failed.count || 0,
    clicked: clicked.count || 0,
  };
}

function shapeBroadcast(row) {
  const filter = row.audience_filter || {};
  return {
    id: row.id,
    name: row.broadcast_name,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    bodyPreview: row.body_preview,
    audience: filter.audience || 'all',
    businessTypes: filter.businessTypes || [],
    trackedUrl: row.tracked_url,
    status: row.status,
    error: row.error,
    targeted: row.total_targeted || 0,
    sent: row.count_sent || 0,
    failed: row.count_failed || 0,
    skipped: row.count_skipped || 0,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
