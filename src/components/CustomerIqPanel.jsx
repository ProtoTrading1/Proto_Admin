import React, { useMemo } from 'react';
import { Bot, Clock3, Database, Lightbulb, Loader2, PackageSearch, ShoppingBag } from 'lucide-react';
import { buildCustomerIq } from '../lib/customerIq';

const rand = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });

function formatDate(value) {
  if (!value) return 'No date recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date recorded';
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Metric({ label, value, hint }) {
  return (
    <div className="adm-iq-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function CustomerIqPanel({ customer, orders, totalOrders, source, loading = false, loadError = '' }) {
  const iq = useMemo(
    () => buildCustomerIq({ customer, orders, totalOrders, source }),
    [customer, orders, totalOrders, source],
  );
  const metrics = iq.metrics;

  return (
    <section className="adm-iq" aria-labelledby="customer-iq-heading">
      <div className="adm-iq-head">
        <div>
          <span className="adm-iq-kicker"><Bot size={14} aria-hidden="true" /> Customer intelligence</span>
          <h3 id="customer-iq-heading">Customer IQ</h3>
          <p>{iq.customer.name}{iq.customer.assignedCode ? ` · ${iq.customer.assignedCode}` : ''}</p>
          <small>A factual staff brief from the information currently available.</small>
        </div>
        <span className={`adm-iq-status adm-iq-status--${iq.status.tone}`}>{iq.status.label}</span>
      </div>

      {loading ? (
        <div className="adm-iq-state"><Loader2 size={15} className="spin" /> Analysing recorded orders…</div>
      ) : (
        <>
          {loadError && <div className="adm-iq-warning">Order history could not be loaded. The brief below uses account and application data only.</div>}
          <p className="adm-iq-explanation">{iq.status.explanation}</p>

          <div className="adm-iq-metrics">
            <Metric label={metrics.spendLabel} value={rand.format(metrics.spend)} />
            <Metric label={metrics.orderCountLabel} value={whole.format(metrics.recordedOrderCount)} />
            <Metric label="Last recorded order" value={metrics.daysSinceOrder == null ? '—' : `${metrics.daysSinceOrder} days ago`} hint={formatDate(metrics.lastOrder)} />
            <Metric label="Recent order rhythm" value={metrics.rhythmDays ? `${Math.round(metrics.rhythmDays)} days` : 'Not enough data'} hint={metrics.rhythmDays ? 'Median interval' : 'Needs at least 2 dated orders'} />
          </div>

          {iq.signals.length > 0 && (
            <div className="adm-iq-section">
              <h4><Lightbulb size={15} aria-hidden="true" /> Brief and next step</h4>
              <div className="adm-iq-signals">
                {iq.signals.map((signal) => (
                  <div className={`adm-iq-signal adm-iq-signal--${signal.tone}`} key={signal.key}>
                    <strong>{signal.label}</strong>
                    <span>{signal.detail}</span>
                    <small>{signal.source}</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="adm-iq-section">
            <h4><PackageSearch size={15} aria-hidden="true" /> Repeat-product shortlist</h4>
            {iq.reorderProducts.length ? (
              <div className="adm-iq-reorders">
                {iq.reorderProducts.map((product) => (
                  <div className="adm-iq-reorder" key={`${product.sku}-${product.name}`}>
                    <ShoppingBag size={14} aria-hidden="true" />
                    <div>
                      <strong>{product.name}</strong>
                      <span>{product.sku ? `${product.sku} · ` : ''}Seen in {product.orderCount} loaded orders</span>
                    </div>
                    <div className="adm-iq-reorder-meta">
                      <strong>{product.typicalQuantity ? `Usually ${whole.format(product.typicalQuantity)}` : 'Qty unavailable'}</strong>
                      <span>Last {formatDate(product.lastPurchased)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="adm-iq-empty">
                {source === 'proto-active'
                  ? 'Product-level Positill history is not connected for this customer yet.'
                  : 'No product appears in two or more of the loaded portal orders yet.'}
              </div>
            )}
          </div>

          <footer className="adm-iq-foot">
            <span><Database size={13} aria-hidden="true" /> {iq.evidence.sources.join(' · ') || 'No supporting history yet'}{iq.evidence.partial ? ' · Partial history' : ''}</span>
            <span><Clock3 size={13} aria-hidden="true" /> Generated now</span>
          </footer>
          <p className="adm-iq-safety">{iq.evidence.note}</p>
        </>
      )}
    </section>
  );
}
