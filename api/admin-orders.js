import { requireAdminOrOrderToken } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { advanceOrderStatusToTarget, normalizeOrderStatus } from './_order-status.js';
import { isFulfillmentLinkRestrictedTarget } from './_fulfillment-auth.js';
import { isOwnerEmail } from './_admin-auth.js';
import { getPortalAdminClient, readOrderNotifyLog, SITE_CONFIG_BUCKET } from './_site-config.js';
import { isOrderNotifyComplete } from './_order-notify-core.js';
import { ordersHasConfirmationSentAt } from './_order-confirmation-sent.js';
import { parseOrderTab, parsePositiveInt } from './_admin-query-params.js';
import { isOrderTrashEnabled, normalizeOrderTrashReason } from '../lib/order-trash.mjs';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const ORDER_SELECT = '*, customers(name, contact_name, email, phone, business_name, business_type, city, province, country, company_address, delivery_address, vat_number, customer_code, tier)';
const LEGACY_CONFIRMATION_SCAN_LIMIT = 2000;
const LEGACY_ORDER_SEARCH_SCAN_LIMIT = 500;

let _hasItemsSearchColumn = null;

async function ordersHasItemsSearchColumn(supabase) {
  if (_hasItemsSearchColumn != null) return _hasItemsSearchColumn;
  const { error } = await supabase.from('orders').select('items_search').limit(1);
  if (error) {
    _hasItemsSearchColumn = false;
    return false;
  }
  _hasItemsSearchColumn = true;
  return true;
}

function assertOrderScope(auth, orderId, res) {
  if (auth.type === 'admin') return true;
  if (String(orderId) === String(auth.orderId)) return true;
  res.status(403).json({ error: 'Not authorized for this order' });
  return false;
}

function safeSearchTerm(search) {
  return String(search || '').replace(/[%',()\\]/g, ' ').trim();
}

async function listLegacyConfirmationSentIds() {
  const supabase = getPortalAdminClient();
  const sent = new Set();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(SITE_CONFIG_BUCKET)
      .list('orders/confirmation', { limit: 1000, offset });
    if (error || !data?.length) break;
    for (const file of data) {
      if (file.name?.endsWith('.json')) sent.add(file.name.replace(/\.json$/, ''));
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return sent;
}

function isConfirmationSent(order, legacyIds) {
  if (order?.confirmation_sent_at) return true;
  return legacyIds?.has?.(String(order?.id)) ?? false;
}

function orderMatchesTab(order, tab, legacyIds) {
  const key = normalizeOrderStatus(order?.status);
  const sent = isConfirmationSent(order, legacyIds);
  if (tab === 'new') return key === 'pending';
  if (tab === 'handed') return key === 'handed over';
  if (tab === 'progress') return key === 'order in progress';
  if (tab === 'sent') return key === 'order sent' && !sent;
  if (tab === 'paid') return key === 'payment received' || (key === 'order sent' && sent);
  return true;
}

async function resolveCustomerIdsForSearch(supabase, term) {
  const safe = safeSearchTerm(term);
  if (!safe) return [];
  const { data } = await supabase
    .from('customers')
    .select('id')
    .or(`name.ilike.%${safe}%,email.ilike.%${safe}%,business_name.ilike.%${safe}%,contact_name.ilike.%${safe}%`);
  return (data || []).map((r) => r.id).filter(Boolean);
}

function applyOrderSearch(query, term, customerIds, { useItemsSearch = false } = {}) {
  const safe = safeSearchTerm(term);
  if (!safe) return query;
  const parts = [`order_number.ilike.%${safe}%`];
  if (useItemsSearch) parts.push(`items_search.ilike.%${safe}%`);
  for (const id of customerIds) parts.push(`customer_id.eq.${id}`);
  return query.or(parts.join(','));
}

function orderMatchesSearch(order, term, customerIds) {
  const safe = safeSearchTerm(term).toLowerCase();
  if (!safe) return true;
  if (customerIds.includes(order.customer_id)) return true;
  if (String(order.order_number || '').toLowerCase().includes(safe)) return true;
  const itemsHay = JSON.stringify(order.items || order.original_items || []).toLowerCase();
  return itemsHay.includes(safe);
}

function applySentTabFilter(q) {
  return q.eq('status', 'order sent').is('confirmation_sent_at', null);
}

function applyPaidTabFilter(q) {
  return q.or('status.eq.payment received,and(status.eq.order sent,confirmation_sent_at.not.is.null)');
}

function isRangeNotSatisfiable(error) {
  return /range not satisfiable|PGRST103/i.test(String(error?.message || ''));
}

async function computeTabCounts(supabase, useDbColumn, legacyIds) {
  if (useDbColumn) {
    const [all, newC, handed, progress, sentC, paidStatus, paidSent, everPaid] = await Promise.all([
      supabase.from('orders').select('*', { count: 'exact', head: true }),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'handed over'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'order in progress'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'order sent').is('confirmation_sent_at', null),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'payment received'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'order sent').not('confirmation_sent_at', 'is', null),
      supabase.from('orders').select('*', { count: 'exact', head: true }).in('status', ['payment received', 'paid']),
    ]);
    const err = [all, newC, handed, progress, sentC, paidStatus, paidSent, everPaid].find((r) => r.error);
    if (err?.error) throw err.error;
    return {
      all: all.count || 0,
      new: newC.count || 0,
      handed: handed.count || 0,
      progress: progress.count || 0,
      sent: sentC.count || 0,
      paid: (paidStatus.count || 0) + (paidSent.count || 0),
      // Orders not yet marked as paid — drives the sidebar notification badge.
      unpaid: Math.max(0, (all.count || 0) - (everPaid.count || 0)),
    };
  }

  const { data, error } = await supabase.from('orders').select('id, status');
  if (error) throw error;
  const counts = { all: 0, new: 0, handed: 0, progress: 0, sent: 0, paid: 0, unpaid: 0 };
  for (const order of data || []) {
    counts.all += 1;
    if (normalizeOrderStatus(order.status) !== 'payment received') counts.unpaid += 1;
    for (const tab of ['new', 'handed', 'progress', 'sent', 'paid']) {
      if (orderMatchesTab(order, tab, legacyIds)) counts[tab] += 1;
    }
  }
  return counts;
}

async function fetchAdminOrdersPage(supabase, {
  page, pageSize, search, tab, useDbColumn, legacyIds, useItemsSearch,
}) {
  const term = safeSearchTerm(search);
  const customerIds = term ? await resolveCustomerIdsForSearch(supabase, term) : [];
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (term && !useItemsSearch) {
    let q = supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(LEGACY_ORDER_SEARCH_SCAN_LIMIT);
    if (tab === 'new') q = q.eq('status', 'pending');
    else if (tab === 'handed') q = q.eq('status', 'handed over');
    else if (tab === 'progress') q = q.eq('status', 'order in progress');
    const { data, error } = await q;
    if (error) throw error;
    const filtered = (data || []).filter((o) => orderMatchesTab(o, tab, legacyIds) && orderMatchesSearch(o, term, customerIds));
    return {
      rows: filtered.slice(from, from + pageSize),
      total: filtered.length,
      page,
      pageSize,
      truncated: (data || []).length >= LEGACY_ORDER_SEARCH_SCAN_LIMIT,
    };
  }

  if (useDbColumn && (tab === 'sent' || tab === 'paid')) {
    let q = supabase.from('orders').select(ORDER_SELECT, { count: 'exact' }).order('created_at', { ascending: false });
    q = applyOrderSearch(q, term, customerIds, { useItemsSearch });
    q = tab === 'sent' ? applySentTabFilter(q) : applyPaidTabFilter(q);
    q = q.range(from, to);
    const { data, error, count } = await q;
    if (error && !isRangeNotSatisfiable(error)) throw error;
    return { rows: error ? [] : (data || []), total: count || 0, page, pageSize };
  }

  if (!useDbColumn && (tab === 'sent' || tab === 'paid')) {
    let q = supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(LEGACY_CONFIRMATION_SCAN_LIMIT);
    q = applyOrderSearch(q, term, customerIds, { useItemsSearch });
    const { data, error } = await q;
    if (error) throw error;
    const filtered = (data || []).filter((o) => orderMatchesTab(o, tab, legacyIds));
    return {
      rows: filtered.slice(from, from + pageSize),
      total: filtered.length,
      page,
      pageSize,
      truncated: (data || []).length >= LEGACY_CONFIRMATION_SCAN_LIMIT,
    };
  }

  let q = supabase.from('orders').select(ORDER_SELECT, { count: 'exact' }).order('created_at', { ascending: false });
  q = applyOrderSearch(q, term, customerIds, { useItemsSearch });
  if (tab === 'new') q = q.eq('status', 'pending');
  else if (tab === 'handed') q = q.eq('status', 'handed over');
  else if (tab === 'progress') q = q.eq('status', 'order in progress');

  const runPage = async (pageNo) => {
    const lo = (pageNo - 1) * pageSize;
    let pq = supabase.from('orders').select(ORDER_SELECT, { count: 'exact' }).order('created_at', { ascending: false });
    pq = applyOrderSearch(pq, term, customerIds, { useItemsSearch });
    if (tab === 'new') pq = pq.eq('status', 'pending');
    else if (tab === 'handed') pq = pq.eq('status', 'handed over');
    else if (tab === 'progress') pq = pq.eq('status', 'order in progress');
    return pq.range(lo, lo + pageSize - 1);
  };

  let { data, error, count } = await runPage(page);

  // PostgREST answers 416 whenever the requested window starts past the end of
  // the result set. Returning rows: [] for that looked identical to "this tab
  // is empty" — no error, no message — and left the tab badge, which is a
  // separate query, still showing a count. That is the "my orders vanished
  // until I refreshed" report: the page was out of range, and a refresh only
  // helped because it happened to reset the page.
  //
  // A window past the end is not an empty tab. Fall back to the first page.
  if (error && isRangeNotSatisfiable(error) && page > 1) {
    ({ data, error, count } = await runPage(1));
    page = 1;
  }

  if (error && !isRangeNotSatisfiable(error)) throw error;
  // A genuine 416 on page 1 means there really is nothing to show.
  return { rows: error ? [] : (data || []), total: count || 0, page, pageSize };
}

export default async function handler(req, res) {
  const auth = await requireAdminOrOrderToken(req, res);
  if (!auth) return;
  const supabase = getAdminClient();

  if (req.method === 'GET') {
    const capabilities = {
      orderTrash: auth.type === 'admin' && isOrderTrashEnabled(),
    };
    const {
      limit = '',
      customerId = '',
      id = '',
      page = '1',
      pageSize = '50',
      search = '',
      tab = 'all',
    } = req.query;

    if (auth.type === 'order') {
      const { data, error } = await supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('id', auth.orderId)
        .maybeSingle();
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ rows: data ? [data] : [], capabilities });
    }

    if (id) {
      const { data, error } = await supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ rows: data ? [data] : [], capabilities });
    }

    if (customerId) {
      const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 20));
      const { data, error, count } = await supabase
        .from('orders')
        .select(ORDER_SELECT, { count: 'exact' })
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(lim);
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ rows: data || [], total: count || 0, capabilities });
    }

    let pageNum;
    let size;
    let tabKey;
    try {
      pageNum = parsePositiveInt(page, { name: 'page', min: 1, max: 10_000, fallback: 1 });
      size = parsePositiveInt(pageSize, { name: 'pageSize', min: 1, max: 200, fallback: 50 });
      tabKey = parseOrderTab(tab);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const useDbColumn = await ordersHasConfirmationSentAt(supabase);
    const useItemsSearch = await ordersHasItemsSearchColumn(supabase);
    const legacyIds = useDbColumn ? null : await listLegacyConfirmationSentIds();

    try {
      const tabCounts = await computeTabCounts(supabase, useDbColumn, legacyIds);
      if (tabKey === 'all' && !safeSearchTerm(search)) {
        const from = (pageNum - 1) * size;
        const to = from + size - 1;
        const { data, error, count } = await supabase
          .from('orders')
          .select(ORDER_SELECT, { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(from, to);
        if (error && !isRangeNotSatisfiable(error)) return res.status(400).json({ error: error.message });
        return res.status(200).json({
          rows: error ? [] : (data || []),
          total: count || 0,
          page: pageNum,
          pageSize: size,
          tabCounts,
          capabilities,
        });
      }

      const result = await fetchAdminOrdersPage(supabase, {
        page: pageNum,
        pageSize: size,
        search,
        tab: tabKey,
        useDbColumn,
        legacyIds,
        useItemsSearch,
      });
      return res.status(200).json({ ...result, tabCounts, capabilities });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    const { id, notes, advanceWorkflow, senderUserId, senderName, status, restoreTrashId, ...raw } = req.body || {};
    if (restoreTrashId) {
      if (auth.type !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      if (!isOrderTrashEnabled()) {
        return res.status(409).json({ error: 'Recoverable order trash is not enabled. No data was changed.' });
      }
      const actor = auth.user?.email || 'unknown-admin';
      const { data: restoredOrderId, error: restoreError } = await supabase.rpc('restore_admin_order', {
        p_trash_id: String(restoreTrashId),
        p_actor: actor,
      });
      if (restoreError) return res.status(400).json({ error: restoreError.message });
      return res.status(200).json({ ok: true, restoredOrderId });
    }
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!assertOrderScope(auth, id, res)) return;

    if (status !== undefined) {
      const direct = String(status || '').trim().toLowerCase();
      if (direct && !['viewed', 'paid', 'delivered'].includes(direct)) {
        return res.status(400).json({
          error: 'Direct status changes are not allowed — use advanceWorkflow',
        });
      }
    }

    const patch = { ...raw };
    if (notes !== undefined) patch.order_change_notes = notes;

    // Legacy timestamp shims — remove after direct status PATCH is fully retired
    if (status === 'viewed' && !patch.viewed_at) patch.viewed_at = new Date().toISOString();
    if (status === 'paid' && !patch.paid_at) patch.paid_at = new Date().toISOString();
    if (status === 'delivered' && !patch.delivered_at) patch.delivered_at = new Date().toISOString();

    const allowed = new Set([
      'final_items', 'original_items', 'order_change_notes', 'order_match',
      'replacement_map', 'viewed_at', 'paid_at', 'delivered_at', 'total_ex_vat',
      'handed_over_at', 'order_in_progress_at', 'order_sent_at', 'payment_received_at',
      'delivery_method',
    ]);
    const sanitized = {};
    for (const [key, value] of Object.entries(patch)) {
      if (allowed.has(key)) sanitized[key] = value;
    }

    // A fulfillment order-token holder may manage fulfillment fields, but NOT
    // directly write money/payment columns — those are admin-only, or must go
    // through the gated advanceWorkflow (which enforces the Victor check).
    if (auth.type !== 'admin') {
      const SENSITIVE = ['paid_at', 'payment_received_at', 'order_sent_at', 'total_ex_vat'];
      const attempted = SENSITIVE.filter((k) => k in sanitized);
      if (attempted.length) {
        return res.status(403).json({ error: `Not allowed to change ${attempted.join(', ')} from an order link.` });
      }
    }

    // Run the workflow gates (Victor-only, pending-notifications, not-found)
    // BEFORE committing any field write — otherwise a PATCH that bundles field
    // edits with a workflow advance that is later REJECTED still lands the field
    // writes (e.g. total_ex_vat corrupted while a 403 is returned).
    if (advanceWorkflow) {
      const target = normalizeOrderStatus(advanceWorkflow);
      const allowedTargets = new Set(['handed over', 'order in progress', 'order sent', 'payment received']);
      if (!allowedTargets.has(target)) {
        return res.status(400).json({ error: `Unsupported workflow target: "${target}"` });
      }
      // A fulfillment URL is a scoped packing link, not a staff identity.
      // It must never be able to send customer-facing orders or record payment,
      // even if a browser supplies "victor" as the sender identity.
      if (auth.type === 'order' && isFulfillmentLinkRestrictedTarget(target)) {
        return res.status(403).json({
          error: 'Fulfillment links cannot send orders or record payments. Sign in to the admin dashboard to complete this step.',
        });
      }
      // Customer-facing sends and payment records are Owner actions. The
      // verified account determines this permission; senderUserId/name are
      // display metadata only and can never grant it.
      if (auth.type === 'admin'
        && isFulfillmentLinkRestrictedTarget(target)
        && !isOwnerEmail(auth.user?.email)) {
        return res.status(403).json({
          error: target === 'payment received'
            ? 'Owner access is required to mark payment received.'
            : 'Owner access is required to send an order to a customer.',
        });
      }
      // A pending order may only leave "New" once the new-order round is done:
      // the new-order alert email to the order team was sent.
      const { data: currentOrder, error: currentErr } = await supabase
        .from('orders')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();
      if (currentErr) return res.status(400).json({ error: currentErr.message });
      if (!currentOrder) return res.status(404).json({ error: 'Order not found' });
      if (normalizeOrderStatus(currentOrder.status) === 'pending') {
        const log = await readOrderNotifyLog(String(id));
        const notify = isOrderNotifyComplete(log);
        if (!notify.ok) {
          return res.status(409).json({
            error: `Cannot move to Handed Over yet — ${notify.reason}. Use the resend button on the order to send the notifications.`,
            reason: 'notifications-incomplete',
          });
        }
      }
      try {
        const result = await advanceOrderStatusToTarget(supabase, id, target);
        if (!result.ok) {
          return res.status(409).json({
            error: `Cannot advance to "${target}" from "${result.current || 'unknown'}"`,
            reason: result.reason,
          });
        }
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    // Field writes commit only after every gate above has passed.
    if (Object.keys(sanitized).length) {
      const { error: patchError } = await supabase.from('orders').update(sanitized).eq('id', id);
      if (patchError) return res.status(400).json({ error: patchError.message });
    }

    const { data, error } = await supabase
      .from('orders')
      .select(ORDER_SELECT)
      .eq('id', id)
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ row: data });
  }

  if (req.method === 'DELETE') {
    if (auth.type !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { id, all, reason } = req.body || {};
    if (all) {
      return res.status(409).json({ error: 'Bulk order deletion is disabled. Archive individual duplicates with an audit reason.' });
    }
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!isOrderTrashEnabled()) {
      return res.status(409).json({ error: 'Recoverable order trash is not enabled. No data was changed.' });
    }
    let cleanReason;
    try {
      cleanReason = normalizeOrderTrashReason(reason);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const actor = auth.user?.email || 'unknown-admin';
    const { data: trashId, error } = await supabase.rpc('trash_admin_order', {
      p_order_id: String(id),
      p_actor: actor,
      p_reason: cleanReason,
    });
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true, trashed: true, trashId });
  }

  return res.status(405).end();
}
