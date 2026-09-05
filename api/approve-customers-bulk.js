import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { BULK_CHUNK_SIZE, runInChunks } from '../lib/bulk-chunk.mjs';
import { sendWelcomeApprovalEmail } from './_welcome-email.js';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function fetchCustomersByEmails(supabase, emails) {
  const map = new Map();
  const CHUNK = 100;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const slice = emails.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('customers')
      .select('id, email, is_approved, customer_code')
      .in('email', slice);
    if (error) throw error;
    for (const row of data || []) {
      map.set(normalizeEmail(row.email), row);
    }
  }
  return map;
}

function classifyEmail(email, customer) {
  if (!customer) return { kind: 'notFound', email };
  if (customer.is_approved) {
    return { kind: 'approved', entry: { email, id: customer.id, already: true } };
  }
  // A customer code is NOT required to approve — codes are allocated manually
  // later and are never auto-generated.
  return { kind: 'pending', email, customer };
}

async function approveCustomer(supabase, email, customer) {
  const { data: fresh, error } = await supabase
    .from('customers')
    .update({ is_approved: true })
    .eq('id', customer.id)
    .select('*')
    .single();
  if (error) return { kind: 'failed', entry: { email, error: error.message } };
  // The customer was promised an email on approval. Best-effort: an email
  // failure never fails the approval itself (sendBrevoTransactional retries
  // 429/5xx internally, so bursts pace themselves).
  let welcomed = false;
  try {
    if (fresh?.email && fresh?.last_email_type !== 'welcome') {
      const result = await sendWelcomeApprovalEmail(fresh, { supabase });
      welcomed = Boolean(result?.sent);
    }
  } catch (mailErr) {
    console.error('bulk approve: welcome email failed for', email, mailErr.message);
  }
  return { kind: 'approved', entry: { email, id: customer.id, welcomed } };
}

/** Bulk-approve customers whose email appears in the uploaded list. */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const emails = [...new Set(
    (Array.isArray(req.body?.emails) ? req.body.emails : [])
      .map(normalizeEmail)
      .filter(Boolean),
  )];
  if (!emails.length) return res.status(400).json({ error: 'No valid email addresses provided' });

  const supabase = getAdminClient();
  const approved = [];
  const failed = [];
  const notFound = [];

  try {
    const customerMap = await fetchCustomersByEmails(supabase, emails);
    const pending = [];

    for (const email of emails) {
      const customer = customerMap.get(email);
      const result = classifyEmail(email, customer);
      if (result.kind === 'notFound') notFound.push(email);
      else if (result.kind === 'approved') approved.push(result.entry);
      else if (result.kind === 'failed') failed.push(result.entry);
      else if (result.kind === 'pending') pending.push(result);
    }

    const outcomes = await runInChunks(pending, BULK_CHUNK_SIZE, ({ email, customer }) => (
      approveCustomer(supabase, email, customer)
    ));

    for (const row of outcomes) {
      if (row.error && row.item) {
        failed.push({ email: row.item.email, error: row.error });
        continue;
      }
      if (row.kind === 'failed') failed.push(row.entry);
      else if (row.kind === 'approved') approved.push(row.entry);
    }

    return res.status(200).json({
      ok: failed.length === 0,
      approved: approved.filter((a) => !a.already).length,
      alreadyApproved: approved.filter((a) => a.already).length,
      notFound,
      failed,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Bulk approve failed' });
  }
}
