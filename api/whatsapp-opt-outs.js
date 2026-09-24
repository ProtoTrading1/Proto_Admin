import { requireAdminKey, requireOwner } from './_admin-auth.js';
import {
  getWhatsappDbClient,
  recordWhatsappOptOut,
  removeWhatsappOptOut,
} from './_whatsapp-audience.js';
import { formatWhatsappPhone, normalizeWhatsappPhone } from './_whatsapp-phone.js';

/**
 * The WhatsApp suppression list.
 *
 * GET    → paginated opt-outs, enriched with the customer behind the number
 * POST   → suppress a number (admin acting on a phoned-in or emailed request)
 * DELETE → lift a suppression. Owner-only: re-subscribing someone who asked to
 *          be left alone is the one action here that can cause real harm, so it
 *          is not something the customer-service role can do by mistake.
 */

const PAGE_SIZE_MAX = 200;

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const sb = getWhatsappDbClient();

  if (req.method === 'POST') {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

    const { phone, valid, reason } = normalizeWhatsappPhone(body.phone);
    if (!valid) return res.status(400).json({ error: reason || 'Enter a valid WhatsApp number' });

    try {
      const result = await recordWhatsappOptOut(sb, {
        phone,
        customerId: body.customerId || null,
        email: body.email || null,
        source: 'admin',
        reason: body.reason || 'Added by an admin',
      });
      return res.status(result.existing ? 200 : 201).json(result);
    } catch (err) {
      console.error('whatsapp-opt-outs POST:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Could not add this opt-out' });
    }
  }

  if (req.method === 'DELETE') {
    if (!(await requireOwner(req, res))) return;
    const raw = req.query?.phone || (typeof req.body === 'object' ? req.body?.phone : '');
    const { phone, valid, reason } = normalizeWhatsappPhone(raw);
    if (!valid) return res.status(400).json({ error: reason || 'Enter a valid WhatsApp number' });
    try {
      return res.status(200).json(await removeWhatsappOptOut(sb, phone));
    } catch (err) {
      console.error('whatsapp-opt-outs DELETE:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Could not remove this opt-out' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).end();
  }

  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.parseInt(String(req.query.pageSize || '50'), 10) || 50));
  const search = String(req.query.search || '').trim().toLowerCase();

  try {
    const { data, error, count } = await sb
      .from('whatsapp_opt_outs')
      .select('phone, email, source, reason, opted_out_at, customer_id', { count: 'exact' })
      .order('opted_out_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;

    const rows = data || [];
    let namesByPhone = new Map();
    if (rows.length) {
      const ids = rows.map((r) => r.customer_id).filter(Boolean);
      if (ids.length) {
        const { data: customers } = await sb
          .from('customers')
          .select('id, business_name, name, contact_name, first_name, email')
          .in('id', ids);
        namesByPhone = new Map((customers || []).map((c) => [c.id, c]));
      }
    }

    const enriched = rows.map((row) => {
      const customer = namesByPhone.get(row.customer_id) || {};
      return {
        phone: row.phone,
        phoneDisplay: formatWhatsappPhone(row.phone),
        email: row.email || customer.email || null,
        businessName: customer.business_name || customer.name || null,
        contactName: customer.contact_name || customer.first_name || null,
        source: row.source,
        reason: row.reason,
        optedOutAt: row.opted_out_at,
      };
    }).filter((row) => !search || [row.phone, row.email, row.businessName, row.contactName]
      .some((value) => String(value || '').toLowerCase().includes(search)));

    return res.status(200).json({ rows: enriched, total: count || 0, page, pageSize });
  } catch (err) {
    console.error('whatsapp-opt-outs:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load WhatsApp opt-outs' });
  }
}
