import { createClient } from '@supabase/supabase-js';
import { verifyUnsubscribeToken } from './_brevo-email.js';

function decodeEmail(value) {
  try {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8').trim().toLowerCase();
  } catch {
    return '';
  }
}

function page({ title, message }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#101010;color:#f7f7f7;font-family:Arial,Helvetica,sans-serif;display:grid;min-height:100vh;place-items:center;"><main style="max-width:520px;padding:32px;text-align:center;"><img src="https://res.cloudinary.com/dmanxetyl/image/upload/v1785453238/Screenshot_2026-07-30_at_23.10.28_vkz8n0.png" alt="Proto Trading Online" style="width:100%;max-width:320px;height:auto;margin:0 auto 24px;display:block;"><h1 style="font-size:28px;margin:0 0 12px;">${title}</h1><p style="color:#cfcfcf;line-height:1.6;margin:0;">${message}</p></main></body></html>`;
}

function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const payload = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const email = decodeEmail(payload.e || payload.email);
  const token = String(payload.t || payload.token || '').trim();

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!email || !verifyUnsubscribeToken(email, token)) {
    return res.status(400).send(page({
      title: 'Unsubscribe link expired',
      message: 'This unsubscribe link could not be verified. Please contact Proto Trading and we will remove you from marketing emails.',
    }));
  }

  try {
    const sb = getPortalDbClient();
    const { error } = await sb.from('marketing_email_opt_outs').upsert({
      email,
      source: 'email_unsubscribe_link',
      unsubscribed_at: new Date().toISOString(),
    }, { onConflict: 'email' });
    if (error) throw error;
    return res.status(200).send(page({
      title: 'You have been unsubscribed',
      message: 'You will no longer receive Proto Trading marketing emails at this address. Important service emails, such as order updates, may still be sent when needed.',
    }));
  } catch (err) {
    console.error('email-unsubscribe:', err?.message || err);
    return res.status(500).send(page({
      title: 'Unsubscribe failed',
      message: 'We could not record the opt-out just now. Please try again or contact Proto Trading and we will remove you manually.',
    }));
  }
}
