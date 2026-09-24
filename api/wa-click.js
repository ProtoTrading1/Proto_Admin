import { getWhatsappDbClient } from './_whatsapp-audience.js';

/**
 * Tracked-link redirect for WhatsApp broadcasts.
 *
 * WhatsApp reports delivered and read, but it does NOT report link clicks —
 * there is no "who clicked" webhook. So a broadcast that needs click analytics
 * sends each recipient their own short link through here; we count the click and
 * bounce them to the real destination.
 *
 * Deliberately public: the person following the link is a customer with no admin
 * session. The token is the only credential, it identifies one recipient of one
 * broadcast, and it grants nothing except this redirect.
 *
 * Not an open redirect — the destination comes from the broadcast row an admin
 * created, never from the request.
 */

const FALLBACK_DESTINATION = (process.env.WHATSAPP_CLICK_FALLBACK_URL || 'https://proto.co.za').replace(/\/$/, '');

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end();
  }

  // Never cached: a cached 302 would hide every click after the first, and a
  // shared CDN cache could send one customer to another's destination.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const token = String(req.query?.t || '').trim();
  if (!token || token.length > 64) return res.redirect(302, FALLBACK_DESTINATION);

  try {
    const sb = getWhatsappDbClient();
    const { data, error } = await sb.rpc('whatsapp_register_click', { p_token: token });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    const destination = String(row?.tracked_url || '').trim();

    if (row) {
      // Best-effort audit trail. A failure here must not cost the customer
      // their redirect, so it is not awaited into the error path.
      sb.from('whatsapp_webhook_events').insert({
        event_type: 'clicked',
        phone: row.phone || null,
        broadcast_id: row.broadcast_id || null,
        link: destination || null,
        payload: { source: 'wa-click', userAgent: String(req.headers['user-agent'] || '').slice(0, 300) },
      }).then(() => {}, (err) => console.error('wa-click: event log failed:', err?.message || err));
    }

    // An https-only guard, so a bad row can never bounce a customer to
    // javascript: or data:.
    if (/^https:\/\//i.test(destination)) return res.redirect(302, destination);
    return res.redirect(302, FALLBACK_DESTINATION);
  } catch (err) {
    // A customer who clicked a link should land somewhere useful even when our
    // analytics are broken.
    console.error('wa-click:', err?.message || err);
    return res.redirect(302, FALLBACK_DESTINATION);
  }
}
