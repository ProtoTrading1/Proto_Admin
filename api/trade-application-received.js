import { createClient } from '@supabase/supabase-js';
import { requireTradeRegisterOrAdmin } from './_admin-auth.js';
import { sendBrevoTransactional } from './_brevo-email.js';
import { markCustomerEmailed } from './_customer-email-status.js';
import { buildTradeApplicationEmail } from '../lib/trade-application-email.mjs';

/**
 * Send trade-application acknowledgment email (Brevo).
 * Called by register.proto.co.za / site.proto.co.za after a trade signup.
 *
 * POST { email, name?, businessName? }
 * Auth: x-trade-register-secret (TRADE_REGISTER_SECRET or ORDER_NOTIFY_SECRET) or admin JWT
 */
export default async function handler(req, res) {
  if (!(await requireTradeRegisterOrAdmin(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const businessName = String(req.body?.businessName || req.body?.business_name || '').trim();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  if (!process.env.BREVO_API_KEY) {
    return res.status(503).json({ error: 'BREVO_API_KEY is not configured' });
  }

  try {
    const { subject, html, text, greeting } = buildTradeApplicationEmail({ email, name, businessName });
    await sendBrevoTransactional({
      to: { email, name: greeting || email },
      subject,
      htmlContent: html,
      textContent: text,
    });
    try {
      const sb = createClient(
        process.env.VITE_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      await markCustomerEmailed(sb, { email, type: 'trade_application' });
    } catch { /* best effort */ }
    return res.status(200).json({ ok: true, sent: true, email });
  } catch (err) {
    console.error('trade-application-received:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to send acknowledgment email' });
  }
}
