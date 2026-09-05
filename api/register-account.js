import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
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
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const supabase = getAdminClient();

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (createError) {
    if (createError.code === 'email_exists') {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    return res.status(400).json({ error: createError.message || 'Failed to create account' });
  }

  const user = created?.user;
  if (!user?.id) {
    return res.status(500).json({ error: 'Account was created without a user id' });
  }

  // Core columns are guaranteed to exist — if an optional column below is
  // missing (schema drift / migration not yet run), we fall back to exactly
  // this row so signup always succeeds and the account is never deleted.
  const coreRow = {
    id: user.id,
    email,
    name,
    tier: 'regular',
    role: 'customer',
    is_approved: false,
    business_name: String(req.body?.businessName || req.body?.business_name || '').trim() || name,
    customer_code: null,
  };
  const customerRow = { ...coreRow };

  // Every signup field the register portal sends lands on the profile.
  const OPTIONAL_FIELDS = {
    phone: 'phone',
    business_type: 'business_type', businessType: 'business_type',
    vat_number: 'vat_number', vatNumber: 'vat_number',
    company_address: 'company_address', companyAddress: 'company_address',
    delivery_address: 'delivery_address', deliveryAddress: 'delivery_address',
    city: 'city',
    province: 'province',
    country: 'country',
    website: 'website',
    monthly_spend: 'monthly_spend', monthlySpend: 'monthly_spend',
    contact_name: 'contact_name', contactName: 'contact_name',
    first_name: 'first_name', firstName: 'first_name',
  };
  for (const [bodyKey, column] of Object.entries(OPTIONAL_FIELDS)) {
    const value = req.body?.[bodyKey];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      customerRow[column] = String(value).trim();
    }
  }
  if (req.body?.acceptWhatsapp !== undefined || req.body?.accept_whatsapp !== undefined) {
    customerRow.accept_whatsapp = Boolean(req.body?.acceptWhatsapp ?? req.body?.accept_whatsapp);
  }

  // 10000 Club: pre-registered contacts (imported CSV) are auto-approved at
  // signup and tagged — but NO customer_code is allocated (manual admin step).
  // Mirrors the DB trigger in migration 040 so it also works pre-migration.
  let autoApproved = false;
  try {
    const { data: preReg } = await supabase
      .from('proto_active_customers')
      .select('email, contact_name, first_name, sales_last_12_months, invoice_count, last_purchase_date')
      .ilike('email', email)
      .maybeSingle();
    if (preReg) {
      autoApproved = true;
      // The critical outcome — approval — is applied to BOTH rows so it
      // survives the core-only fallback below.
      coreRow.is_approved = true;
      customerRow.is_approved = true;
      customerRow.tags = ['10000 club'];
      if (!customerRow.contact_name && preReg.contact_name) customerRow.contact_name = preReg.contact_name;
      if (!customerRow.first_name && preReg.first_name) customerRow.first_name = preReg.first_name;
      if (preReg.sales_last_12_months != null) customerRow.sales_last_12_months = preReg.sales_last_12_months;
      if (preReg.invoice_count != null) customerRow.invoice_count = preReg.invoice_count;
      if (preReg.last_purchase_date) customerRow.last_purchase_date = preReg.last_purchase_date;
    }
  } catch { /* pre-registration lookup is best-effort */ }

  let { error: customerError } = await supabase
    .from('customers')
    .upsert(customerRow, { onConflict: 'id' });

  // Any column error (e.g. tags before migration 040, or schema drift) must
  // never block a signup or delete the auth user — retry with core columns
  // only. The customer still registers, and a pre-registered one stays
  // approved; only the optional profile/tag extras are dropped.
  if (customerError) {
    ({ error: customerError } = await supabase.from('customers').upsert(coreRow, { onConflict: 'id' }));
  }

  if (customerError) {
    await supabase.auth.admin.deleteUser(user.id).catch(() => {});
    return res.status(400).json({ error: customerError.message || 'Failed to create customer profile' });
  }

  // Auto-approved 10000-club members get a welcome/approval email immediately.
  // Best-effort — a mail failure must never fail the (already committed) signup.
  let welcomeEmailSent = false;
  if (autoApproved) {
    try {
      const result = await sendWelcomeApprovalEmail({ ...customerRow, id: user.id, email }, { supabase });
      welcomeEmailSent = Boolean(result?.sent);
    } catch { /* welcome email is best-effort */ }
  }

  return res.status(200).json({
    ok: true,
    message: 'Account created successfully',
    userId: user.id,
    autoApproved,
    welcomeEmailSent,
    tag: autoApproved ? '10000 club' : null,
  });
}
