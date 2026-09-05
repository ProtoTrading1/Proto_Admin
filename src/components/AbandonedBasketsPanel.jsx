/**
 * Abandoned Baskets — who is sitting on a basket they never checked out,
 * what is in it, and everything needed to chase it.
 *
 * Layout follows the sibling analytics dashboards: `.oa-dashboard` root, a
 * `.oa-toolbar`, a bare `.oa-stat-grid`, then `.oa-panel` sections. Headings
 * rely on `.oa-panel h3` / `.oa-subhead` rather than restyling type locally.
 *
 * All money here is VAT-INCLUSIVE: storefront prices already include VAT, and
 * the basket stores the storefront price. The labels say so on purpose.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, Download, Infinity as InfinityIcon,
  Loader2, RefreshCw, Search,
} from 'lucide-react';
import { downloadCsv } from '../lib/exportReport';
import {
  basketExportRows, filterBaskets, sortBaskets, summariseBaskets,
} from '../../lib/abandoned-baskets.mjs';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

const STALENESS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Still shopping' },
  { key: 'cooling', label: 'Cooling off' },
  { key: 'stale', label: 'Gone cold' },
];

const SORTS = [
  { key: 'value', label: 'Basket value' },
  { key: 'recent', label: 'Most recent' },
  { key: 'oldest', label: 'Longest idle' },
  { key: 'lines', label: 'Most items' },
  { key: 'name', label: 'Customer name' },
];

/** The list is a worklist, not an archive — show a handful, reveal more on demand. */
const PAGE_SIZES = [10, 25, 50, 0];
const PAGE_SIZE_LABELS = { 0: 'Show all' };

const STALENESS_LABELS = {
  active: 'Still shopping',
  cooling: 'Cooling off',
  stale: 'Gone cold',
  unknown: 'Unknown',
};

function money(value) {
  return `R ${Number(value || 0).toLocaleString('en-ZA', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function moneyExact(value) {
  return `R ${Number(value || 0).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function idleLabel(ageDays) {
  if (ageDays === null || ageDays === undefined) return 'Unknown';
  if (ageDays < 1) return 'Today';
  if (ageDays < 2) return '1 day';
  return `${Math.floor(ageDays)} days`;
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Same thumbnail treatment as Product Manager, at basket-line size. */
function ProductThumb({ item }) {
  if (!item.image) {
    return <div className="adm-product-thumb adm-product-thumb--placeholder ab-thumb">IMG</div>;
  }
  return (
    <img
      src={item.image}
      alt=""
      loading="lazy"
      decoding="async"
      className="adm-product-thumb ab-thumb"
    />
  );
}

function CustomerDetail({ basket }) {
  const rows = [
    ['Email', basket.email || '—'],
    ['Phone', basket.phone || '—'],
    ['Business', basket.businessName || '—'],
    ['Customer code', basket.customerCode || 'Not allocated'],
    ['Tier', basket.tier || '—'],
    ['Location', [basket.city, basket.province].filter(Boolean).join(', ') || '—'],
    ['Customer since', dateLabel(basket.customerSince)],
    ['Last purchase', dateLabel(basket.lastPurchaseDate)],
    ['Sales (12m)', basket.salesLast12Months === null ? '—' : money(basket.salesLast12Months)],
    ['Last email', basket.lastEmailType
      ? `${basket.lastEmailType} · ${dateLabel(basket.lastEmailAt)}`
      : 'None recorded'],
  ];

  return (
    <div className="ab-detail-customer">
      <div className="oa-subhead">Customer</div>
      <dl className="ab-detail-list">
        {rows.map(([label, value]) => (
          <div key={label} className="ab-detail-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {basket.tags?.length > 0 && (
        <div className="ab-tags">
          {basket.tags.map((tag) => <span key={tag} className="ab-tag">{tag}</span>)}
        </div>
      )}
    </div>
  );
}

function BasketLines({ basket, markingActive, onMarkActive }) {
  return (
    <div className="ab-detail-basket">
      <div className="ab-detail-basket-head">
        <div>
          <div className="oa-subhead">
            {basket.lineCount} {basket.lineCount === 1 ? 'product' : 'products'} in the basket
          </div>
          <span className="ab-kept-note"><InfinityIcon size={14} /> Saved indefinitely until the customer clears or submits it</span>
        </div>
        {basket.staleness !== 'active' && (
          <button
            type="button"
            className="adm-btn-ghost"
            disabled={markingActive}
            onClick={(event) => { event.stopPropagation(); onMarkActive(basket); }}
          >
            {markingActive ? <Loader2 size={15} className="star-spinning" /> : <RefreshCw size={15} />}
            Mark active now
          </button>
        )}
      </div>
      <div className="ab-lines">
        {basket.items.map((item) => (
          <div key={`${item.sku}-${item.name}`} className="ab-line">
            <ProductThumb item={item} />
            <div className="ab-line-main">
              <div className="ab-line-name">{item.name}</div>
              <div className="ab-line-meta">
                <span className="ab-sku">{item.sku}</span>
                {!item.inStock && <span className="ab-badge ab-badge--warn">Out of stock</span>}
                {item.toOrder && <span className="ab-badge ab-badge--order">To order</span>}
              </div>
            </div>
            <div className="ab-line-qty">
              <span className="ab-line-qty-val">{item.qty}</span>
              <span className="ab-line-qty-label">qty</span>
            </div>
            <div className="ab-line-money">
              <div className="ab-line-total">{moneyExact(item.lineTotal)}</div>
              <div className="ab-line-unit">{moneyExact(item.price)} each</div>
            </div>
          </div>
        ))}
      </div>
      <div className="ab-lines-total">
        <span>Basket total (incl. VAT)</span>
        <strong>{moneyExact(basket.value)}</strong>
      </div>
    </div>
  );
}

export default function AbandonedBasketsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [staleness, setStaleness] = useState('all');
  const [sort, setSort] = useState('value');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [expanded, setExpanded] = useState(() => new Set());
  const [markingActiveId, setMarkingActiveId] = useState('');

  /**
   * One request, no parameters. Filtering, sorting and searching all run on
   * the data already in the browser — the endpoint reads every cart and the
   * customers behind them, so re-fetching it per keystroke was doing that work
   * again to answer a question the client could already answer. Refresh is the
   * only thing that goes back to the server.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/abandoned-baskets');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load abandoned baskets');
      setData(json);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'analytics') void load();
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load]);

  const toggle = useCallback((customerId) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  }, []);

  const allBaskets = useMemo(() => data?.baskets || [], [data]);
  const baskets = useMemo(
    () => sortBaskets(filterBaskets(allBaskets, { staleness, search }), sort),
    [allBaskets, staleness, search, sort],
  );
  // Export always covers the full filtered set, not just what is on screen.
  const visibleBaskets = useMemo(
    () => (pageSize > 0 ? baskets.slice(0, pageSize) : baskets),
    [baskets, pageSize],
  );
  const summary = data?.summary;
  const filtered = useMemo(() => summariseBaskets(baskets), [baskets]);
  const isFiltered = staleness !== 'all' || Boolean(search.trim());

  const handleExport = useCallback(() => {
    const rows = basketExportRows(baskets);
    if (!rows.length) return;
    const columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
    downloadCsv(`abandoned-baskets-${new Date().toISOString().slice(0, 10)}.csv`, columns, rows);
  }, [baskets]);

  const markActive = useCallback(async (basket) => {
    setMarkingActiveId(basket.customerId);
    setError('');
    try {
      const res = await fetch('/api/abandoned-baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-active', customerId: basket.customerId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to mark the basket active');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setMarkingActiveId('');
    }
  }, [load]);

  if (data && data.available === false) {
    return (
      <div className="oa-error">
        <AlertTriangle size={16} /> {data.reason}
      </div>
    );
  }

  return (
    <div className="oa-dashboard">
      <div className="oa-toolbar">
        <div className="oa-periods">
          {STALENESS_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`oa-period-btn${staleness === filter.key ? ' oa-period-btn--active' : ''}`}
              onClick={() => setStaleness(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={15} className="star-spinning" /> : <RefreshCw size={15} />}
            Refresh
          </button>
          <button type="button" className="adm-btn-ghost" onClick={handleExport} disabled={!baskets.length}>
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="oa-error">{error}</div>}

      {summary && (
        <div className="oa-stat-grid ab-stat-grid">
          <div className="oa-stat-card oa-stat-card--accent">
            <div className="oa-stat-val">{summary.basketCount}</div>
            <div className="oa-stat-label">Outstanding Baskets</div>
          </div>
          <div className="oa-stat-card">
            <div className="oa-stat-val">{money(summary.totalValue)}</div>
            <div className="oa-stat-label">Value At Risk (incl. VAT)</div>
          </div>
          <div className="oa-stat-card">
            <div className="oa-stat-val">{money(summary.avgValue)}</div>
            <div className="oa-stat-label">Average Basket</div>
          </div>
          <div className="oa-stat-card">
            <div className="oa-stat-val">{money(summary.biggestValue)}</div>
            <div className="oa-stat-label">Biggest Basket</div>
          </div>
          <div className="oa-stat-card">
            <div className="oa-stat-val">{summary.staleCount}</div>
            <div className="oa-stat-label">Gone Cold (30+ Days)</div>
          </div>
          <div className="oa-stat-card">
            <div className="oa-stat-val">{summary.totalUnits}</div>
            <div className="oa-stat-label">Units Waiting</div>
          </div>
        </div>
      )}

      <section className="oa-panel">
        <div className="oa-panel-head">
          <div>
            <h3>Abandoned Baskets</h3>
            <p className="oa-note ab-subtitle">
              Customers holding a basket they have not checked out. A basket is emptied
              automatically when the order is submitted, so everything below is still outstanding.
              All signed-in customer baskets are saved indefinitely; “gone cold” only means more than thirty days without activity.
            </p>
          </div>
          <div className="oa-panel-actions">
            <label className="ab-search">
              <Search size={14} />
              <input
                type="search"
                value={search}
                placeholder="Search customer, email, product or SKU…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <span className="oa-select-wrap">
              Show
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>{PAGE_SIZE_LABELS[size] || `${size} baskets`}</option>
                ))}
              </select>
            </span>
            <span className="oa-select-wrap">
              Sort by
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                {SORTS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </span>
          </div>
        </div>

        {isFiltered && filtered && summary && (
          <p className="oa-note">
            Showing <strong>{filtered.basketCount}</strong> of {summary.basketCount} baskets
            · <strong>{money(filtered.totalValue)}</strong> of {money(summary.totalValue)}
          </p>
        )}

        {loading && !data && (
          <div className="oa-loading"><Loader2 size={28} className="star-spinning" /></div>
        )}

        {data && !baskets.length && !loading && (
          <p className="oa-empty">
            {isFiltered
              ? 'No baskets match this filter.'
              : 'No outstanding baskets — every customer basket has been checked out or cleared.'}
          </p>
        )}

        {baskets.length > 0 && (
          <div className="oa-table-wrap">
            <table className="oa-table ab-table">
              <thead>
                <tr>
                  <th aria-label="Expand" />
                  <th>Customer</th>
                  <th>Contact</th>
                  <th>Basket</th>
                  <th className="ab-num">Items</th>
                  <th className="ab-num">Value</th>
                  <th className="ab-num">Idle</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleBaskets.map((basket) => {
                  const isOpen = expanded.has(basket.customerId);
                  return [
                    <tr
                      key={basket.customerId}
                      className={`ab-row${isOpen ? ' ab-row--open' : ''}`}
                      onClick={() => toggle(basket.customerId)}
                    >
                      <td className="ab-chevron">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </td>
                      <td>
                        <span className="ab-name">{basket.name}</span>
                        {basket.businessName && <span className="ab-business">{basket.businessName}</span>}
                        {basket.missing && (
                          <span className="ab-badge ab-badge--warn">No customer record</span>
                        )}
                      </td>
                      <td className="ab-contact">
                        {basket.email && <span>{basket.email}</span>}
                        {basket.phone && <span>{basket.phone}</span>}
                        {!basket.email && !basket.phone && <span>—</span>}
                      </td>
                      <td>
                        {/* A glance at the products beats reading a line count. */}
                        <div className="ab-preview">
                          {basket.items.slice(0, 4).map((item) => (
                            <ProductThumb key={`${item.sku}-${item.name}`} item={item} />
                          ))}
                          {basket.lineCount > 4 && (
                            <span className="ab-preview-more">+{basket.lineCount - 4}</span>
                          )}
                        </div>
                      </td>
                      <td className="ab-num">{basket.lineCount}</td>
                      <td className="ab-num ab-strong">{money(basket.value)}</td>
                      <td className="ab-num">{idleLabel(basket.ageDays)}</td>
                      <td>
                        <span className={`ab-badge ab-badge--${basket.staleness}`}>
                          {STALENESS_LABELS[basket.staleness] || basket.staleness}
                        </span>
                      </td>
                    </tr>,
                    isOpen && (
                      <tr key={`${basket.customerId}-detail`} className="ab-detail-row-wrap">
                        <td colSpan={8}>
                          <div className="ab-detail">
                            <CustomerDetail basket={basket} />
                            <BasketLines
                              basket={basket}
                              markingActive={markingActiveId === basket.customerId}
                              onMarkActive={markActive}
                            />
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}

        {baskets.length > visibleBaskets.length && (
          <p className="oa-note ab-more-note">
            Showing the top {visibleBaskets.length} of {baskets.length} by {SORTS.find((o) => o.key === sort)?.label.toLowerCase()}.
            {' '}
            <button type="button" className="ab-linkish" onClick={() => setPageSize(0)}>Show all</button>
            {' · Export CSV always covers all '}{baskets.length}.
          </p>
        )}
      </section>
    </div>
  );
}
