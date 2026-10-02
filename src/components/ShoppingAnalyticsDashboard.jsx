import React, { useEffect, useMemo, useRef, useState } from 'react';
import { loadShoppingAnalytics, numberLabel, rateLabel, comparisonLabel } from '../lib/shoppingAnalyticsClient';
import './ShoppingAnalyticsDashboard.css';

const SOURCE_NAMES = { main: 'Main catalogue', instore: 'Instore', all: 'All sources' };
const list = (value) => Array.isArray(value) ? value : [];
const labelDate = (value) => value ? new Date(value).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not recorded';
const eventLabel = value => String(value || 'Recorded activity').replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
const isCustomerId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
const periodLabel = window => Number.isFinite(Date.parse(window?.since)) && Number.isFinite(Date.parse(window?.until)) ? `${new Date(window.since).toLocaleDateString('en-ZA',{day:'numeric',month:'short',timeZone:'UTC'})} → ${new Date(window.until).toLocaleDateString('en-ZA',{day:'numeric',month:'short',timeZone:'UTC'})} UTC` : 'Dates not supplied';
export function evidenceLabel(evidence) {
  if (typeof evidence === 'string') return evidence;
  if (!evidence || typeof evidence !== 'object') return '';
  const labels = { searches: 'searches', noResults: 'with no results', customers: 'customers', views: 'product views', productViews:'product views', departmentViews:'department opens', events:'recorded activities', clicks:'result clicks', basketAdds: 'basket additions' };
  return Object.entries(evidence).map(([key,value]) => Array.isArray(value) ? `${eventLabel(key)}: ${value.map(eventLabel).join(', ')}` : `${numberLabel(value)} ${labels[key] || eventLabel(key).toLowerCase()}`).join(' · ');
}

function Empty({ children = 'Nothing recorded in this period.' }) { return <p className="sa2-empty">{children}</p>; }
function Panel({ title, note, children, className = '', headingRef }) { return <section className={`sa2-panel ${className}`}><h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h2>{note && <p className="sa2-note">{note}</p>}{children}</section>; }
function revealHeading(heading){heading?.focus({preventScroll:true});heading?.scrollIntoView?.({block:'start',behavior:'auto'});}

export function PeriodComparison({ comparison }) {
  if(!comparison)return <p className="sa2-note">An equal previous-period comparison is not supplied for this response.</p>;
  return <p className="sa2-period-context">Current: {periodLabel(comparison.current)} · Previous equal period: {periodLabel(comparison.previous)}. End dates are exclusive. Changes describe recorded activity, not improvement or causation.</p>;
}

function SupportingEvidence({ selection, evidence, loading, error, onRetry, onClose, onCustomer }) {
  const headingRef=useRef(null);
  useEffect(()=>revealHeading(headingRef.current),[selection]);
  const unavailable=evidence?.coverage?.available===false || evidence?.coverage?.events?.available===false;
  return <Panel headingRef={headingRef} className="sa2-evidence-frame" title={`Supporting activity: ${selection.label || selection.value}`} note="These are bounded recorded activities within the selected period and catalogue filter; they do not explain a customer's motive.">
    <button onClick={onClose}>Close supporting activity</button>
    {loading && <p role="status">Loading supporting records…</p>}
    {error && <div className="sa2-error" role="alert"><p>{error}</p><button onClick={onRetry}>Retry supporting activity</button></div>}
    {evidence && <>{evidence.counts ? <p>{evidenceLabel(evidence.counts)}</p> : <p className="sa2-note">Matching totals are unavailable; missing or incomplete coverage is not a recorded zero.</p>}{unavailable && <p role="status" className="sa2-note">Supporting tracking is unavailable for this selection.</p>}
      {evidence.limited && <p className="sa2-note">Supporting records were limited. Customer links and displayed activities cover the returned subset.</p>}
      {list(evidence.coverage?.notes).map((note,index)=><p className="sa2-note" key={index}>{note}</p>)}
      {list(evidence.customers).length > 0 && <div><h3>Customers in these records</h3><ul className="sa2-evidence-customers">{evidence.customers.map(customer=><li key={customer.id}>{isCustomerId(customer.id)?<button onClick={()=>onCustomer(customer)}>View activity for {customer.name || customer.businessName || 'customer'}</button>:<span>{customer.name || 'Customer identity unavailable'}</span>}</li>)}</ul></div>}
      {!list(evidence.records).length ? <Empty>{unavailable?'No supporting records could be retrieved.':'No matching activity was recorded in the returned period.'}</Empty>:<div className="sa2-table-scroll"><table><thead><tr><th>Recorded at</th><th>Activity</th><th>Product or term</th><th>Catalogue</th></tr></thead><tbody>{evidence.records.map((record,index)=><tr key={`${record.at}-${index}`}><td>{labelDate(record.at)}</td><td>{eventLabel(record.type)}</td><td>{record.label || record.sku || 'Not recorded'}</td><td>{SOURCE_NAMES[record.catalogueSource] || 'Catalogue source not recorded'}</td></tr>)}</tbody></table></div>}
    </>}
  </Panel>;
}

export function RankedBars({ rows, valueKey, labelKey = 'name', unit = 'events', onSelect }) {
  if (!rows.length) return <Empty />;
  const peak = Math.max(1, ...rows.map(row => Number(row[valueKey]) || 0));
  return <ol className="sa2-ranking">{rows.slice(0, 8).map((row, index) => <li key={`${row.id || row[labelKey]}-${index}`}>
    <div className="sa2-rank-label">{onSelect ? <button className="sa2-rank-button" onClick={event => onSelect(row,event)}>{row[labelKey] || row.label || row.sku || 'Unlabelled'}</button> : <span>{row[labelKey] || row.label || row.sku || 'Unlabelled'}</span>}<strong>{numberLabel(row[valueKey])} <span className="sa2-unit">{unit}</span></strong></div>
    <svg viewBox="0 0 400 8" preserveAspectRatio="none" aria-hidden="true"><rect width="400" height="8" fill="var(--sa2-track)"/><rect width={Math.max(0, Number(row[valueKey]) || 0) / peak * 400} height="8" fill="var(--sa2-gold)"/></svg>
    {row.source && <span className="sa2-note">{SOURCE_NAMES[row.source] || row.source}</span>}
  </li>)}</ol>;
}

export function ActivityTrend({ rows }) {
  if (!rows.length) return <Empty />;
  const peak = Math.max(1, ...rows.flatMap(row => [Number(row.visits) || 0, Number(row.searches) || 0]));
  const start = Date.parse(rows[0].date); const end = Date.parse(rows.at(-1).date);
  const calendarDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const width = Math.max(500, calendarDays * 20);
  return <><div className="sa2-legend"><span><i className="sa2-visit-key"/>Recorded visits</span><span><i className="sa2-search-key"/>Searches</span></div><div className="sa2-chart-scroll">
    <svg viewBox={`0 0 ${width} 205`} role="img" aria-label="Daily recorded visits and searches. Exact counts are available in the table below." className="sa2-trend">
      {[0, .5, 1].map(level => <g key={level}><line x1="38" y1={165 - level * 150} x2={width - 10} y2={165 - level * 150} stroke="var(--sa2-track)"/><text x="32" y={169 - level * 150} textAnchor="end">{Math.round(peak * level)}</text></g>)}
      {rows.map((row, i) => { const dayOffset = Math.round((Date.parse(row.date) - start) / 86400000); const x = 42 + dayOffset * (width - 60) / calendarDays; const unit = (width - 60) / calendarDays; return <g key={row.date}>
        <title>{row.date}: {numberLabel(row.visits)} visits, {numberLabel(row.searches)} searches</title>
        {row.visits!=null && Number.isFinite(Number(row.visits)) && <rect x={x} y={165 - row.visits / peak * 150} width={Math.max(2, unit * .32)} height={row.visits / peak * 150} fill="var(--sa2-visit)"/>}
        {row.searches!=null && Number.isFinite(Number(row.searches)) && <rect x={x + unit * .36} y={165 - row.searches / peak * 150} width={Math.max(2, unit * .32)} height={row.searches / peak * 150} fill="var(--sa2-gold)"/>}
        {(i === 0 || i === rows.length - 1 || i % Math.max(1, Math.ceil(rows.length / 6)) === 0) && <text x={x} y="190">{new Date(`${row.date}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</text>}
      </g>; })}
    </svg></div><details className="sa2-details"><summary>View exact daily counts</summary><div className="sa2-table-scroll"><table><thead><tr><th>Date</th><th>Visits</th><th>Searches</th><th>Product views</th><th>Basket additions</th><th>Orders</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><td>{row.date}</td>{['visits', 'searches', 'productViews', 'basketAdds', 'orders'].map(key => <td key={key}>{numberLabel(row[key])}</td>)}</tr>)}</tbody></table></div></details></>;
}

function CustomerDetail({ customer }) {
  const headingRef=useRef(null);
  useEffect(()=>revealHeading(headingRef.current),[customer.id]);
  const interests = customer.interests || {};
  const [activityLimit, setActivityLimit] = useState(50);
  useEffect(() => setActivityLimit(50), [customer.id]);
  const timeline = list(customer.timeline);
  const recent=key=>{
    if(key!=='order')return timeline.filter(event=>key==='search'?['search_results_viewed','search'].includes(event.type):['product_viewed','product_view'].includes(event.type)).slice(0,3);
    const actual=timeline.filter(event=>event.type==='actual_order' || event.source==='actual-order');
    const seen=new Set();
    return (actual.length?actual:timeline.filter(event=>['order_submitted','order_submit_succeeded'].includes(event.type))).filter(event=>{if(!event.orderId)return true;if(seen.has(event.orderId))return false;seen.add(event.orderId);return true;}).slice(0,3);
  };
  return <div className="sa2-customer-detail" aria-label={`Activity for ${customer.name || 'customer'}`}>
    <h3 ref={headingRef} tabIndex={-1}>Activity for {customer.name || customer.businessName || 'customer'}</h3>
    {customer.dataCoverage?.available === false && <p className="sa2-note" role="status">Recorded shopping activity is unavailable for this scope. Earlier tracking records are shown separately when available.</p>}
    {customer.dataCoverage?.truncated && <p className="sa2-note" role="status">This customer’s activity read was limited; displayed counts cover the returned subset.</p>}
    <div className="sa2-recent-grid">{[['Recent searches','search'],['Recently viewed products','view'],['Recent order records','order']].map(([label,key])=><section key={key}><h3>{label}</h3>{recent(key).length?<ul>{recent(key).map((event,index)=><li key={index}><strong>{event.label || event.sku || eventLabel(event.type)}</strong><small>{labelDate(event.at)} · {event.source==='shopping'?'Shopping tracking':event.source==='actual-order'?'Actual order record':'Earlier tracking'}</small></li>)}</ul>:<p className="sa2-note">{customer.dataCoverage?.available===false?'Recorded activity unavailable.':'None in the returned activity.'}</p>}</section>)}</div>
    <p className="sa2-note">Recent summaries describe the returned timeline, not a complete lifetime history. Order records and tracking events may refer to the same order; they are not paid revenue.</p>
    <div className="sa2-comparison"><div><h3>Selected at registration</h3><dl>{[['Product categories', 'productCategories'], ['Sales channels', 'salesChannels'], ['Supply needs', 'supplyNeeds']].map(([name, key]) => <div key={key}><dt>{name}</dt><dd>{list(interests[key]).join(', ') || 'Not supplied'}</dd></div>)}</dl></div>
    <div><h3>Observed in this period</h3><p>{list(customer.observedCategories).map(item => typeof item === 'string' ? item : item.name || item.label).filter(Boolean).join(', ') || 'No departments recorded.'}</p><p className="sa2-note">Registration choices describe stated interests. Browsing activity describes recorded behaviour.</p>{list(customer.matchedInterests).length > 0 && <p><strong>Interest matches:</strong> {customer.matchedInterests.join(', ')}</p>}</div></div>
    {list(customer.recommendations).filter(item => item.verified === true).length > 0 && <div><h3>Verified product suggestions</h3><ul>{customer.recommendations.filter(item => item.verified === true).map(item => <li key={`${item.source}-${item.sku}`}><strong>{item.name}</strong> · {item.sku} · {SOURCE_NAMES[item.source] || item.source}<p className="sa2-note">{item.reason}</p></li>)}</ul></div>}
    <h3>Recorded activity</h3>{!timeline.length ? <Empty>No activity recorded for this customer in this period.</Empty> : <><ol className="sa2-timeline">{timeline.slice(0, activityLimit).map((event, i) => <li key={`${event.at || event.created_at}-${i}`}><time>{labelDate(event.at || event.created_at)}</time><span>{eventLabel(event.type || event.event_type)}{event.label && event.label !== event.type && <> · {event.label}</>}{event.sku && event.label !== event.sku && <> · {event.sku}</>}</span><small>{SOURCE_NAMES[event.catalogueSource] || ({ shopping: 'Shopping activity', 'legacy-search': 'Earlier search tracking', 'legacy-journey': 'Earlier journey tracking', 'legacy-event': 'Earlier view tracking', 'actual-order': 'Order record' }[event.source]) || SOURCE_NAMES[event.source] || event.source || ''}</small></li>)}</ol><p className="sa2-note">Showing {Math.min(activityLimit,timeline.length)} of {timeline.length} returned activities.{customer.timelineTruncated && ' The server returns at most the latest 200 activities; older recorded activity is omitted.'}</p>{activityLimit < timeline.length && <button onClick={() => setActivityLimit(value => value + 50)}>Show more activity</button>}</>}
  </div>;
}

export default function ShoppingAnalyticsDashboard({ getAccessToken, sampleData = null, sampleEvidence = null, loader = loadShoppingAnalytics }) {
  const evidenceOrigin=useRef(null);
  const [days, setDays] = useState(30); const [source, setSource] = useState('all'); const [includeInternal, setIncludeInternal] = useState(false);
  const [sample, setSample] = useState(false); const [refresh, setRefresh] = useState(0); const [data, setData] = useState(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [selected, setSelected] = useState(null); const [selectedProduct, setSelectedProduct] = useState(null); const [customerQuery, setCustomerQuery] = useState('');
  const [customerDetail, setCustomerDetail] = useState(null); const [detailLoading, setDetailLoading] = useState(false); const [detailError, setDetailError] = useState(''); const [detailRetry, setDetailRetry] = useState(0);
  const [lookupCustomers, setLookupCustomers] = useState(null); const [lookupLoading, setLookupLoading] = useState(false); const [lookupError, setLookupError] = useState(''); const [lookupLimited, setLookupLimited] = useState(false);
  const [evidenceSelection,setEvidenceSelection]=useState(null);const [supportingEvidence,setSupportingEvidence]=useState(null);const [evidenceLoading,setEvidenceLoading]=useState(false);const [evidenceError,setEvidenceError]=useState('');const [evidenceRetry,setEvidenceRetry]=useState(0);const [evidenceProfiles,setEvidenceProfiles]=useState([]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(''); setData(null); setSelected(null); setSelectedProduct(null);setEvidenceSelection(null);setEvidenceProfiles([]);
    const request = sample && sampleData ? Promise.resolve(typeof sampleData === 'function' ? sampleData({ days, source, includeInternal }) : sampleData) : loader({ days, source, includeInternal }, { signal: controller.signal, getAccessToken });
    request.then(result => { if (active) setData(result); }).catch(problem => { if (active && problem.name !== 'AbortError') setError(problem.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [days, source, includeInternal, refresh, sample, sampleData, loader, getAccessToken]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLookupCustomers(null); setLookupError(''); setLookupLoading(false); setLookupLimited(false);
    const term = customerQuery.trim();
    if (sample || !data?.quality?.responseLimits?.customers?.truncated || term.length < 3) return () => controller.abort();
    setLookupLoading(true);
    const timer = setTimeout(() => {
      loader({ days, source, includeInternal, customerSearch: term }, { signal: controller.signal, getAccessToken })
        .then(result => { if (active) { setLookupCustomers(list(result.customerMatches)); setLookupLimited(result.lookup?.limited === true); } })
        .catch(problem => { if (active && problem.name !== 'AbortError') setLookupError(problem.message); })
        .finally(() => { if (active) setLookupLoading(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [customerQuery, data, sample, days, source, includeInternal, loader, getAccessToken]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setCustomerDetail(null); setDetailError(''); setDetailLoading(false);
    const profile = [...list(data?.customers), ...list(lookupCustomers),...evidenceProfiles].find(customer => customer.id === selected);
    if (!profile || Array.isArray(profile.timeline)) return () => controller.abort();
    if (sample) { setDetailError('No additional sample activity is provided.'); return () => controller.abort(); }
    setDetailLoading(true);
    loader({ days, source, includeInternal, customerId: selected }, { signal: controller.signal, getAccessToken })
      .then(result => { if (active) { if (result.customer?.id !== selected) throw new Error('Customer details could not be matched. Try again.'); setCustomerDetail(result.customer); } })
      .catch(problem => { if (active && problem.name !== 'AbortError') setDetailError(problem.message); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [selected, data, lookupCustomers,evidenceProfiles, days, source, includeInternal, sample, loader, getAccessToken, detailRetry]);
  useEffect(()=>{
    const controller=new AbortController();let active=true;setSupportingEvidence(null);setEvidenceError('');setEvidenceLoading(false);
    if(!evidenceSelection)return()=>controller.abort();
    if(sample && !sampleEvidence){setEvidenceError('No additional supporting sample records are supplied.');return()=>controller.abort();}
    setEvidenceLoading(true);
    const filters={days,source,includeInternal,evidenceType:evidenceSelection.type,evidenceValue:evidenceSelection.value,...(evidenceSelection.source?{evidenceSource:evidenceSelection.source}:{})};
    const request=sample?Promise.resolve().then(()=>sampleEvidence(filters)):loader(filters,{signal:controller.signal,getAccessToken});
    request
      .then(result=>{if(active){if(result.evidence?.type!==evidenceSelection.type || result.evidence?.value!==evidenceSelection.value)throw new Error('Supporting records could not be matched to this selection.');setSupportingEvidence(result.evidence);}})
      .catch(problem=>{if(active && problem.name!=='AbortError')setEvidenceError(problem.message);}).finally(()=>{if(active)setEvidenceLoading(false);});
    return()=>{active=false;controller.abort();};
  },[evidenceSelection,days,source,includeInternal,sample,sampleEvidence,loader,getAccessToken,evidenceRetry]);
  const chooseEvidence=(selection,event)=>{evidenceOrigin.current=event?.currentTarget || document.activeElement;setEvidenceSelection(selection);};
  const closeEvidence=()=>{setEvidenceSelection(null);setSelectedProduct(null);if(evidenceOrigin.current?.isConnected){evidenceOrigin.current.focus({preventScroll:true});evidenceOrigin.current.scrollIntoView?.({block:'nearest',behavior:'auto'});}};
  const inspect=(type,row,event)=>chooseEvidence({type,value:type==='term'?row.term:type==='product'?row.sku:row.name,label:type==='term'?row.term:row.name || row.sku,source:row.source || (type==='product'?'unknown':null)},event);
  const inspectCustomer=customer=>{if(!isCustomerId(customer.id))return;setEvidenceProfiles(previous=>[...previous.filter(p=>p.id!==customer.id),{id:customer.id,name:customer.name,businessName:customer.businessName,counts:null,detailsAvailable:true}]);setSelected(customer.id);};
  const customers = useMemo(() => (lookupCustomers === null ? list(data?.customers).filter(customer => `${customer.name || ''} ${customer.businessName || ''}`.toLowerCase().includes(customerQuery.toLowerCase())) : lookupCustomers), [data, lookupCustomers, customerQuery]);
  const summary = data?.summary || {}; const quality = data?.quality || {}; const selectedProfile = [...list(data?.customers), ...list(lookupCustomers),...evidenceProfiles].find(customer => customer.id === selected);
  const selectedCustomer = Array.isArray(selectedProfile?.timeline) ? selectedProfile : customerDetail?.id === selected ? customerDetail : null;
  const gaps = [...(list(quality.gaps).length ? quality.gaps : list(quality.missingSources).map(name => `${name}: data unavailable for this release.`)), ...Object.entries(quality.sources || {}).filter(([,status]) => status.truncated).map(([name]) => `${name}: the read limit was reached. Counts are incomplete; conversion rates are unavailable.`)];
  const shoppingAvailable = quality.sources?.events?.available !== false;
  const funnel = list(data?.funnel?.stages || data?.funnel); const terms = list(data?.terms); const popup = data?.popup || {};
  return <div className="sa2-dashboard">
    <header className="sa2-heading"><div><h1>Search and shopping</h1><p>How customers find products and progress towards an order.</p></div><button onClick={() => setRefresh(value => value + 1)} disabled={loading}>Refresh</button></header>
    <div className="sa2-controls"><label>Period<select value={days} onChange={event => setDays(Number(event.target.value))}>{[7,30,90].map(value => <option key={value} value={value}>Last {value} days</option>)}</select></label><label>Catalogue<select value={source} onChange={event => setSource(event.target.value)}>{Object.entries(SOURCE_NAMES).map(([key,name]) => <option key={key} value={key}>{name}</option>)}</select></label><label className="sa2-check"><input type="checkbox" checked={includeInternal} onChange={event => setIncludeInternal(event.target.checked)}/>Include internal and test activity</label>{sampleData && <label className="sa2-check"><input type="checkbox" checked={sample} onChange={event => setSample(event.target.checked)}/>Show sample data</label>}</div>
    {sample && <p className="sa2-sample" role="status">Sample data — illustrative customers and activity, not live records.</p>}
    {loading && <p className="sa2-empty" role="status">Loading recorded shopping activity…</p>}
    {error && <div className="sa2-error" role="alert"><strong>Analytics could not be loaded</strong><p>{error}</p><button onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
    {data && <>
      {Object.values(quality.responseLimits || {}).some(limit => limit.truncated) && <p className="sa2-note">Ranked lists are bounded for fast loading; aggregate totals above include all retrieved activity. Customer details load when selected.</p>}
      <div className="sa2-freshness"><span>Last {days} days · {SOURCE_NAMES[source]} · Latest activity: {labelDate(quality.latestEventAt || quality.lastEventAt)}</span><span>{includeInternal ? 'Internal activity included' : 'Internal and test activity excluded'}{quality.exclusions !== undefined && typeof quality.exclusions === 'number' ? ` · ${numberLabel(quality.exclusions)} excluded events` : ''}</span></div>
      {gaps.length > 0 && <div className="sa2-quality" role="status"><strong>Coverage notes</strong><ul>{gaps.map((gap,i) => <li key={i}>{typeof gap === 'string' ? gap : gap.message || gap.label}</li>)}</ul></div>}
      <PeriodComparison comparison={data.comparison}/>
      <dl className="sa2-summary">{[['Recorded visits','recordedVisits'],['Visits using search','searchVisits'],['Search adoption','searchUsageRate'],['Product views','productViews'],['Basket additions','basketAdds'],['Verified orders','verifiedOrders']].map(([label,key]) => <div key={key}><dt>{label}</dt><dd>{key === 'searchUsageRate' ? rateLabel(summary[key]) : numberLabel(summary[key])}</dd><p className="sa2-delta">{comparisonLabel(data.comparison?.metrics?.[key],{rate:key==='searchUsageRate'})}</p>{data.comparison?.metrics?.[key] && <small className="sa2-note">Previous: {key==='searchUsageRate'?rateLabel(data.comparison.metrics[key].previous):numberLabel(data.comparison.metrics[key].previous)}</small>}</div>)}</dl>
      <p className="sa2-note">Search adoption = recorded visits with a search ÷ recorded visits. These are measured visits, not all website traffic.</p>
      <Panel title="Daily visits and searches" note="Current-period daily counts in UTC. Calendar gaps remain visible. Visits and searches have different units; one visit may contain several searches."><ActivityTrend rows={list(data.trend)}/>{data.comparison && <p className="sa2-note">Previous-period recorded visits: {numberLabel(data.comparison.metrics?.recordedVisits?.previous)} · Searches: {numberLabel(data.comparison.metrics?.searches?.previous)}. The chart shows the current period; this context is an equal adjacent period.</p>}</Panel>
      <div className="sa2-two"><Panel title="Shopping journey" note="Customers must reach each step in sequence within the same recorded visit. These associations do not prove that search caused an order.">{!funnel.length ? <Empty>The linked shopping journey is not available yet.</Empty> : <ol className="sa2-funnel">{funnel.map((stage,index) => <li key={stage.key}><span>{stage.label}</span><strong>{numberLabel(stage.count)}</strong><span className="sa2-note">{index === 0 ? 'Starting visits' : `${rateLabel(stage.rate)} of starting visits`}</span><svg viewBox="0 0 400 10" preserveAspectRatio="none" aria-hidden="true"><rect width="400" height="10" fill="var(--sa2-track)"/><rect width={funnel[0].count ? stage.count / funnel[0].count * 400 : 0} height="10" fill="var(--sa2-gold)"/></svg></li>)}</ol>}</Panel>
      <Panel title="Search tip engagement" note="A search after seeing the tip is an association within the same visit.">{shoppingAvailable ? <dl className="sa2-popup">{[['Seen','shown'],['Dismissed','dismissed'],['Try search clicked','trySearch'],['Searched after tip','searchAfterTip']].map(([label,key]) => <div key={key}><dt>{label}</dt><dd>{numberLabel(popup[key])}</dd></div>)}</dl> : <Empty>Search tip tracking is not available yet.</Empty>}</Panel></div>
      <div className="sa2-two"><Panel title="What customers search for" note="Choose a term to inspect supporting records and customers."><RankedBars rows={terms} labelKey="term" valueKey="searches" unit="searches" onSelect={(row,event)=>inspect('term',row,event)}/>{terms.length > 0 && <details className="sa2-details"><summary>View search outcomes</summary><div className="sa2-table-scroll"><table><thead><tr><th>Search term</th><th>Searches</th><th>No results</th><th>Unknown result count</th><th>Clicks</th><th>Customers</th></tr></thead><tbody>{terms.map(term => <tr key={term.term}><td>{term.term}</td>{['searches','noResults','unknownResults','clicks','customers'].map(key => <td key={key}>{numberLabel(term[key])}</td>)}</tr>)}</tbody></table></div></details>}</Panel><Panel title="Products customers view" note="Choose a product to inspect its recorded activity."><RankedBars rows={list(data.products)} valueKey="views" unit="views" onSelect={(row,event)=>{setSelectedProduct(row);inspect('product',row,event);}}/>{selectedProduct && <div className="sa2-product-detail"><h3>{selectedProduct.name || selectedProduct.sku}</h3><p className="sa2-note">{selectedProduct.sku} · {SOURCE_NAMES[selectedProduct.source] || 'Catalogue source not recorded'}</p><p>{evidenceLabel({ views: selectedProduct.views, basketAdds: selectedProduct.basketAdds, customers: selectedProduct.customers })}</p><p className="sa2-note">Activity counts describe this period. They do not establish why a customer chose or declined a product.</p><button onClick={closeEvidence}>Close product details</button></div>}</Panel></div>
      {list(data.comparison?.searchChanges).length > 0 && <Panel title="Search frequency across periods" note="Recorded search frequency changes are investigation leads; they do not establish demand or sales."><div className="sa2-table-scroll"><table><thead><tr><th>Term</th><th>Current searches</th><th>Previous searches</th><th>Recorded change</th><th>Evidence</th></tr></thead><tbody>{data.comparison.searchChanges.map(row=><tr key={row.term}><td>{row.term}</td><td>{numberLabel(row.currentSearches)}</td><td>{numberLabel(row.previousSearches)}</td><td>{comparisonLabel({...row,current:row.currentSearches,previous:row.previousSearches})}</td><td><button onClick={event=>inspect('term',row,event)}>Inspect {row.term}</button></td></tr>)}</tbody></table></div></Panel>}
      <div className="sa2-two"><Panel title="Departments customers browse" note="Recorded department opens. Select a department for its product-view and basket evidence."><RankedBars rows={list(data.departments)} valueKey="views" unit="opens" onSelect={(row,event)=>inspect('department',row,event)}/></Panel><Panel title="Opportunities to investigate">{!list(data.actions).length ? <Empty>No supported opportunities identified in this period.</Empty> : <ul className="sa2-actions">{data.actions.map((action,i) => <li key={action.id || i}><h3>{action.title}</h3><p>{action.detail || action.description}</p>{action.evidence && <p className="sa2-note">{evidenceLabel(action.evidence)}</p>}{['term','product','department'].includes(action.drilldown?.type) && action.drilldown.value && <button aria-label={`Inspect evidence: ${action.title}`} onClick={event=>chooseEvidence({...action.drilldown,label:action.title},event)}>Inspect supporting activity</button>}</li>)}</ul>}</Panel></div>
      {evidenceSelection && <SupportingEvidence selection={evidenceSelection} evidence={supportingEvidence} loading={evidenceLoading} error={evidenceError} onRetry={()=>setEvidenceRetry(value=>value+1)} onClose={closeEvidence} onCustomer={inspectCustomer}/>}
      <Panel title="Customer interests and activity" note={`Registration profiles alongside recorded ${SOURCE_NAMES[source].toLowerCase()} activity in the last ${days} days.`}>
        <label className="sa2-customer-search">Find a customer<input type="search" value={customerQuery} onChange={event => { setCustomerQuery(event.target.value); setSelected(null); }} placeholder="Customer or business name" maxLength={80}/></label>
        {quality.responseLimits?.customers?.truncated && <p className="sa2-note">Showing up to {quality.responseLimits.customers.returned} of {quality.responseLimits.customers.total} retrieved profiles. Type at least 3 characters to search all registered customers.</p>}
        {lookupLoading && <p role="status" className="sa2-note">Finding registered customers…</p>}
        {lookupError && <p role="alert" className="sa2-error">Customer lookup failed: {lookupError}. Change the search to try again.</p>}
        {lookupLimited && <p className="sa2-note">Up to 100 matches returned. Narrow the name to find a specific customer; the total match count is unknown.</p>}
        {!customers.length ? <Empty>{lookupLoading ? 'Waiting for matching customer profiles.' : 'No matching customer profiles are available for this scope.'}</Empty> : <div className="sa2-table-scroll"><table><thead><tr><th>Customer</th><th>Registration interests</th><th>Searches</th><th>Product views</th><th>Basket additions</th><th>Orders</th><th>Details</th></tr></thead><tbody>{customers.map(customer => <tr key={customer.id}><td><strong>{customer.name || 'Customer'}</strong>{customer.businessName && <small>{customer.businessName}</small>}</td><td>{list(customer.interests?.productCategories).join(', ') || 'Not supplied'}</td>{['searches','productViews','basketAdds','orders'].map(key => <td key={key}>{numberLabel(shoppingAvailable ? (customerDetail?.id === customer.id ? customerDetail.counts?.[key] : customer.counts?.[key]) : null)}</td>)}<td><button aria-expanded={selected === customer.id} onClick={() => setSelected(selected === customer.id ? null : customer.id)}>{selected === customer.id ? 'Close' : 'View activity'}</button></td></tr>)}</tbody></table></div>}
        {selected && detailLoading && <p className="sa2-note" role="status">Loading this customer’s recorded activity…</p>}
        {selected && detailError && <div role="alert" className="sa2-error"><p>{detailError}</p><button onClick={() => setDetailRetry(value => value + 1)}>Retry customer activity</button></div>}
        {selectedCustomer && <CustomerDetail customer={selectedCustomer}/>}</Panel>
      <details className="sa2-definitions"><summary>Metric definitions and data coverage</summary>{Object.entries(data.definitions || {}).map(([key,value]) => <p key={key}><strong>{key}:</strong> {typeof value === 'string' ? value : JSON.stringify(value)}</p>)}<p>Source: authenticated shopping analytics. Historical records are not retroactively created.</p>{list(quality.notes).map((note,i) => <p key={i}>{note}</p>)}{quality.sources && <pre>{JSON.stringify(quality.sources,null,2)}</pre>}</details>
    </>}
  </div>;
}
