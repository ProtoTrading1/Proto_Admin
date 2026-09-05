import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Bot,
  CheckCircle,
  ClipboardList,
  Database,
  FileSearch,
  History,
  Lightbulb,
  Loader2,
  PackageSearch,
  Search,
  ShieldCheck,
  UserRoundCog,
} from 'lucide-react';
import CustomerApplicationDetails from './CustomerApplicationDetails';
import { buildCustomerIq, POSITILL_CUSTOMER_SALES_PERIOD } from '../lib/customerIq';
import { buildCustomerIntelligence } from '../lib/customerIntelligenceEngine';
import { businessSearchUrl, traderVerificationSummary } from '../lib/traderVerification';

const rand = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });

const TABS = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'buying', label: 'Buying activity', icon: History },
  { id: 'evidence', label: 'Application & evidence', icon: FileSearch },
  { id: 'staff', label: 'Staff context', icon: UserRoundCog },
];

const SCORE_COPY = {
  traderConfidence: { label: 'Trader confidence', description: 'Evidence that this is a genuine trade customer.' },
  customerPotential: { label: 'Customer potential', description: 'Commercial opportunity visible in the current record.' },
  engagementHealth: { label: 'Engagement health', description: 'How recently and consistently they have ordered.' },
  dataConfidence: { label: 'Data confidence', description: 'How complete and well-supported this brief is.' },
};

const BAND_COPY = {
  strong: 'Strong evidence',
  developing: 'Developing evidence',
  limited: 'Limited evidence',
  insufficient_data: 'Not enough data',
};

function formatDate(value) {
  if (!value) return 'No date recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date recorded';
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function orderAmount(order = {}) {
  const total = Number(order.total_ex_vat);
  if (Number.isFinite(total) && total > 0) return total;
  const items = order.final_items?.length ? order.final_items : order.original_items || order.items || [];
  return items.reduce((sum, item) => {
    const quantity = Number(item.finalQty ?? item.qty ?? item.quantity) || 0;
    const price = Number(item.unitPrice ?? item.price ?? item.unit_price) || 0;
    return sum + quantity * price;
  }, 0);
}

function ordersInLastDays(orders, days, now = new Date()) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return orders.filter((order) => {
    const date = new Date(order.created_at);
    return !Number.isNaN(date.getTime()) && date.getTime() >= cutoff;
  }).length;
}

function ScoreCard({ scoreKey, score }) {
  const copy = SCORE_COPY[scoreKey];
  const reason = score.reasons[0] || score.limitations[0] || 'No supporting evidence is recorded yet.';
  return (
    <article className={`adm-ci-score adm-ci-score--${score.band}`}>
      <span>{copy.label}</span>
      <strong>{BAND_COPY[score.band]}</strong>
      <p>{copy.description}</p>
      <small>{reason}</small>
    </article>
  );
}

function Metric({ label, value, hint }) {
  return (
    <div className="adm-ci-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function RecentOrders({ orders }) {
  if (!orders.length) return <div className="adm-ci-empty">No portal orders are recorded for this customer yet.</div>;
  return (
    <div className="adm-ci-orders">
      {orders.slice(0, 10).map((order) => (
        <article className="adm-ci-order" key={order.id || order.order_number || order.created_at}>
          <div>
            <strong>{order.order_number || String(order.id || 'Order').slice(0, 8)}</strong>
            <span>{formatDate(order.created_at)} · {order.status || 'Pending'}</span>
          </div>
          <strong>{rand.format(orderAmount(order))}</strong>
        </article>
      ))}
    </div>
  );
}

export default function CustomerIntelligenceWorkspace({ customer, orders = [], totalOrders = 0, source = 'portal', loading = false, loadError = '', onRetry, headerBadges = null }) {
  const [activeTab, setActiveTab] = useState('overview');
  useEffect(() => setActiveTab('overview'), [customer?.id]);

  const iq = useMemo(
    () => buildCustomerIq({ customer, orders, totalOrders, source }),
    [customer, orders, totalOrders, source],
  );
  const intelligence = useMemo(() => {
    const count = Number(totalOrders) || orders.length || Number(customer?.invoice_count) || 0;
    const spend = iq.metrics.spend;
    const recordedSales = Number(customer?.sales_last_12_months) || 0;
    const hasPositillSummary = source === 'proto-active'
      || Number(customer?.invoice_count) > 0
      || recordedSales > 0;
    const spendOrderCount = source === 'proto-active' ? count : orders.length;
    const hasBehaviouralEvidence = count > 0 || recordedSales > 0 || Boolean(iq.metrics.lastOrder);
    const orderSummary = hasBehaviouralEvidence ? {
      orderCount: count,
      recordedSales,
      salesPeriodLabel: hasPositillSummary ? `${POSITILL_CUSTOMER_SALES_PERIOD.label} sales` : 'Recorded sales',
      salesSnapshot: hasPositillSummary,
      averageOrderValue: spendOrderCount ? spend / spendOrderCount : 0,
      lastOrderDate: iq.metrics.lastOrder,
      ordersLast90Days: ordersInLastDays(orders, 90),
    } : {};
    return buildCustomerIntelligence({
      customer,
      orderSummary,
    });
  }, [customer, iq.metrics.lastOrder, iq.metrics.spend, orders, totalOrders]);

  const selectTab = (id) => setActiveTab(id);
  const onTabKeyDown = (event, index) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = TABS.length - 1;
    selectTab(TABS[next].id);
    document.getElementById(`customer-intelligence-tab-${TABS[next].id}`)?.focus();
  };

  const partialHistory = source !== 'proto-active' && Number(totalOrders) > orders.length;
  const verification = source !== 'proto-active' && !customer?.is_approved
    ? traderVerificationSummary(customer)
    : null;

  return (
    <section className="adm-ci" aria-labelledby="customer-intelligence-heading">
      <header className="adm-ci-head">
        <div>
          <span className="adm-ci-kicker"><Bot size={14} aria-hidden="true" /> Customer intelligence workspace</span>
          <div className="adm-ci-title-row"><h2 id="customer-intelligence-heading">{iq.customer.name}</h2>{headerBadges}</div>
          <p>{iq.customer.assignedCode ? `Customer code ${iq.customer.assignedCode} · ` : ''}{customer?.contact_name || customer?.name || 'Contact not recorded'}</p>
        </div>
        <span className={`adm-ci-status adm-ci-status--${iq.status.tone}`}>{iq.status.label}</span>
      </header>

      <div className="adm-ci-tabs" role="tablist" aria-label="Customer intelligence sections">
        {TABS.map((tab, index) => {
          const Icon = tab.icon;
          return (
            <button
              id={`customer-intelligence-tab-${tab.id}`}
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`customer-intelligence-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={activeTab === tab.id ? 'adm-ci-tab adm-ci-tab--active' : 'adm-ci-tab'}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <Icon size={14} aria-hidden="true" /> {tab.label}
            </button>
          );
        })}
      </div>

      {loading && <div className="adm-ci-notice" role="status"><Loader2 size={15} className="spin" /> Analysing recorded orders…</div>}
      {loadError && (
        <div className="adm-ci-warning" role="alert">
          <span>Order history could not be loaded. Guidance currently uses account and application data only.</span>
          {onRetry && <button type="button" className="adm-btn-ghost adm-btn-sm" onClick={onRetry}>Retry</button>}
        </div>
      )}
      {partialHistory && <div className="adm-ci-warning">Showing the latest {orders.length} of {totalOrders} portal orders. Spend, rhythm and repeat-product evidence are partial.</div>}
      {(source === 'proto-active' || Number(customer?.invoice_count) > 0 || Number(customer?.sales_last_12_months) > 0) && (
        <div className="adm-ci-warning">
          Imported Positill snapshot for {POSITILL_CUSTOMER_SALES_PERIOD.start}–{POSITILL_CUSTOMER_SALES_PERIOD.end}, {POSITILL_CUSTOMER_SALES_PERIOD.taxBasis}. Later transactions may not yet be included.
        </div>
      )}

      {activeTab === 'overview' && (
        <div id="customer-intelligence-panel-overview" role="tabpanel" aria-labelledby="customer-intelligence-tab-overview" className="adm-ci-panel">
          <section className={`adm-ci-action adm-ci-action--${intelligence.nextBestAction.priority}`}>
            <Lightbulb size={19} aria-hidden="true" />
            <div>
              <span>Recommended next staff action</span>
              <h3>{intelligence.nextBestAction.label}</h3>
              <p>{intelligence.nextBestAction.reason}</p>
              <small>{intelligence.nextBestAction.safeguards.join(' ')}</small>
            </div>
          </section>

          <div className="adm-ci-scores">
            {Object.entries(intelligence.scores).map(([key, score]) => <ScoreCard key={key} scoreKey={key} score={score} />)}
          </div>

          <div className="adm-ci-metrics">
            <Metric label={iq.metrics.spendLabel} value={rand.format(iq.metrics.spend)} />
            <Metric label={iq.metrics.orderCountLabel} value={whole.format(iq.metrics.recordedOrderCount)} />
            <Metric label="Last recorded order" value={iq.metrics.daysSinceOrder == null ? '—' : `${iq.metrics.daysSinceOrder} days ago`} hint={formatDate(iq.metrics.lastOrder)} />
            <Metric label="Recent order rhythm" value={iq.metrics.rhythmDays ? `${Math.round(iq.metrics.rhythmDays)} days` : 'Not enough data'} hint={iq.metrics.rhythmDays ? 'Median interval' : 'Needs at least 2 dated orders'} />
          </div>

          <p className="adm-ci-safety"><ShieldCheck size={14} aria-hidden="true" /> {intelligence.decisionSafety.statement}</p>
        </div>
      )}

      {activeTab === 'buying' && (
        <div id="customer-intelligence-panel-buying" role="tabpanel" aria-labelledby="customer-intelligence-tab-buying" className="adm-ci-panel">
          <section className="adm-ci-section">
            <h3><PackageSearch size={16} aria-hidden="true" /> Repeat-product shortlist</h3>
            {iq.reorderProducts.length ? (
              <div className="adm-ci-reorders">
                {iq.reorderProducts.map((product) => (
                  <article className="adm-ci-reorder" key={`${product.sku}-${product.name}`}>
                    <div><strong>{product.name}</strong><span>{product.sku || 'No product code'} · Seen in {product.orderCount} loaded orders</span></div>
                    <div><strong>{product.typicalQuantity ? `Usually ${whole.format(product.typicalQuantity)}` : 'Quantity unavailable'}</strong><span>Last {formatDate(product.lastPurchased)}</span></div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="adm-ci-empty">{source === 'proto-active' ? 'Product-level Positill history is not connected for this customer yet.' : 'No product appears in two or more loaded portal orders yet.'}</div>
            )}
          </section>
          <section className="adm-ci-section">
            <h3><ClipboardList size={16} aria-hidden="true" /> Recent portal orders</h3>
            {source === 'proto-active' ? <div className="adm-ci-empty">Portal order history is not linked to this pre-registration record.</div> : <RecentOrders orders={orders} />}
          </section>
        </div>
      )}

      {activeTab === 'evidence' && (
        <div id="customer-intelligence-panel-evidence" role="tabpanel" aria-labelledby="customer-intelligence-tab-evidence" className="adm-ci-panel">
          {verification && (
            <section className={`adm-trader-review adm-trader-review--${verification.tone}`} aria-label="Trader verification recommendation">
              <span className="adm-trader-review-kicker">Application evidence</span>
              <h3>{verification.recommendation}</h3>
              <p className="adm-trader-review-note">Evidence summary only — it is not a probability score. A staff member makes the final decision.</p>
              <div className="adm-trader-evidence-list">
                {verification.evidence.map((item) => (
                  <div className={`adm-trader-evidence adm-trader-evidence--${item.tone}`} key={item.label}>
                    {item.tone === 'neutral' || item.tone === 'review' ? <Search size={15} aria-hidden="true" /> : <CheckCircle size={15} aria-hidden="true" />}
                    <div><strong>{item.label}</strong><span>{item.detail}</span></div>
                  </div>
                ))}
              </div>
              <a className="adm-btn-ghost adm-btn-sm adm-ci-research" href={businessSearchUrl(customer)} target="_blank" rel="noreferrer" aria-label="Research business (opens in a new tab)">
                <Search size={13} aria-hidden="true" /> Research business
              </a>
            </section>
          )}
          {source !== 'proto-active' ? <CustomerApplicationDetails customer={customer} /> : <div className="adm-ci-empty">This pre-registration record does not contain an online trade application.</div>}
          <section className="adm-ci-evidence-scope">
            <h3><Database size={16} aria-hidden="true" /> Evidence scope</h3>
            <p>{iq.evidence.sources.join(' · ') || 'No supporting history yet'}{iq.evidence.partial ? ' · Partial history' : ''}</p>
            {intelligence.evidenceScope.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}
          </section>
        </div>
      )}

      {activeTab === 'staff' && (
        <div id="customer-intelligence-panel-staff" role="tabpanel" aria-labelledby="customer-intelligence-tab-staff" className="adm-ci-panel">
          <div className="adm-ci-staff-empty">
            <UserRoundCog size={28} aria-hidden="true" />
            <h3>Staff notes and follow-ups are not connected yet</h3>
            <p>The next phase will add an assigned owner, dated follow-up, staff notes and an audit trail. Nothing entered here is being simulated or stored in customer tags.</p>
          </div>
        </div>
      )}
    </section>
  );
}
