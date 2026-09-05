import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ClipboardList, FileText, Loader2, Lock, Pencil, Search, User, X } from 'lucide-react';
import { searchReplacementProducts } from '../lib/products';
import {
  fetchFulfillmentProgress,
  lookupProductCategories,
  toggleFulfillmentItem,
} from '../lib/fulfillmentProgress';
import {
  fetchFulfillmentUsers,
  loadActiveUserId,
  saveActiveUserId,
} from '../lib/fulfillmentUsers';
import { generateOrderPdfBase64, createEmailOrderItems, openPdfBase64Preview } from '../lib/orderDocuments';
import { formatDeliveryMethod } from '../../lib/order-format.mjs';
import { displayOrderNumber, buildFulfillmentUrl } from '../lib/orderNumber';
import { isVictorSender, CUSTOMER_SEND_FORBIDDEN } from '../lib/fulfillmentAuth';
import { getOrderAccessFromUrl } from '../lib/adminKey';
import { fetchTaxonomy } from '../lib/taxonomyAdmin';
import { LEGACY_NAV_ALIASES } from '../lib/taxonomy';

/**
 * Local-state quantity input.
 *
 * The parent state only updates on blur / Enter so typing never re-renders the
 * whole order list. That kills the layout jump people see when tapping into
 * an input on mobile and stops the value from snapping to 0 the instant they
 * clear the field (Number('') === 0).
 */
const QtyInput = memo(function QtyInput({ value, disabled, changed, onCommit }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const lastValueRef = useRef(value);
  useEffect(() => {
    if (lastValueRef.current !== value) {
      lastValueRef.current = value;
      setDraft(String(value ?? ''));
    }
  }, [value]);

  const commit = useCallback(() => {
    const num = draft.trim() === '' ? 0 : Math.max(0, Math.floor(Number(draft) || 0));
    setDraft(String(num));
    if (num !== value) onCommit(num);
  }, [draft, onCommit, value]);

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      enterKeyHint="done"
      autoComplete="off"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      className={`ff-qty-input${changed ? ' ff-qty-input--changed' : ''}`}
    />
  );
});
function applyProgress(items, sections = {}) {
  if (!sections || !Object.keys(sections).length) return items;
  const savedByKey = new Map();
  Object.values(sections).forEach((section) => {
    (section.items || []).forEach((saved) => {
      const key = saved.productId || saved.code;
      if (key) savedByKey.set(key, saved);
    });
  });
  return items.map((it) => {
    const key = it.productId || it.code;
    const saved = savedByKey.get(key);
    if (!saved) return it;
    return {
      ...it,
      finalQty: saved.finalQty ?? it.finalQty,
      removed: saved.removed ?? it.removed,
      swapped: saved.swapped ?? it.swapped,
      code: saved.code ?? it.code,
      name: saved.name ?? it.name,
      image: saved.image ?? it.image,
      unitPrice: saved.unitPrice ?? it.unitPrice,
      originalCode: saved.originalCode ?? it.originalCode,
      originalName: saved.originalName ?? it.originalName,
    };
  });
}

/**
 * `linkMode` means the page was opened from a signed WhatsApp link rather than
 * an admin session. The packing work is identical; what differs is that there
 * is no dashboard to navigate back to, and the link may not advance the order
 * to "sent" or email the customer — an owner does that from the dashboard.
 */
export default function FulfillmentPage({ linkMode: linkModeProp = false }) {
  const { orderId, token } = getOrderAccessFromUrl();
  const linkMode = linkModeProp || Boolean(token);

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [progress, setProgress] = useState({ sections: {} });
  const [users, setUsers] = useState([]);
  const [activeUserId, setActiveUserId] = useState(loadActiveUserId);
  const [userNotes, setUserNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [itemSavingKeys, setItemSavingKeys] = useState(() => new Set());
  const [statusMsg, setStatusMsg] = useState(null);

  const [editingItemIdx, setEditingItemIdx] = useState(null);
  const [swapSearch, setSwapSearch] = useState('');
  const [swapResults, setSwapResults] = useState([]);
  const [swapLoading, setSwapLoading] = useState(false);
  const swapTimerRef = useRef(null);
  const userPickerRef = useRef(null);
  const [userPickerOpen, setUserPickerOpen] = useState(false);
  const [categoryLabels, setCategoryLabels] = useState({ uncategorized: 'Other / Uncategorized' });
  const [lightboxImage, setLightboxImage] = useState('');

  const activeUser = useMemo(
    () => users.find((u) => u.id === activeUserId) || null,
    [users, activeUserId],
  );
  const victorCanSave = isVictorSender(activeUser);

  const assignedCategorySet = useMemo(
    () => new Set(activeUser?.categoryIds || []),
    [activeUser],
  );

  // Ticks the server has not confirmed yet, keyed by item. EVERY server
  // snapshot (poll, focus refresh, another tick's response) is overlaid with
  // these before it touches the screen — a snapshot taken before a tick was
  // written can never untick it. The old in-flight counter missed two races:
  // a poll that STARTED before a tick but resolved after its save finished,
  // and two ticks whose responses arrived out of order.
  const pendingTicksRef = useRef(new Map());
  const lastTickAtRef = useRef(0);

  const overlayPendingTicks = useCallback((data) => {
    if (!pendingTicksRef.current.size) return data;
    const map = { ...(data.items || {}) };
    for (const [key, pending] of pendingTicksRef.current) {
      if (pending.checked) map[key] = pending.entry;
      else delete map[key];
    }
    return { ...data, items: map };
  }, []);

  const refreshProgress = useCallback(async () => {
    if (!orderId) return;
    const startedAt = Date.now();
    try {
      const data = await fetchFulfillmentProgress(orderId);
      // The snapshot predates a tick made while it was in flight — discard it;
      // the tick's own response (or the next poll) carries fresher state.
      if (lastTickAtRef.current > startedAt) return;
      setProgress(overlayPendingTicks(data));
      setItems((prev) => applyProgress(prev, data.sections));
    } catch {}
  }, [orderId, overlayPendingTicks]);

  useEffect(() => {
    if (!orderId) { setError('No order ID in URL.'); setLoading(false); return; }

    Promise.all([
      fetch(`/api/admin-orders?id=${orderId}`).then((r) => r.json()),
      fetchFulfillmentUsers(),
      fetchFulfillmentProgress(orderId),
      fetchTaxonomy(),
    ])
      .then(async ([orderData, userRows, progressData, taxonomyRows]) => {
        const row = orderData.rows?.[0];
        // Surface the server's reason — "this link has expired" is a very
        // different problem from "order not found", and a packer standing in
        // the warehouse needs to be told which one it is.
        if (!row) throw new Error(orderData.error || 'Order not found');
        setOrder(row);
        setUsers(userRows);
        setProgress(progressData);
        const labels = { uncategorized: 'Other / Uncategorized' };
        for (const cat of taxonomyRows || []) labels[cat.id] = cat.label;
        setCategoryLabels(labels);

        const rawItems = (row.original_items || row.items || []).map((it, idx) => ({
          ...it,
          idx,
          finalQty: it.qty,
          removed: false,
          swapped: false,
        }));

        const ids = [...new Set(rawItems.map((i) => i.productId).filter(Boolean))];
        const catMap = await lookupProductCategories(ids);
        const enriched = rawItems.map((it) => ({
          ...it,
          mainCategoryId: catMap[it.productId]?.category || 'uncategorized',
          mainCategoryLabel: catMap[it.productId]?.categoryLabel || labels[catMap[it.productId]?.category] || labels.uncategorized,
        }));

        setItems(applyProgress(enriched, progressData.sections));

        const storedUser = loadActiveUserId();
        if (storedUser && userRows.some((u) => u.id === storedUser)) {
          setActiveUserId(storedUser);
        } else if (userRows[0]?.id) {
          setActiveUserId(userRows[0].id);
          saveActiveUserId(userRows[0].id);
        }
      })
      .catch((e) => setError(e.message || 'Failed to load order'))
      .finally(() => setLoading(false));
  }, [orderId]);

  useEffect(() => {
    if (!orderId || loading) return undefined;
    const refreshUsers = () => {
      void fetchFulfillmentUsers().then(setUsers).catch(() => {});
    };
    const iv = setInterval(() => { void refreshProgress(); }, 30000);
    const onFocus = () => {
      void refreshProgress();
      refreshUsers();
    };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus); };
  }, [orderId, loading, refreshProgress]);

  useEffect(() => {
    if (!userPickerOpen) return undefined;
    const h = (e) => { if (userPickerRef.current && !userPickerRef.current.contains(e.target)) setUserPickerOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [userPickerOpen]);

  const categoryGroups = useMemo(() => {
    const map = new Map();
    items.forEach((item, idx) => {
      const catId = item.mainCategoryId || 'uncategorized';
      if (!map.has(catId)) {
        map.set(catId, {
          id: catId,
          label: item.mainCategoryLabel || categoryLabels[catId] || catId,
          items: [],
        });
      }
      map.get(catId).items.push({ ...item, idx });
    });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [items, categoryLabels]);

  const updateItem = (idx, patch) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const canEditCategory = (categoryId) => {
    if (activeUser?.isAdmin) return true;
    if (assignedCategorySet.has(categoryId)) return true;
    for (const [legacy, current] of Object.entries(LEGACY_NAV_ALIASES)) {
      if (current === categoryId && assignedCategorySet.has(legacy)) return true;
    }
    return categoryId === 'uncategorized' && assignedCategorySet.has('uncategorized');
  };

  const itemKeyOf = (item) => String(item.idx);
  const isItemPacked = (item) => Boolean(progress.items?.[itemKeyOf(item)]);
  const itemPackedBy = (item) => progress.items?.[itemKeyOf(item)]?.userName || '';

  // Per-item packed toggle — the fulfilment checklist. Optimistic, reconciled
  // with the server response, reverted on failure. Any assigned picker for the
  // item's category can tick it.
  const toggleItemPacked = async (item, categoryId) => {
    if (!activeUser || !orderId || !canEditCategory(categoryId)) return;
    const key = itemKeyOf(item);
    if (itemSavingKeys.has(key)) return;
    const next = !isItemPacked(item);

    const entry = { userId: activeUser.id, userName: activeUser.name, checkedAt: new Date().toISOString() };
    lastTickAtRef.current = Date.now();
    pendingTicksRef.current.set(key, { checked: next, entry });
    setItemSavingKeys((prev) => new Set(prev).add(key));
    setProgress((prev) => {
      const map = { ...(prev.items || {}) };
      if (next) map[key] = entry;
      else delete map[key];
      return { ...prev, items: map };
    });

    try {
      const data = await toggleFulfillmentItem({
        orderId,
        userId: activeUser.id,
        userName: activeUser.name,
        itemKey: key,
        checked: next,
      });
      // Bump the watermark to the RESPONSE time, not just the request time.
      // A poll that started while this tick was in flight carries pre-tick
      // state; once the pending entry below is dropped there is nothing left
      // to overlay it with, so that poll would untick the item on screen.
      // Comparing against the response time discards exactly those polls.
      lastTickAtRef.current = Date.now();
      pendingTicksRef.current.delete(key);
      // Overlay OTHER in-flight ticks so this response cannot untick them.
      setProgress(overlayPendingTicks(data));
    } catch (e) {
      // Same watermark bump on failure: the revert below is the truth, and a
      // poll still in flight must not resurrect the optimistic value.
      lastTickAtRef.current = Date.now();
      pendingTicksRef.current.delete(key);
      setProgress((prev) => {
        const map = { ...(prev.items || {}) };
        if (next) delete map[key];
        else map[key] = entry;
        return { ...prev, items: map };
      });
      setStatusMsg({ type: 'err', text: e.message });
    } finally {
      setItemSavingKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const autoNotes = useMemo(() => {
    const lines = [];
    items.forEach((item) => {
      if (item.removed) lines.push(`${item.code} — ${item.name}: Out of stock`);
      else if (item.swapped) lines.push(`${item.originalCode} — ${item.originalName}: Substituted with ${item.code}`);
      else if (item.finalQty !== item.qty) lines.push(`${item.code} — ${item.name}: Qty ${item.qty} → ${item.finalQty}`);
    });
    return lines.join('\n');
  }, [items]);

  const handleSwapSearch = (q) => {
    setSwapSearch(q);
    clearTimeout(swapTimerRef.current);
    if (!q.trim()) { setSwapResults([]); return; }
    swapTimerRef.current = setTimeout(async () => {
      setSwapLoading(true);
      try {
        setSwapResults(await searchReplacementProducts(q));
      } catch {
        setSwapResults([]);
      } finally { setSwapLoading(false); }
    }, 350);
  };

  const swapItem = (idx, product) => {
    setItems((prev) => prev.map((it, i) => i !== idx ? it : {
      ...it,
      productId: product.id,
      code: product.code,
      name: product.name,
      image: product.image || '',
      unitPrice: product.price,
      mainCategoryId: product.category || it.mainCategoryId,
      mainCategoryLabel: product.categoryLabel || it.mainCategoryLabel,
      swapped: true,
      originalCode: it.swapped ? it.originalCode : it.code,
      originalName: it.swapped ? it.originalName : it.name,
    }));
    setEditingItemIdx(null);
    setSwapSearch('');
    setSwapResults([]);
  };

  const total = items.filter((it) => !it.removed).reduce((s, it) => s + it.finalQty * (it.unitPrice || it.price || 0), 0);
  const hasPrices = items.some((it) => it.unitPrice || it.price);
  const buildFinalItems = () => items.filter((it) => !it.removed).map(({ removed, finalQty, swapped, originalCode, originalName, idx, mainCategoryId, mainCategoryLabel, ...rest }) => ({ ...rest, qty: finalQty }));

  /**
   * Save the packed quantities, substitutions and notes WITHOUT advancing the
   * workflow. This is what a link user does: their picking work is recorded on
   * the order, and an owner sends it to the customer from the dashboard.
   */
  const doSavePacking = async () => {
    if (!activeUser) {
      setStatusMsg({ type: 'err', text: 'Choose who you are working as first.' });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/admin-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: orderId,
          final_items: buildFinalItems(),
          ...(userNotes.trim() ? { notes: userNotes.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      setStatusMsg({ type: 'ok', text: 'Packing saved. The office can see your changes.' });
    } catch (e) {
      setStatusMsg({ type: 'err', text: e.message });
    } finally { setSaving(false); }
  };

  const doSave = async () => {
    if (!victorCanSave) {
      setStatusMsg({ type: 'err', text: CUSTOMER_SEND_FORBIDDEN });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/admin-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: orderId,
          final_items: buildFinalItems(),
          ...(userNotes.trim() ? { notes: userNotes.trim() } : {}),
          advanceWorkflow: 'order sent',
          senderUserId: activeUser?.id || '',
          senderName: activeUser?.name || '',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      const adminUrl = `/?section=orders&orderTab=sent&focusOrder=${encodeURIComponent(orderId)}`;
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.location.href = adminUrl;
          window.opener.focus();
          window.close();
          return;
        } catch {
          // Fall through to same-tab navigation.
        }
      }
      window.location.replace(adminUrl);
    } catch (e) { setStatusMsg({ type: 'err', text: e.message }); }
    finally { setSaving(false); }
  };

  // Close this fulfilment tab safely. Only call window.close() when we actually
  // have a live opener (i.e. this really is a script-opened child tab of the
  // admin window). Blind-calling window.close() could take the admin tab down
  // when the page was opened without an opener or in the same tab — instead we
  // just navigate back to the dashboard in that case.
  const closeFulfillment = () => {
    if (window.opener && !window.opener.closed) {
      try { window.opener.focus(); } catch { /* cross-window focus can throw */ }
      window.close();
      return;
    }
    // A link user has no dashboard — sending them to /?section=orders would
    // dump them on the admin login screen for an account they do not have.
    if (linkMode) {
      setStatusMsg({ type: 'ok', text: 'All done — you can close this tab. Reopen the WhatsApp link any time.' });
      return;
    }
    window.location.assign('/?section=orders');
  };

  const previewPdf = async () => {
    setPreviewing(true);
    try {
      const emailItems = createEmailOrderItems(items);
      const pdfBase64 = await generateOrderPdfBase64({
        order,
        items: emailItems,
        autoNotes,
        userNotes,
        assignedTo: activeUser?.name,
        total: hasPrices ? total : null,
        hasPrices,
        checkboxes: true,
      });
      openPdfBase64Preview(pdfBase64, `proto-order-${displayOrderNumber(order)}.pdf`);
    } catch (e) {
      setStatusMsg({ type: 'err', text: e.message || 'Could not generate PDF preview' });
    } finally { setPreviewing(false); }
  };

  const renderItemRow = (item, editable) => {
    const idx = item.idx;
    const packed = isItemPacked(item);
    const packedBy = itemPackedBy(item);
    const itemBusy = itemSavingKeys.has(itemKeyOf(item));
    return (
      <div key={`${item.productId || item.code}-${idx}`}>
        <div className={`ff-item-row${item.removed ? ' ff-item-row--removed' : ''}${!editable ? ' ff-item-row--readonly' : ''}${packed ? ' ff-item-row--packed' : ''}`}>
          <button
            type="button"
            className={`ff-item-check${packed ? ' ff-item-check--on' : ''}`}
            disabled={!editable || item.removed || itemBusy}
            onClick={() => void toggleItemPacked(item, item.mainCategoryId)}
            aria-pressed={packed}
            aria-label={packed ? 'Packed — tap to undo' : 'Mark as packed'}
            title={packed
              ? `Packed${packedBy ? ` by ${packedBy}` : ''}${editable ? ' — tap to undo' : ''}`
              : (item.removed ? 'Out of stock' : 'Mark as packed')}
          >
            {itemBusy ? <Loader2 size={15} className="star-spinning" /> : packed ? <Check size={15} strokeWidth={3} /> : null}
          </button>
          <div className="ff-item-img">
            {item.image ? (
              <button type="button" className="ff-item-img-btn" onClick={() => setLightboxImage(item.image)} aria-label="View product image">
                <img src={item.image} alt="" />
              </button>
            ) : <span>IMG</span>}
          </div>
          <div className="ff-item-body">
            <div className="ff-item-code">{item.code}</div>
            <div className="ff-item-name">{item.name}</div>
            {!item.removed ? (
              <div className="ff-qty-row">
                <span className="ff-qty-label">Ordered <strong>{item.qty}</strong></span>
                <span className="ff-qty-arrow" aria-hidden>→</span>
                <QtyInput
                  value={item.finalQty}
                  disabled={!editable}
                  changed={item.finalQty !== item.qty}
                  onCommit={(num) => updateItem(idx, { finalQty: num })}
                />
              </div>
            ) : <span className="ff-oos">Out of stock</span>}
            {hasPrices && !item.removed && (
              <div className="ff-item-price" style={{ marginTop: 6, fontSize: 12, color: '#374151' }}>
                R {(item.unitPrice || item.price || 0).toFixed(2)} each · line R {(item.finalQty * (item.unitPrice || item.price || 0)).toFixed(2)}
              </div>
            )}
          </div>
          {editable && (
            <div className="ff-item-actions">
              <button type="button" className="ff-icon-btn" onClick={() => setEditingItemIdx(editingItemIdx === idx ? null : idx)} title="Replace"><Pencil size={14} /></button>
              <button type="button" className={`ff-icon-btn${item.removed ? ' ff-icon-btn--restore' : ' ff-icon-btn--remove'}`} onClick={() => updateItem(idx, { removed: !item.removed })} title={item.removed ? 'Restore' : 'Out of stock'}>
                {item.removed ? <Check size={14} /> : <X size={14} />}
              </button>
            </div>
          )}
          {!editable && <Lock size={14} className="ff-lock-icon" />}
        </div>
        {editable && editingItemIdx === idx && (
          <div className="ff-swap-panel">
            <div className="ff-swap-search">
              <Search size={14} />
              <input autoFocus value={swapSearch} onChange={(e) => handleSwapSearch(e.target.value)} placeholder="Search replacement…" />
              {swapLoading && <Loader2 size={13} className="star-spinning" />}
            </div>
            {swapResults.map((p) => (
              <button key={p.id} type="button" className="ff-swap-result" onClick={() => swapItem(idx, p)}>
                <span className="ff-swap-code">{p.code}</span>
                <span className="ff-swap-name">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (loading) return <div className="ff-center"><Loader2 size={36} className="star-spinning" style={{ color: '#c40000' }} /></div>;
  if (error) return <div className="ff-center"><p style={{ color: '#c40000', fontWeight: 700 }}>{error}</p></div>;

  // A section is "packed" when every in-stock (non-removed) line in it is ticked.
  const groupPackable = (g) => g.items.filter((i) => !i.removed);
  const groupPackedCount = (g) => groupPackable(g).filter(isItemPacked).length;
  const isGroupComplete = (g) => {
    const packable = groupPackable(g);
    // A section with nothing left to pack (every line out of stock) is done —
    // otherwise the progress bar could never reach 100% for such an order.
    if (g.items.length > 0 && packable.length === 0) return true;
    return packable.length > 0 && packable.every(isItemPacked);
  };
  const completedCount = categoryGroups.filter(isGroupComplete).length;
  const totalSections = categoryGroups.length;
  const completionPct = totalSections ? Math.round((completedCount / totalSections) * 100) : 0;
  const orderRef = displayOrderNumber(order);
  // In link mode the signed URL currently in the address bar is the one worth
  // keeping — buildFulfillmentUrl() drops the token and would hand the packer
  // a bookmark that only opens for a signed-in admin.
  const fulfillmentLink = linkMode ? window.location.href : buildFulfillmentUrl(order?.id);

  return (
    <div className="ff-page">
      <header className="ff-header">
        <div className="ff-header__title">
          <ClipboardList size={18} />
          <div>
            <div className="ff-header__main">Order {orderRef}</div>
            <div className="ff-header__sub">{new Date(order.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} · {order.customers?.name || 'Customer'}</div>
          </div>
        </div>
        <button type="button" onClick={closeFulfillment} className="ff-close-btn" aria-label="Close">
          <X size={18} />
        </button>
      </header>

      <div className="ff-body">
        <div className="ff-order-id-card">
          <div className="ff-order-id-label">Order ID</div>
          <div className="ff-order-id-value">{orderRef}</div>
          <p className="ff-order-id-note">
            Bookmark or save this link to reopen this order in the fulfilment tab anytime.
          </p>
          <a className="ff-order-id-link" href={fulfillmentLink} target="_blank" rel="noopener noreferrer">
            {fulfillmentLink}
          </a>
        </div>

        <div className="ff-hero">
          <div className="ff-hero-meta">
            <div className="ff-hero-customer">{order.customers?.name || 'Customer'}</div>
            <div className="ff-hero-email">{order.customers?.email || '—'}</div>
            {order.delivery_method && (
              <div className="ff-hero-delivery">🚚 {formatDeliveryMethod(order.delivery_method)}</div>
            )}
          </div>
          <div className="ff-hero-progress" aria-label={`${completedCount} of ${totalSections} sections complete`}>
            <div className="ff-hero-progress__bar"><div className="ff-hero-progress__fill" style={{ width: `${completionPct}%` }} /></div>
            <div className="ff-hero-progress__text">{completedCount}/{totalSections} sections</div>
          </div>
        </div>

        <div className="ff-user-card">
          <div className="ff-user-label">Working as</div>
          <div ref={userPickerRef} className="ff-user-picker">
            <button type="button" className="ff-user-btn" onClick={() => setUserPickerOpen((o) => !o)} aria-expanded={userPickerOpen}>
              <User size={16} />
              <span>{activeUser?.name || 'Select user'}</span>
              <span className="ff-user-chevron" aria-hidden>▾</span>
            </button>
            {userPickerOpen && (
              <div className="ff-user-menu" role="menu">
                {users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    role="menuitem"
                    className={u.id === activeUserId ? 'ff-user-menu-item ff-user-menu-item--active' : 'ff-user-menu-item'}
                    onClick={() => { setActiveUserId(u.id); saveActiveUserId(u.id); setUserPickerOpen(false); }}
                  >
                    {u.name}
                    {isVictorSender(u) && <span className="ff-user-badge">Can send</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {linkMode ? (
          <div className="ff-victor-notice" role="note">
            Tick items as you pack them and edit quantities freely, then tap <strong>Save packing</strong>.
            The office sends the order to the customer once you are done.
          </div>
        ) : !victorCanSave && (
          <div className="ff-victor-notice" role="note">
            Tick items as you pack them and edit quantities freely. Only <strong>Victor</strong> can send the order.
          </div>
        )}

        {categoryGroups.map((group) => {
          const editable = canEditCategory(group.id);
          const isComplete = isGroupComplete(group);
          const packable = groupPackable(group).length;
          const packedCount = groupPackedCount(group);

          return (
            <section key={group.id} className={`ff-section${isComplete ? ' ff-section--complete' : ''}${!editable ? ' ff-section--locked' : ''}`}>
              <div className="ff-section-head">
                <div className="ff-section-titles">
                  <h3>{group.label}</h3>
                  <span className="ff-section-meta">
                    {isComplete
                      ? <><Check size={11} strokeWidth={3} /> All packed</>
                      : `${packedCount}/${packable || group.items.length} packed`}
                  </span>
                </div>
                <div className={`ff-section-count${isComplete ? ' ff-section-count--done' : ''}`} aria-hidden>
                  {isComplete ? <Check size={18} strokeWidth={3} /> : `${packedCount}/${packable || group.items.length}`}
                </div>
              </div>
              <div className="ff-section-items">
                {group.items.map((item) => renderItemRow(item, editable))}
              </div>
            </section>
          );
        })}

        {hasPrices && (
          <div className="ff-total">
            <span>Order total</span>
            <strong>R {total.toFixed(2)}</strong>
          </div>
        )}

        <label className="ff-notes-label">
          <span>Additional notes</span>
          <textarea
            className="ff-notes"
            value={userNotes}
            onChange={(e) => setUserNotes(e.target.value)}
            rows={3}
            placeholder="Anything the customer should know…"
          />
        </label>

        {statusMsg && <div className={`ff-status ff-status--${statusMsg.type}`}>{statusMsg.text}</div>}
      </div>

      <div className="ff-action-bar">
        <button type="button" onClick={() => void previewPdf()} disabled={previewing || saving} className="ff-btn-secondary" aria-label="Preview PDF">
          {previewing ? <Loader2 size={16} className="star-spinning" /> : <FileText size={16} />}
          <span>{previewing ? 'PDF…' : 'Preview PDF'}</span>
        </button>
        {linkMode ? (
          <button type="button" onClick={() => void doSavePacking()} disabled={saving || previewing || !activeUser} className="ff-btn-send">
            {saving ? <Loader2 size={16} className="star-spinning" /> : <Check size={16} />}
            <span>{saving ? 'Saving…' : 'Save packing'}</span>
          </button>
        ) : victorCanSave ? (
          <button type="button" onClick={() => void doSave()} disabled={saving || previewing} className="ff-btn-send">
            {saving ? <Loader2 size={16} className="star-spinning" /> : <Check size={16} />}
            <span>{saving ? 'Saving…' : 'Save order'}</span>
          </button>
        ) : (
          <div className="ff-btn-victor-gate" role="note">
            Only <strong>Victor</strong> can save and send orders
          </div>
        )}
      </div>

      {lightboxImage && (
        <div className="ff-lightbox" role="dialog" aria-modal="true" onClick={() => setLightboxImage('')}>
          <button type="button" className="ff-lightbox-close" onClick={() => setLightboxImage('')} aria-label="Close image">
            <X size={22} />
          </button>
          <img src={lightboxImage} alt="Product" className="ff-lightbox-img" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
