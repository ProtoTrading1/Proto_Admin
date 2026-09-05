import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { isAdminEmail } from './_admin-auth.js';
import { signResetToken, verifyResetTokenRaw } from './_reset-token.js';

// Reset links are short-lived and single-use. 15 minutes is plenty for a real
// recovery and small enough to blunt link interception.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Signing secret for reset tokens. Requires a dedicated env var and FAILS CLOSED
 * (returns undefined) if none is set — it deliberately does NOT fall back to the
 * Supabase service-role key, so a misconfiguration surfaces as "Server
 * misconfigured" rather than silently signing tokens with the DB master key.
 */
export function getResetSecret() {
  return process.env.ADMIN_RESET_TOKEN_SECRET || process.env.RESET_TOKEN_SECRET || undefined;
}

export function makeResetToken(email, secret, tokenVersion = 0, ttlMs = DEFAULT_TTL_MS) {
  return signResetToken({ email, v: tokenVersion, scope: 'admin' }, secret, ttlMs);
}

/** Returns { email, v } on success; throws on any tamper/expiry/scope failure. */
export function verifyResetToken(token, secret) {
  const data = verifyResetTokenRaw(token, secret);
  if (data.scope !== 'admin') throw new Error('Invalid reset link');
  const email = String(data.email || '').trim().toLowerCase();
  if (!isAdminEmail(email)) throw new Error('This reset link is not valid for admin access');
  return { email, v: Number(data.v) || 0 };
}

/**
 * Per-user token version, stored in server-controlled app_metadata. Embedded in
 * each reset link at issue time; bumping it invalidates every outstanding link,
 * which is what makes a used link single-use.
 */
export function getResetTokenVersion(user) {
  return Number(user?.app_metadata?.reset_token_version || 0);
}

export async function bumpResetTokenVersion(supabase, user) {
  const next = getResetTokenVersion(user) + 1;
  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: { ...(user.app_metadata || {}), reset_token_version: next },
  });
  if (error) console.error('bumpResetTokenVersion:', error.message);
  return next;
}

/**
 * Force-logout: deletes the user's GoTrue sessions (migration 051 RPC), killing
 * refresh tokens so no new access tokens can be minted. Best-effort — logs and
 * continues if the RPC is unavailable, so a completed reset never 500s here.
 */
export async function revokeUserSessions(supabase, userId) {
  try {
    const { error } = await supabase.rpc('revoke_user_sessions', { p_user_id: userId });
    if (error) console.error('revoke_user_sessions:', error.message);
  } catch (err) {
    console.error('revoke_user_sessions:', err.message);
  }
}

export function getAdminAuthClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function findAdminAuthUser(supabase, email) {
  const target = String(email || '').trim().toLowerCase();
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = (data?.users || []).find((u) => u.email?.toLowerCase() === target);
    if (match) return match;
    if (!data?.users?.length || data.users.length < 200) break;
    page += 1;
  }
  return null;
}

// SECURITY: never call this from an unauthenticated endpoint. On-demand account
// materialisation from a public route is an abuse primitive (see the removed
// call in admin-forgot-password.js). Admin auth accounts are provisioned out of
// band (e.g. admin-customers), not by anyone who can POST an allowlisted email.
export async function ensureAdminAuthUser(supabase, email) {
  const existing = await findAdminAuthUser(supabase, email);
  if (existing) return existing;
  const tempPassword = randomBytes(24).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { name: email.split('@')[0] },
  });
  if (error) throw error;
  return data.user;
}

export function adminResetEmailHtml(link) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Reset Proto Admin password</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
<tr><td style="height:4px;background:#dc2626;"></td></tr>
<tr><td style="padding:28px 32px;">
  <h1 style="margin:0 0 8px;font-size:24px;color:#111827;">Proto Admin password reset</h1>
  <p style="margin:0 0 24px;color:#4b5563;font-size:15px;line-height:1.6;">Click the button below to set a new password for your admin dashboard account. This link expires in 15 minutes and can be used once.</p>
  <p style="margin:0 0 24px;text-align:center;">
    <a href="${link}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 28px;border-radius:8px;">Set new password</a>
  </p>
  <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">If you did not request this, ignore this email.</p>
  <p style="margin:16px 0 0;word-break:break-all;font-size:12px;color:#9ca3af;">${link}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export async function sendAdminResetEmail(email, link) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('Email service is not configured (BREVO_API_KEY).');

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: {
        name: process.env.BREVO_SENDER_NAME || 'Proto Admin',
        email: process.env.BREVO_SENDER_EMAIL || 'online@proto.co.za',
      },
      to: [{ email }],
      subject: 'Reset your Proto Admin password',
      htmlContent: adminResetEmailHtml(link),
    }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body?.message || `Brevo send failed (${resp.status})`);
  }
}
