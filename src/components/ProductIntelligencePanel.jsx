import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Globe,
  Loader2,
  PackageSearch,
  Search,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import {
  fetchProductIntelligence,
  normalizePositillCode,
} from '../lib/productIntelligence';

function displayValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '—';
  return `${value}${suffix}`;
}

function displayMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return amount.toLocaleString('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function IntelligenceField({ label, value }) {
  return (
    <div className="intelligence-field">
      <dt>{label}</dt>
      <dd>{displayValue(value)}</dd>
    </div>
  );
}

function IntelligenceCard({ title, icon: Icon, children }) {
  return (
    <article className="intelligence-data-card">
      <h3><Icon size={17} /> {title}</h3>
      <dl>{children}</dl>
    </article>
  );
}

function EmptyState({ searchedCode }) {
  return (
    <div className="intelligence-empty" role="status">
      <PackageSearch size={34} />
      <strong>{searchedCode ? `No intelligence found for ${searchedCode}` : 'Look up a Positill product'}</strong>
      <span>
        {searchedCode
          ? 'Check the CODE and try again. No product information has been changed.'
          : 'Enter the exact Positill CODE to join the available Positill and website information.'}
      </span>
    </div>
  );
}

function ProductResult({ product, searchedCode }) {
  const positill = product.erp || {};
  const website = product.website || {};
  const buying = product.buying || {};
  const risks = Array.isArray(buying.risks) ? buying.risks : [];
  const degraded = product.status?.degraded;
  const code = product.code || positill.code || searchedCode;

  return (
    <div className="intelligence-result" aria-live="polite">
      <div className="intelligence-result__summary">
        <div>
          <span className="intelligence-result__code">{code}</span>
          <h3>{positill.title || website.title || 'Product description unavailable'}</h3>
          <p>{[positill.department, positill.supplier].filter(Boolean).join(' · ') || 'Department and supplier not yet available'}</p>
        </div>
        <span className="intelligence-readonly"><ShieldCheck size={15} /> Read-only result</span>
      </div>

      <div className="intelligence-data-grid">
        <IntelligenceCard title="Positill" icon={Boxes}>
          <IntelligenceField label="Source" value={product.sources?.erp === 'erp_sql' ? 'Live Positill' : (product.sources?.erp === 'stmast_cache' ? 'Approved cache' : null)} />
          <IntelligenceField label="On hand" value={positill.stockOnHand} />
          <IntelligenceField label="Booked" value={positill.booked} />
          <IntelligenceField label="Available" value={positill.availableStock} />
          <IntelligenceField label="Positill PRICE_A" value={displayMoney(positill.price)} />
        </IntelligenceCard>

        <IntelligenceCard title="Website" icon={Globe}>
          <IntelligenceField label="Website record" value={product.status?.website === 'available' ? 'Available' : null} />
          <IntelligenceField label="Website product" value={website.title} />
          <IntelligenceField label="Website price (incl. VAT)" value={displayMoney(website.price)} />
          <IntelligenceField label="Website stock" value={website.stockOnHand} />
          <IntelligenceField label="Online available" value={website.availableStock} />
          <IntelligenceField label="Image" value={website.imageUrl ? 'Available' : null} />
        </IntelligenceCard>

        <IntelligenceCard title="Buying intelligence" icon={TrendingUp}>
          <IntelligenceField label="Sales · 3 months" value={buying.sales3Months} />
          <IntelligenceField label="Sales · 6 months" value={buying.sales6Months} />
          <IntelligenceField label="Sales · 12 months" value={buying.sales12Months} />
          <IntelligenceField label="Effective stock" value={buying.effectiveStock} />
          <IntelligenceField label="Recommended quantity" value={buying.recommendedQuantity} />
          <IntelligenceField label="Confidence" value={buying.confidence} />
        </IntelligenceCard>
      </div>

      <div className={`intelligence-recommendation${risks.length || degraded ? ' intelligence-recommendation--warning' : ''}`}>
        {risks.length || degraded ? <AlertTriangle size={19} /> : <CheckCircle2 size={19} />}
        <div>
          <strong>{degraded ? 'Some live Positill information is unavailable' : (buying.recommendation || 'No Atlas recommendation available yet')}</strong>
          {risks.length > 0 && <span>{risks.join(' · ')}</span>}
          {!risks.length && degraded && <span>Website or approved cache information may still be shown. Treat this result as incomplete.</span>}
          {!risks.length && !degraded && <span>The current foundation is factual and read-only; Atlas recommendations will be connected later.</span>}
        </div>
      </div>
    </div>
  );
}

export default function ProductIntelligencePanel() {
  const [code, setCode] = useState('');
  const [searchedCode, setSearchedCode] = useState('');
  const [product, setProduct] = useState(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const submit = async (event) => {
    event.preventDefault();
    const normalizedCode = normalizePositillCode(code);
    if (!normalizedCode) {
      setError('Enter a Positill CODE.');
      setProduct(undefined);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setCode(normalizedCode);
    setSearchedCode(normalizedCode);
    setLoading(true);
    setError('');
    setProduct(undefined);

    try {
      const result = await fetchProductIntelligence(normalizedCode, { signal: controller.signal });
      setProduct(result);
    } catch (lookupError) {
      if (lookupError.name !== 'AbortError') {
        setError(lookupError.message || 'Product Intelligence lookup failed.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <section className="adm-panel intelligence-panel" aria-labelledby="product-intelligence-title">
      <div className="adm-section-head intelligence-panel__head">
        <div>
          <div className="intelligence-eyebrow"><PackageSearch size={15} /> Hermes</div>
          <h2 id="product-intelligence-title" className="adm-section-title">Product Intelligence</h2>
          <p className="adm-section-note">One read-only view of the available Positill and website information, joined by the canonical Positill CODE.</p>
        </div>
        <span className="intelligence-readonly"><ShieldCheck size={15} /> No writes or approvals</span>
      </div>

      <form className="intelligence-search" onSubmit={submit}>
        <label htmlFor="product-intelligence-code">Positill CODE</label>
        <div className="intelligence-search__controls">
          <input
            id="product-intelligence-code"
            className="adm-field-input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="e.g. 8610100040N"
            autoComplete="off"
            spellCheck="false"
            disabled={loading}
          />
          <button type="submit" className="adm-btn-dark" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
            {loading ? 'Looking up…' : 'Look up product'}
          </button>
        </div>
        <p>Exact codes give the safest match. This screen cannot change Positill or the website.</p>
      </form>

      {error && (
        <div className="intelligence-error" role="alert">
          <AlertTriangle size={20} />
          <div><strong>Product lookup unavailable</strong><span>{error}</span></div>
        </div>
      )}

      {loading && (
        <div className="intelligence-empty" role="status" aria-live="polite">
          <Loader2 size={32} className="spin" />
          <strong>Loading {searchedCode}</strong>
          <span>Joining the approved product information sources…</span>
        </div>
      )}

      {!loading && !error && product === undefined && <EmptyState />}
      {!loading && !error && product === null && <EmptyState searchedCode={searchedCode} />}
      {!loading && !error && product && <ProductResult product={product} searchedCode={searchedCode} />}
    </section>
  );
}
