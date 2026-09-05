import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { parseCustomerTab, parsePositiveInt, parseBusinessTypeFilter } from './_admin-query-params.js';
import { sendWelcomeApprovalEmail } from './_welcome-email.js';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  const supabase = getAdminClient();

  // GET — list customers by tab
  if (req.method === 'GET') {
    const { tab = 'requests', page = '1', pageSize = '50', search = '', business_type: businessType = '' } = req.query;
    let pageNum;
    let size;
    let tabKey;
    let bt;
    try {
      pageNum = parsePositiveInt(page, { name: 'page', min: 1, max: 10_000, fallback: 1 });
      size = parsePositiveInt(pageSize, { name: 'pageSize', min: 1, max: 200, fallback: 50 });
      tabKey = parseCustomerTab(tab);
      bt = parseBusinessTypeFilter(businessType);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const from = (pageNum - 1) * size;
    const to = from + size - 1;

    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (tabKey === 'premium') {
      query = query.eq('tier', 'premium').eq('is_approved', true);
    } else if (tabKey === 'requests') {
      query = query.eq('is_approved', false).eq('application_status', 'pending');
    } else if (tabKey === 'on-hold') {
      query = query.eq('is_approved', false).eq('application_status', 'on_hold');
    } else if (tabKey === 'regular') {
      query = query.eq('is_approved', true);
    }

    if (bt === '__unspecified__') {
      query = query.or('business_type.is.null,business_type.eq.');
    } else if (bt) {
      query = query.eq('business_type', bt);
    }

    const q = (search || '').trim();
    if (q) {
      const safe = q.replace(/[%',()]/g, ' ').trim();
      if (safe) query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%,business_name.ilike.%${safe}%,first_name.ilike.%${safe}%,contact_name.ilike.%${safe}%,customer_code.ilike.%${safe}%`);
    }

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const rows = data || [];

    // Count orders per customer server-side — avoids a slow round-trip from the browser
    let orderCounts = {};
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id).filter(Boolean);
      const { data: orderRows } = await supabase
        .from('orders')
        .select('customer_id')
        .in('customer_id', ids);
      (orderRows || []).forEach((r) => {
        if (!r.customer_id) return;
        orderCounts[r.customer_id] = (orderCounts[r.customer_id] || 0) + 1;
      });
    }

    return res.status(200).json({
      rows: rows.map((r) => ({ ...r, orderCount: orderCounts[r.id] || 0 })),
      total: count || 0,
      page: pageNum,
      pageSize: size,
    });
  }

  // PATCH — approve / update customer fields (allowlisted columns only)
  if (req.method === 'PATCH') {
    const ALLOWED_PATCH_FIELDS = new Set([
      'is_approved', 'tier', 'name', 'email', 'phone', 'business_name',
      'business_type', 'company_address', 'delivery_address', 'vat_number',
      'business_description', 'sales_channels', 'product_categories', 'monthly_spend', 'website',
      'country', 'province', 'city', 'accept_whatsapp', 'customer_code',
      'sales_last_12_months', 'invoice_count', 'last_purchase_date',
      'contact_name', 'first_name', 'tags',
      'application_status', 'application_hold_reason', 'application_held_at',
    ]);
    const { id, ...rawPatch } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const patch = Object.fromEntries(
      Object.entries(rawPatch).filter(([key]) => ALLOWED_PATCH_FIELDS.has(key)),
    );
    if (patch.customer_code !== undefined) {
      const code = String(patch.customer_code || '').trim().toUpperCase();
      if (code && !/^[A-Z0-9]{6}$/.test(code)) {
        return res.status(400).json({ error: 'Customer code must be exactly 6 letters or numbers' });
      }
      patch.customer_code = code || null;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields to update' });

    if (patch.application_status !== undefined) {
      const status = String(patch.application_status || '').trim().toLowerCase();
      if (!['pending', 'on_hold', 'deactivated'].includes(status)) {
        return res.status(400).json({ error: 'Application status must be pending, on_hold or deactivated' });
      }
      patch.application_status = status;
      if (status === 'on_hold') {
        patch.is_approved = false;
        patch.application_hold_reason = String(patch.application_hold_reason || '').trim().slice(0, 500) || null;
        patch.application_held_at = new Date().toISOString();
      } else if (status === 'pending') {
        patch.application_hold_reason = null;
        patch.application_held_at = null;
      } else {
        patch.is_approved = false;
        patch.application_hold_reason = null;
        patch.application_held_at = null;
      }
    }

    if (patch.is_approved === true) {
      patch.application_status = 'pending';
      patch.application_hold_reason = null;
      patch.application_held_at = null;
    }

    // Approval no longer requires a customer_code — codes are allocated
    // manually whenever the admin is ready, and are NEVER auto-generated. If a
    // code was supplied in this same patch it was already validated above.

    // The confirmation email fires on the TRANSITION into having a customer
    // code (empty → a real 6-char code). It needs the pre-update row so
    // re-saving an unchanged customer never re-spams them. A code being
    // CHANGED (already had one) also never re-sends.
    const settingCode = typeof patch.customer_code === 'string' && !!patch.customer_code;
    let priorApproved = null;
    let priorCode = '';
    if (patch.is_approved === true || settingCode) {
      const { data: before } = await supabase
        .from('customers').select('is_approved, customer_code').eq('id', id).maybeSingle();
      priorApproved = before?.is_approved === true;
      priorCode = String(before?.customer_code || '').trim();
    }

    const { data, error } = await supabase
      .from('customers')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) return res.status(400).json({ error: error.message });

    const justApproved = patch.is_approved === true && priorApproved === false;
    // Confirmation email: only when a code is newly assigned to an approved
    // customer. No code → no email (allocate the code later, then it sends).
    const justGotCode = settingCode && !priorCode && data?.is_approved === true;

    // The application-received email PROMISES the customer a confirmation the
    // moment they are approved, and approval does not require a code — so the
    // welcome email fires on the APPROVAL transition. Assigning a code later
    // only sends if the customer was somehow never welcomed (last_email_type
    // guard, so nobody is double-mailed).
    let welcomeEmail = 'skipped';
    const neverWelcomed = data?.last_email_type !== 'welcome';
    if (data?.email && (justApproved || (justGotCode && neverWelcomed))) {
      try {
        const result = await sendWelcomeApprovalEmail(data, { supabase });
        welcomeEmail = result?.sent ? 'sent' : 'skipped';
      } catch (mailErr) {
        console.error('confirmation email error:', mailErr.message);
        welcomeEmail = 'failed';
      }
    }

    return res.status(200).json({ row: data, welcomeEmail });
  }

  // POST — manually add a customer into a chosen section (never trade-requests,
  // never an auto-generated code).
  if (req.method === 'POST') {
    const b = req.body || {};
    const section = String(b.section || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    const name = String(b.name || b.business_name || '').trim();

    // Pre-registration / 10000-club allowlist — they auto-approve + get the
    // welcome email when they sign up. account_code here is a REFERENCE only,
    // never copied into customers.customer_code.
    if (section === 'pre-registration' || section === '10000-club') {
      // proto_active_customers has several NOT NULL columns (migration 021):
      // name, account_code, and sales_last_12_months. Supply safe non-null
      // values for all of them so a manual add never 400s on a blank field.
      const row = {
        email,
        name: name || email,
        contact_name: String(b.contact_name || '').trim() || null,
        first_name: String(b.first_name || '').trim() || null,
        account_code: String(b.account_code || '').trim(),
        sales_last_12_months: b.sales_last_12_months != null && b.sales_last_12_months !== ''
          ? Number(b.sales_last_12_months) || 0 : 0,
      };
      const { error } = await supabase
        .from('proto_active_customers')
        .upsert(row, { onConflict: 'email' });
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ ok: true, section: 'pre-registration' });
    }

    // Approved customer — needs an auth account so they can sign in. No code.
    if (section === 'approved' || section === 'approved-10000') {
      const tempPassword = `Pt-${randomBytes(16).toString('base64url')}`;
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { name },
      });
      if (createErr) {
        if (createErr.code === 'email_exists') {
          return res.status(409).json({ error: 'An account with that email already exists — find them in the list.' });
        }
        return res.status(400).json({ error: createErr.message || 'Failed to create account' });
      }
      const user = created?.user;
      if (!user?.id) return res.status(500).json({ error: 'Account created without a user id' });

      const row = {
        id: user.id,
        email,
        name: name || email,
        business_name: String(b.business_name || '').trim() || name || null,
        tier: 'regular',
        role: 'customer',
        is_approved: true,
        customer_code: null,
      };
      for (const col of ['phone', 'business_type', 'business_description', 'contact_name', 'first_name', 'vat_number', 'website', 'city', 'province', 'country', 'company_address', 'delivery_address']) {
        const v = b[col];
        if (v !== undefined && v !== null && String(v).trim() !== '') row[col] = String(v).trim();
      }
      if (b.monthly_spend !== undefined && b.monthly_spend !== '') row.monthly_spend = String(b.monthly_spend).trim();
      if (b.accept_whatsapp !== undefined) row.accept_whatsapp = Boolean(b.accept_whatsapp);
      if (section === 'approved-10000') row.tags = ['10000 club'];

      const { data: inserted, error: custErr } = await supabase
        .from('customers')
        .upsert(row, { onConflict: 'id' })
        .select('*')
        .single();
      if (custErr) {
        await supabase.auth.admin.deleteUser(user.id).catch(() => {});
        return res.status(400).json({ error: custErr.message });
      }

      let welcomeEmail = 'skipped';
      try {
        const result = await sendWelcomeApprovalEmail(inserted, { supabase, needsPasswordSetup: true });
        welcomeEmail = result?.sent ? 'sent' : 'skipped';
      } catch (mailErr) {
        console.error('manual add welcome email:', mailErr.message);
        welcomeEmail = 'failed';
      }
      return res.status(200).json({ ok: true, section: 'approved', row: inserted, welcomeEmail });
    }

    return res.status(400).json({ error: `Unknown section: ${section || '(none)'}` });
  }

  // DELETE — remove customer
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const { count: orderCount, error: countError } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', id);
    if (countError) return res.status(400).json({ error: countError.message });
    if ((orderCount || 0) > 0) {
      return res.status(400).json({
        code: 'has_orders',
        orderCount,
        error: 'This customer has orders on record, so the account cannot be deleted.',
      });
    }

    const { error: authError } = await supabase.auth.admin.deleteUser(id);
    // A customers row without a matching auth user (imported/legacy rows)
    // must still be deletable — treat "user not found" as already deleted.
    if (authError && !/not.?found/i.test(authError.message || '')) {
      return res.status(400).json({ error: authError.message || 'Failed to delete auth user' });
    }

    const { error: custError } = await supabase
      .from('customers')
      .delete()
      .eq('id', id);
    if (custError) return res.status(400).json({ error: custError.message });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
