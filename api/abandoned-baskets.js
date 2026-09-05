/**
 * Abandoned baskets — customers with an outstanding basket who have not
 * checked out, with the customer detail needed to act on it.
 *
 * Source is `customer_account_carts` in the portal project (migration 057 of
 * the ProtoMainSite repo). The portal empties a basket's items on
 * `order_submit_succeeded`, so a row that still holds items is by definition
 * un-checked-out. There is no separate abandonment table to maintain.
 *
 * The cart table has no foreign key to `customers` (it references
 * `auth.users`), so PostgREST cannot embed the customer — the join is done
 * here, in two reads.
 */
import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import {
  buildAbandonedBaskets,
  filterBaskets,
  sortBaskets,
  summariseBaskets,
  SORT_KEYS,
} from '../lib/abandoned-baskets.mjs';

export const config = { maxDuration: 30 };

const CART_COLUMNS = 'customer_id, items, activity_at, updated_at';
const CUSTOMER_COLUMNS = [
  'id', 'name', 'contact_name', 'first_name', 'business_name', 'email', 'phone',
  'customer_code', 'tier', 'city', 'province', 'tags', 'is_approved',
  'sales_last_12_months', 'last_purchase_date', 'last_email_type', 'last_email_at',
  'created_at',
].join(', ');

const PAGE_SIZE = 1000;

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Cart rows carry a full product snapshot per line, so the payload is large
 * relative to the row count. Page rather than assume one request covers it.
 */
async function fetchAll(query, { from = 0 } = {}) {
  const rows = [];
  let offset = from;
  for (;;) {
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) return { rows: null, error };
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, error: null };
    offset += PAGE_SIZE;
  }
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getAdminClient();

  if (req.method === 'POST') {
    const customerId = String(req.body?.customerId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!customerId || action !== 'mark-active') {
      return res.status(400).json({ error: 'A customer and the mark-active action are required.' });
    }

    const { data: existing, error: readError } = await supabase
      .from('customer_account_carts')
      .select('customer_id, items, revision')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (readError) return res.status(400).json({ error: readError.message });
    if (!existing || !Array.isArray(existing.items) || !existing.items.length) {
      return res.status(404).json({ error: 'This customer no longer has a saved basket.' });
    }

    const now = Date.now();
    let update = supabase
      .from('customer_account_carts')
      .update({ activity_at: now, updated_at: new Date(now).toISOString() })
      .eq('customer_id', customerId);
    if (Number.isSafeInteger(Number(existing.revision))) {
      update = update.eq('revision', Number(existing.revision));
    }
    const { data: refreshed, error: updateError } = await update
      .select(CART_COLUMNS)
      .maybeSingle();
    if (updateError) return res.status(400).json({ error: updateError.message });
    if (!refreshed) {
      return res.status(409).json({ error: 'The basket changed while it was being refreshed. Refresh the page and try again.' });
    }
    return res.status(200).json({
      ok: true,
      customerId,
      activityAt: refreshed.activity_at,
      updatedAt: refreshed.updated_at,
      lineCount: refreshed.items.length,
    });
  }

  const cartResult = await fetchAll(
    supabase.from('customer_account_carts').select(CART_COLUMNS).order('updated_at', { ascending: false }),
  );

  if (cartResult.error) {
    // The portal owns migration 057. If the admin app is pointed at a project
    // that predates it, say so plainly instead of returning a confusing 400.
    if (/does not exist/i.test(cartResult.error.message || '')) {
      return res.status(200).json({
        available: false,
        reason: 'The customer_account_carts table is not present in this Supabase project.',
        summary: summariseBaskets([]),
        baskets: [],
      });
    }
    return res.status(400).json({ error: cartResult.error.message });
  }
  // Only the customers who are actually holding something. Most rows in this
  // table are emptied baskets from customers who did check out, so naming
  // every customer would read the whole table to describe a fraction of it.
  const holderIds = [...new Set(
    cartResult.rows
      .filter((row) => Array.isArray(row.items) && row.items.length > 0)
      .map((row) => String(row.customer_id || ''))
      .filter(Boolean),
  )];

  const customerRows = [];
  for (let i = 0; i < holderIds.length; i += 200) {
    const { data, error } = await supabase
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .in('id', holderIds.slice(i, i + 200));
    if (error) return res.status(400).json({ error: error.message });
    customerRows.push(...(data || []));
  }

  const all = buildAbandonedBaskets({
    carts: cartResult.rows,
    customers: customerRows,
    now: Date.now(),
  });

  const staleness = String(req.query.staleness || 'all');
  const search = String(req.query.search || '');
  const sort = SORT_KEYS.includes(String(req.query.sort)) ? String(req.query.sort) : 'value';

  const filtered = filterBaskets(all, { staleness, search });

  return res.status(200).json({
    available: true,
    // Summary always describes the full picture, so the KPI row does not
    // change meaning when a filter is applied.
    summary: summariseBaskets(all),
    filteredSummary: summariseBaskets(filtered),
    baskets: sortBaskets(filtered, sort),
    emptiedBasketCount: cartResult.rows.length - all.length,
  });
}
