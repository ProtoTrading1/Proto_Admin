import { matchedRegistrationInterests } from './interest-mapping.mjs';
/** Pure, conservative aggregation of recorded activity. No inferred cross-system sessions. */
const TYPES = { search: 'search_results_viewed', view: 'product_viewed', cart: 'basket_item_added' };
const SOURCES = ['events', 'visits', 'searches', 'journeys', 'legacyEvents', 'orders', 'customers', 'products'];
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const norm = value => text(value).toLowerCase().replace(/\s+/g, ' ');
const rate = (n, d) => d > 0 ? n / d : null;
const instant = row => Date.parse(row.created_at || row.started_at || row.at || '');
const sessionKey = row => row.customer_id && row.session_id ? `${row.customer_id}:${row.session_id}` : null;
const unique = values => [...new Set(values.filter(Boolean))];
const category = p => text(p?.category) || (Array.isArray(p?.category_path) ? p.category_path.filter(Boolean).join(' / ') : text(p?.category_path));
const values = value => Array.isArray(value) ? value.map(String).filter(Boolean) : text(value) ? [text(value)] : [];
const dedup = rows => { const seen = new Set(); return rows.filter(row => { const id = row.event_id || row.id; if (!id) return true; if (seen.has(id)) return false; seen.add(id); return true; }); };
// Funnel credit requires the actual order to belong to this checkout, not a
// previously submitted customer-owned order. Allow only the existing 60s
// upper delivery skew; never move an order created before checkout forwards.
function orderFollowsCheckout(order, submittedEvent, checkout) {
  const checkoutAt = instant(checkout); const submittedAt = instant(submittedEvent); const orderAt = instant(order);
  return orderAt >= checkoutAt && submittedAt >= checkoutAt && orderAt <= submittedAt + 60000;
}

export function buildShoppingAnalytics(input = {}, options = {}) {
  const since = options.since ? Date.parse(options.since) : -Infinity;
  const until = options.until ? Date.parse(options.until) : Infinity;
  if (Number.isNaN(since) || Number.isNaN(until) || since > until) throw new RangeError('Invalid analytics date window');
  if (options.source && !['all', 'main', 'instore'].includes(options.source)) throw new RangeError('Invalid analytics source');
  const source = options.source && options.source !== 'all' ? options.source : null;
  const allCustomers = list(input.customers);
  const customerMap = new Map(allCustomers.map(c => [c.id, c]));
  const excluded = new Set(list(options.excludedCustomerIds));
  const excludedEmails = new Set(list(options.excludedCustomerEmails).map(norm));
  if (!options.includeInternal) for (const c of allCustomers) if (['admin', 'staff', 'super_admin', 'superadmin', 'owner', 'employee'].includes(norm(c.role)) || c.is_internal === true || excludedEmails.has(norm(c.email))) excluded.add(c.id);
  const baseFilter = row => {
    const time = instant(row);
    return Number.isFinite(time) && time >= since && time < until &&
      (options.includeInternal || (!excluded.has(row.customer_id) && row.is_internal !== true && (!row.environment || row.environment === 'production')));
  };
  const nondimensional = new Set(['checkout_started','order_submitted','search_tip_shown','search_tip_dismissed','search_tip_search_clicked','personalised_tip_shown','personalised_tip_dismissed','personalised_tip_clicked']);
  const eventFilter = row => baseFilter(row) && (!source || row.source === source || (!row.source && nondimensional.has(row.event_type)));
  let events = dedup(list(input.events)).filter(eventFilter).sort((a, b) => instant(a) - instant(b));
  if(source){const scopedSessions=new Set(events.filter(e=>e.source===source).map(sessionKey).filter(Boolean));events=events.filter(e=>e.source===source || scopedSessions.has(sessionKey(e)));}
  const visits = dedup(list(input.visits)).filter(baseFilter);
  // Legacy data has no dependable source dimension: exclude it from a source-specific window.
  const legacy = Object.fromEntries(['searches', 'journeys', 'legacyEvents'].map(key => [key, dedup(list(input[key])).filter(row => baseFilter(row) && (!source || row.source === source))]));
  const orders = dedup(list(input.orders)).filter(baseFilter);
  const orderMap = new Map(orders.map(o => [o.id, o]));
  const productMap = new Map();
  for (const p of list(input.products)) for (const key of unique([p.code, p.sku, p.id, p.product_id])) productMap.set(String(key), p);
  const sources = Object.fromEntries(SOURCES.map(key => {
    const provided = input.sourceStatuses?.[key] || input.statuses?.[key];
    const available = (!provided?.error || provided.error === 'row_limit') && (provided?.available ?? Array.isArray(input[key]));
    return [key, { available, error: provided?.error || null, truncated: provided?.truncated === true, count: list(input[key]).length }];
  }));
  // Older sources do not establish a common session or catalogue dimension.
  // Keep them visible without attributing them to the new tracking funnel.
  const historyMetric = (key, rows, label, catalogueUnknown = true) => {
    const status=sources[key];
    const metric={count:null,status:'unavailable',label,source:catalogueUnknown?'Catalogue not recorded':'All catalogues',reason:null};
    if(source && catalogueUnknown)return {...metric,status:'source_not_recorded',reason:'Older records do not identify Main catalogue or Instore; this catalogue breakdown is unavailable.'};
    if(!status.available)return {...metric,reason:'This historical source could not be read.'};
    if(!options.includeInternal && (!sources.customers.available || sources.customers.truncated))return {...metric,reason:'Customer profiles are missing or limited; internal activity cannot be fully excluded.'};
    return {...metric,count:rows.length,status:status.truncated?'partial':'available',reason:status.truncated?'A read limit was reached; this count covers only the retrieved subset.':null};
  };
  const historicalSummary={
    searches:historyMetric('searches',legacy.searches,'Existing search records'),
    journeys:historyMetric('journeys',legacy.journeys,'Existing journey records'),
    events:historyMetric('legacyEvents',legacy.legacyEvents,'Existing activity records'),
    presenceRecords:historyMetric('visits',visits,'Presence records'),
    actualOrders:historyMetric('orders',orders,'Saved order records',false),
  };
  // Only catalogue events supply browsing visit denominators. Presence rows cannot create historic coverage.
  const groups = new Map();
  for (const event of events) { const key = sessionKey(event); if (!key) continue; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event); }
  const browseGroups = [...groups.values()].filter(rows => rows.some(e => e.event_type === 'catalogue_viewed'));
  const searchVisits = browseGroups.filter(rows => { const first = rows.find(e => e.event_type === 'catalogue_viewed'); return rows.some(e => e.event_type === TYPES.search && instant(e) >= instant(first)); }).length;
  const verifiedOrderEvents = [];
  const seenOrders = new Set();
  let rejectedOrders = 0;
  for (const e of events.filter(e => e.event_type === 'order_submitted')) {
    const order = orderMap.get(e.order_id);
    if (!order || !e.customer_id || order.customer_id !== e.customer_id || /cancel|draft|failed/i.test(order.status || '') || instant(order) > instant(e) + 60000) { rejectedOrders++; continue; }
    if (!seenOrders.has(order.id)) { seenOrders.add(order.id); verifiedOrderEvents.push(e); }
  }
  const searches = events.filter(e => e.event_type === TYPES.search);
  const views = events.filter(e => e.event_type === TYPES.view);
  const carts = events.filter(e => e.event_type === TYPES.cart);
  const summary = { recordedVisits: sources.events.available ? browseGroups.length : null, searchVisits: sources.events.available ? searchVisits : null, searchUsageRate: sources.events.available ? rate(searchVisits, browseGroups.length) : null,
    searches: sources.events.available ? searches.length : null, productViews: sources.events.available ? views.length : null, basketAdds: sources.events.available ? carts.length : null,
    verifiedOrders: sources.events.available && sources.orders.available ? verifiedOrderEvents.length : null, activeCustomers: sources.events.available ? unique(events.map(e => e.customer_id)).length : null,
    actualOrders: sources.orders.available ? orders.filter(o => !/cancel|draft|failed/i.test(o.status || '')).length : null };
  const daily = new Map();
  const day = e => { const date = new Date(instant(e)).toISOString().slice(0, 10); if (!daily.has(date)) daily.set(date, {date, visits: 0, searches: 0, productViews: 0, basketAdds: 0, orders: 0}); return daily.get(date); };
  for (const rows of browseGroups) day(rows.find(e => e.event_type === 'catalogue_viewed')).visits++;
  for (const [rows, field] of [[searches, 'searches'], [views, 'productViews'], [carts, 'basketAdds'], [verifiedOrderEvents, 'orders']]) for (const e of rows) day(e)[field]++;
  const trend = [...daily.values()].sort((a,b) => a.date.localeCompare(b.date));
  const termMap = new Map();
  for (const e of searches) { const term = norm(e.search_term); if (!term) continue; if (!termMap.has(term)) termMap.set(term, {term, searches:0,noResults:0,unknownResults:0,clicks:0,customerIds:new Set()}); const t = termMap.get(term); t.searches++; if (e.results_count === 0) t.noResults++; else if (!Number.isInteger(e.results_count) || e.results_count < 0) t.unknownResults++; if(e.customer_id)t.customerIds.add(e.customer_id); }
  const searchMap = new Map(searches.filter(e => e.event_id || e.id || e.search_id).map(e => [`${sessionKey(e)}:${e.event_id || e.id || e.search_id}`,e]));
  for (const e of events.filter(e => e.event_type === 'search_result_clicked')) { const search = searchMap.get(`${sessionKey(e)}:${e.search_id}`); if (search && sessionKey(e) && instant(e) >= instant(search)) { const t = termMap.get(norm(search.search_term)); if(t)t.clicks++; } }
  const terms = [...termMap.values()].map(({customerIds,...t}) => ({...t, customers:customerIds.size, knownResults:t.searches-t.unknownResults, noResultRate:rate(t.noResults,t.searches-t.unknownResults)})).sort((a,b) => b.searches-a.searches || a.term.localeCompare(b.term));
  const productStats = new Map();
  for (const e of [...views, ...carts]) { if (!e.product_id) continue; const sku = String(e.product_id); const p = productMap.get(sku); const key = `${e.source || 'unknown'}:${sku}`; if (!productStats.has(key)) productStats.set(key,{id:key,sku,name:p?.name || p?.product_name || sku,category:category(p) || null,source:e.source || null,views:0,basketAdds:0,customerIds:new Set()}); const row = productStats.get(key); row[e.event_type === TYPES.view ? 'views':'basketAdds']++; if(e.customer_id)row.customerIds.add(e.customer_id); }
  const products = [...productStats.values()].map(({customerIds,...p})=>({...p,customers:customerIds.size})).sort((a,b)=>b.views-a.views || a.id.localeCompare(b.id));
  const deptMap = new Map();
  for (const e of events) { const dept = e.event_type === 'department_viewed' ? text(e.metadata?.department || e.metadata?.category) : category(productMap.get(String(e.product_id))); if(!dept)continue; if(!deptMap.has(dept))deptMap.set(dept,{name:dept,views:0,productViews:0,basketAdds:0,customerIds:new Set()}); const d=deptMap.get(dept); if(e.event_type==='department_viewed')d.views++; if(e.event_type===TYPES.view)d.productViews++; if(e.event_type===TYPES.cart)d.basketAdds++; if(e.customer_id)d.customerIds.add(e.customer_id); }
  const departments = [...deptMap.values()].map(({customerIds,...d})=>({...d,customers:customerIds.size})).sort((a,b)=>b.productViews-a.productViews);
  // Session funnel is ordered, with the same product at view/add. Never join legacy sessions.
  const counts = [browseGroups.length,0,0,0,0,0];
  for (const rows of browseGroups) {
    const browse=rows.find(e=>e.event_type==='catalogue_viewed');
    const search=rows.find(e=>e.event_type===TYPES.search && instant(e)>=instant(browse)); if(!search)continue; counts[1]++;
    const pairs=[]; for(const view of rows.filter(e=>e.event_type===TYPES.view && e.product_id && instant(e)>=instant(search))) { const add=rows.find(e=>e.event_type===TYPES.cart && e.product_id===view.product_id && e.source===view.source && instant(e)>=instant(view)); pairs.push({view,add}); }
    if(!pairs.length)continue; counts[2]++;
    const added=pairs.filter(p=>p.add); if(!added.length)continue; counts[3]++;
    const checkout=rows.find(e=>e.event_type==='checkout_started' && added.some(p=>instant(e)>=instant(p.add))); if(!checkout)continue; counts[4]++;
    if(rows.some(e=>verifiedOrderEvents.includes(e) && orderFollowsCheckout(orderMap.get(e.order_id),e,checkout)))counts[5]++;
  }
  const funnel = ['Recorded browsing visits','Searched','Viewed a product after search','Added that product','Started checkout','Verified submitted order'].map((label,i)=>({key:['visit','search','view','basket','checkout','order'][i],label,count:sources.events.available && (i!==5 || sources.orders.available) ? counts[i]:null,rate: sources.events.available && (i!==5 || sources.orders.available) ? rate(counts[i],counts[0]):null,stepRate:sources.events.available && (i!==5 || sources.orders.available) ? (i ? rate(counts[i],counts[i-1]):rate(counts[0],counts[0])):null}));
  const shown = events.filter(e=>e.event_type==='search_tip_shown');
  const popup = {shown:shown.length,dismissed:events.filter(e=>e.event_type==='search_tip_dismissed').length,trySearch:events.filter(e=>e.event_type==='search_tip_search_clicked').length,searchAfterTip:0,shownVisits:unique(shown.map(sessionKey)).length,searchAfterTipRate:null};
  for(const rows of groups.values()){const tip=rows.find(e=>e.event_type==='search_tip_shown');if(tip && rows.some(e=>e.event_type===TYPES.search && instant(e)>=instant(tip)))popup.searchAfterTip++;}
  popup.searchAfterTipRate=rate(popup.searchAfterTip,popup.shownVisits);
  if(!sources.events.available)for(const key of Object.keys(popup))popup[key]=null;
  const timelineSources = [['shopping',events],['legacy-search',legacy.searches],['legacy-journey',legacy.journeys],['legacy-event',legacy.legacyEvents],['actual-order',orders.map(o=>({...o,event_type:'actual_order',product_id:null}))]];
  const eventsByCustomer = new Map(); const activityByCustomer = new Map(); const visitsByCustomer = new Map(); const ordersByCustomer = new Map();
  for(const event of events){if(!eventsByCustomer.has(event.customer_id))eventsByCustomer.set(event.customer_id,[]);eventsByCustomer.get(event.customer_id).push(event);}
  for(const rows of browseGroups){const id=rows[0].customer_id;visitsByCustomer.set(id,(visitsByCustomer.get(id)||0)+1);}
  for(const event of verifiedOrderEvents)ordersByCustomer.set(event.customer_id,(ordersByCustomer.get(event.customer_id)||0)+1);
  for(const [kind,rows] of timelineSources)for(const event of rows){
    if(!activityByCustomer.has(event.customer_id))activityByCustomer.set(event.customer_id,{count:0,lastActiveAt:null,items:[]});
    const activity=activityByCustomer.get(event.customer_id);activity.count++;
    if(!activity.lastActiveAt || Date.parse(event.created_at)>Date.parse(activity.lastActiveAt))activity.lastActiveAt=event.created_at;
    if(!options.overview)activity.items.push({at:event.created_at,type:event.event_type || (kind==='legacy-search'?'search':'recorded_event'),label:kind==='actual-order' ? (event.order_number || event.id || 'Recorded order') : event.search_term || event.product_id || event.event_type || 'Recorded event',...(kind==='actual-order' ? {orderId:event.id,orderStatus:event.status || null} : {}),source:kind,catalogueSource:event.source || null,sku:event.product_id || event.clicked_product_sku || null,sessionId:event.session_id || null});
  }
  const customerIds=unique([...allCustomers.filter(c=>options.includeInternal || !excluded.has(c.id)).map(c=>c.id),...events.map(e=>e.customer_id),...legacy.searches.map(e=>e.customer_id),...legacy.journeys.map(e=>e.customer_id),...legacy.legacyEvents.map(e=>e.customer_id),...orders.map(e=>e.customer_id)]);
  const customers = customerIds.map(id=>{
    const profile=customerMap.get(id)||{}; const own=eventsByCustomer.get(id)||[];
    const activity=activityByCustomer.get(id);const timeline=options.overview ? [] : (activity?.items || []).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,200);
    const productCategories=values(profile.product_categories); const observedCategories=unique(own.map(e=>category(productMap.get(String(e.product_id)))));
    const matches=p=>unique([...matchedRegistrationInterests(productCategories,p?.category_path),...productCategories.filter(i=>norm(i)===norm(category(p)))]);
    const matchedInterests=unique(own.flatMap(e=>matches(productMap.get(String(e.product_id)))));
    const suggestionRows=new Map();
    for(const p of options.overview ? [] : productMap.values()){
      if(p.is_archived !== false || !Number.isFinite(p.stock_on_hand) || p.stock_on_hand <= 0 || !matches(p).length)continue;
      const sku=String(p.code || p.sku || p.id);const key=`${p.source || 'unknown'}:${sku}`;
      if(!suggestionRows.has(key))suggestionRows.set(key,{p,sku});
    }
    const recommendations=[...suggestionRows.values()].slice(0,5).map(({p,sku})=>({sku,name:p.name || p.product_name || sku,source:p.source || null,reason:`Matches stated interest: ${matches(p).join(', ')}`,verified:true,url:p.url || null}));
    return {id,name:profile.name || profile.business_name || id,businessName:profile.business_name || null,interests:{productCategories,salesChannels:values(profile.sales_channels),supplyNeeds:values(profile.supply_needs)},observedCategories,matchedInterests,recommendations,timeline,timelineTruncated:(activity?.count || 0)>200,counts:{visits:visitsByCustomer.get(id)||0,searches:own.filter(e=>e.event_type===TYPES.search).length,productViews:own.filter(e=>e.event_type===TYPES.view).length,basketAdds:own.filter(e=>e.event_type===TYPES.cart).length,orders:ordersByCustomer.get(id)||0},lastActiveAt:activity?.lastActiveAt || null};
  }).sort((a,b)=>Date.parse(b.lastActiveAt || 0)-Date.parse(a.lastActiveAt || 0));
  const missingSources=SOURCES.filter(k=>!sources[k].available);
  const partialSources=SOURCES.filter(k=>sources[k].available && sources[k].truncated);
  const notes=['Recorded authenticated activity only; unrecorded behaviour cannot be reconstructed.','Legacy searches and journey sessions are displayed separately, never joined to the new session funnel.','Legacy records without environment/internal labels cannot be retrospectively separated from staff or preview traffic unless customer IDs are excluded.','Submitted orders are verified records, not paid revenue.','Search followed by an action is association, not proof search caused the purchase.','Trend dates are UTC; date filters include the start and exclude the end.'];
  if(source)notes.push('Source-filtered metrics exclude unlabelled and legacy activity; order totals remain all-source actual orders.');
  if(rejectedOrders)notes.push(`${rejectedOrders} submitted-order events could not be verified against an eligible customer-owned order in this period.`);
  const unlinkedEvents=events.filter(e=>!sessionKey(e)).length;
  if(unlinkedEvents)notes.push(`${unlinkedEvents} events lack a customer/session key and are excluded from visit rates and funnels.`);
  if(events.length && !browseGroups.length)notes.push('No catalogue visit events were recorded; search usage rates are unavailable.');
  const quality={status:missingSources.length || Object.values(sources).some(s=>s.truncated) || unlinkedEvents ? 'partial':'available',sources,missingSources,partialSources,latestEventAt:events.at(-1)?.created_at || null,notes,unlinkedEvents,rejectedOrderEvents:rejectedOrders,excludedCustomerIds:[...excluded],legacyCounts:{searches:legacy.searches.length,journeys:legacy.journeys.length,events:legacy.legacyEvents.length,visits:visits.length},matchedPresenceVisits:visits.filter(v=>groups.has(sessionKey(v))).length};
  if(sources.events.truncated){summary.searchUsageRate=null;popup.searchAfterTipRate=null;for(const step of funnel){step.rate=null;step.stepRate=null;}for(const term of terms)term.noResultRate=null;notes.push('Event retrieval was truncated: counts are a recorded subset and conversion rates are unavailable.');}
  if(sources.orders.truncated){funnel.at(-1).rate=null;funnel.at(-1).stepRate=null;notes.push('Order retrieval was truncated: verification covers only the retrieved order subset.');}
  const actions=[];
  for(const t of terms.filter(t=>t.noResults>=3))actions.push({id:`term:${t.term}`,drilldown:{type:'term',value:t.term},title:`Review searches for “${t.term}”`,detail:'Check product coverage and searchable names; this does not prove demand or a search-engine defect.',evidence:{searches:t.searches,noResults:t.noResults,customers:t.customers},minimumSample:3});
  for(const p of products.filter(p=>p.views>=5 && p.customers>=3 && p.basketAdds===0))actions.push({id:`product:${p.id}`,drilldown:{type:'product',value:p.sku,source:p.source || 'unknown'},title:`Review ${p.name} (${p.source === 'main' ? 'main catalogue' : p.source === 'instore' ? 'Instore' : 'source not recorded'})`,detail:'Recorded views have no basket additions in this period. Check imagery, availability and product information before drawing conclusions.',evidence:{views:p.views,customers:p.customers,basketAdds:0},minimumSample:5});
  if(partialSources.length)actions.unshift({id:'partial-coverage',title:'Review retrieval limits before comparing performance',detail:`Partial sources reached a retrieval limit: ${partialSources.join(', ')}. Retrieved counts are subsets, not complete totals.`,evidence:{partialSources}});
  if(missingSources.length)actions.unshift({id:'coverage',title:'Resolve tracking gaps before interpreting conversion',detail:`Unavailable sources: ${missingSources.join(', ')}`,evidence:{missingSources}});
  const definitions={recordedVisits:'Distinct customer + session groups with a catalogue_viewed event in the filtered period. Historical presence rows do not establish visit coverage.',searchUsageRate:'Recorded browsing visits with a later search / recorded browsing visits; fraction, null when denominator is zero.',funnel:'Ordered new events in one customer/session: catalogue → search → product view → same-product addition → checkout → verified order. No legacy joins.',verifiedOrders:'Unique order IDs with matching event customer, eligible actual order status and order timestamp within the period. Not paid revenue or search-attributed sales.',popup:'Recorded tip events and later searches within the same customer/session. Association, not causal uplift.',interests:'Registration fields are stated interests; observed categories require exact product-catalog category matches. Recommendations are catalog matches, not newly-arrived claims.'};
  definitions.noResultRate='Searches with zero results / searches with a recorded nonnegative integer result count. Unknown outcomes are excluded; null when no outcomes are known.';
  definitions.products='Activity is grouped by recorded catalogue source and SKU. Names and departments use current catalogue records. Same-SKU colour or size variants are not separately measured; a matching SKU does not prove an exact historical variant.';
  definitions.funnel+=' Started checkout records opening the order review, not a final submission or payment.';
  definitions.funnel+=' Final-stage credit requires the actual order timestamp at or after the matched checkout and no later than 60 seconds after the submitted-order event; an older owned order cannot complete a new checkout.';
  definitions.interests+=' Actionable suggestions require a current catalogue row explicitly marked not archived with finite positive stock. Unknown availability is omitted; suggestions do not claim a new arrival.';
  return {summary,historicalSummary,trend,funnel,terms,products,departments,customers,popup,quality,actions,definitions,overview:summary,trends:trend,searchTerms:terms,coverage:quality};
}

/** Recorded windows only: legacy records cannot supply a historical baseline. */
export function buildShoppingComparison(currentInput, previousInput, currentScope, previousScope, currentData) {
  const current = currentData || buildShoppingAnalytics(currentInput, { ...currentScope, overview: true });
  const previous = buildShoppingAnalytics(previousInput, { ...previousScope, overview: true });
  const dependencyStatus = dependencies => {
    for (const [period, data] of [['current', current], ['previous', previous]]) {
      for (const key of dependencies) {
        if (!data.quality.sources[key].available) return `${period}_${key}_unavailable`;
        if (data.quality.sources[key].truncated) return `${period}_${key}_partial`;
      }
      if (!currentScope.includeInternal && (!data.quality.sources.customers.available || data.quality.sources.customers.truncated)) return `${period}_customer_exclusions_incomplete`;
    }
    return null;
  };
  const change = (currentValue, previousValue, reason) => {
    if (reason || currentValue === null || previousValue === null) return { current: currentValue, previous: previousValue, absoluteDelta: null, relativeDelta: null, status: 'not_comparable', reason: reason || 'metric_unavailable' };
    if (previousValue === 0) return { current: currentValue, previous: previousValue, absoluteDelta: null, relativeDelta: null, status: currentValue > 0 ? 'new_recorded_activity' : 'no_recorded_history', reason: 'No positive recorded prior baseline; historical tracking coverage is unknown.' };
    return { current: currentValue, previous: previousValue, absoluteDelta: currentValue - previousValue, relativeDelta: (currentValue - previousValue) / previousValue, status: 'comparable', reason: null };
  };
  const metrics = Object.fromEntries(Object.keys(current.summary).map(key => [key, change(current.summary[key], previous.summary[key], dependencyStatus(key === 'actualOrders' ? ['orders'] : key === 'verifiedOrders' ? ['events', 'orders'] : ['events']))]));
  const priorTerms = new Map(previous.terms.map(row => [row.term, row.searches]));
  const currentTerms = new Map(current.terms.map(row => [row.term, row.searches]));
  const searchChanges = [...new Set([...currentTerms.keys(), ...priorTerms.keys()])].map(term => {
    const result = change(current.quality.sources.events.available ? currentTerms.get(term) || 0 : null, previous.quality.sources.events.available ? priorTerms.get(term) || 0 : null, dependencyStatus(['events']));
    return { term, currentSearches: result.current, previousSearches: result.previous, ...result };
  }).sort((a,b) => Math.abs(b.absoluteDelta || 0) - Math.abs(a.absoluteDelta || 0) || b.currentSearches - a.currentSearches || a.term.localeCompare(b.term));
  const range = (scope, data, input) => ({ since: scope.since, until: scope.until, latestEventAt: data.quality.latestEventAt, latestOrderAt: list(input.orders).filter(row => instant(row)>=Date.parse(scope.since) && instant(row)<Date.parse(scope.until) && (scope.includeInternal || (!data.quality.excludedCustomerIds.includes(row.customer_id) && row.is_internal!==true && (!row.environment || row.environment==='production')))).map(row=>row.created_at).sort().at(-1) || null });
  return { current: range(currentScope, current, currentInput), previous: range(previousScope, previous, previousInput), metrics, searchChanges: searchChanges.slice(0,100),
    searchChangesLimit: { total: searchChanges.length, returned: Math.min(searchChanges.length,100), truncated: searchChanges.length > 100 },
    quality: Object.fromEntries([['current',current],['previous',previous]].map(([key,data]) => [key, Object.fromEntries(['events','orders','customers'].map(name => [name,data.quality.sources[name]]))])),
    definition: 'Adjacent equal-duration UTC windows, inclusive start and exclusive end, with identical source and internal filters. Changes describe recorded activity, not causal improvement. No prior legacy baseline. Relative changes are fractions; rate absolute changes are fraction points. Unavailable or limited dependent sources suppress deltas. Zero prior values do not establish historical coverage. Actual orders remain all-source.' };
}

export function buildShoppingEvidence(input, scope) {
  const shaped = buildShoppingAnalytics(input, { ...scope, overview: true });
  const excluded = new Set(shaped.quality.excludedCustomerIds);
  const products = new Map();
  for (const product of list(input.products)) for (const key of unique([product.code,product.sku,product.id])) products.set(String(key),product);
  const events = dedup(list(input.events)).filter(row => instant(row) >= Date.parse(scope.since) && instant(row) < Date.parse(scope.until) &&
    (scope.includeInternal || (!excluded.has(row.customer_id) && row.is_internal !== true && (!row.environment || row.environment === 'production'))) &&
    (scope.source === 'all' || row.source === scope.source));
  const termSearches = new Map(events.filter(row => row.event_type === TYPES.search && norm(row.search_term) === norm(scope.evidenceValue)).map(row => [`${sessionKey(row)}:${row.event_id || row.id || row.search_id}`,row]));
  const matches = events.filter(row => {
    if (scope.evidenceType === 'term') return (row.event_type === TYPES.search && norm(row.search_term) === norm(scope.evidenceValue)) || (row.event_type === 'search_result_clicked' && sessionKey(row) && termSearches.has(`${sessionKey(row)}:${row.search_id}`) && instant(row)>=instant(termSearches.get(`${sessionKey(row)}:${row.search_id}`)));
    if (scope.evidenceType === 'product') return [TYPES.view,TYPES.cart].includes(row.event_type) && String(row.product_id) === scope.evidenceValue && (!scope.evidenceSource || (row.source || 'unknown') === scope.evidenceSource);
    return (row.event_type === 'department_viewed' ? text(row.metadata?.department || row.metadata?.category) : category(products.get(String(row.product_id)))) === scope.evidenceValue;
  }).sort((a,b)=>instant(b)-instant(a));
  const countsFor = rows => ({ events: rows.length, searches: rows.filter(row=>row.event_type===TYPES.search).length, productViews: rows.filter(row=>row.event_type===TYPES.view).length, basketAdds: rows.filter(row=>row.event_type===TYPES.cart).length, clicks: rows.filter(row=>row.event_type==='search_result_clicked').length, departmentViews: rows.filter(row=>row.event_type==='department_viewed').length });
  const profileMap = new Map(shaped.customers.map(row=>[row.id,row]));
  const ids = unique(matches.map(row=>row.customer_id));
  const customers = ids.slice(0,50).map(id=>({id,name:profileMap.get(id)?.name || 'Recorded customer',businessName:profileMap.get(id)?.businessName || null,counts:countsFor(matches.filter(row=>row.customer_id===id))}));
  const exclusionsIncomplete = !scope.includeInternal && (!shaped.quality.sources.customers.available || shaped.quality.sources.customers.truncated);
  const coverage = { exclusionsIncomplete, events: shaped.quality.sources.events, customers: shaped.quality.sources.customers, products: shaped.quality.sources.products,
    notes: ['Examples are bounded recorded events, not complete customer histories. Counts cover matching retrieved rows.', ...(exclusionsIncomplete ? ['Customer profiles are unavailable or partial: staff exclusions cannot be verified for every recorded customer. Matching counts are unavailable and examples may include unidentified internal activity.'] : []), ...(scope.evidenceType==='department' && (!shaped.quality.sources.products.available || shaped.quality.sources.products.truncated) ? ['Department counts are unavailable because current catalogue category coverage is incomplete.'] : []), ...shaped.quality.notes] };
  const records = matches.slice(0,50).map(row=>({at:row.created_at,type:row.event_type,label:row.search_term || products.get(String(row.product_id))?.name || row.product_id || scope.evidenceValue,source:'shopping',catalogueSource:row.source || null,sku:row.product_id || null,customerId:row.customer_id || null}));
  return {type:scope.evidenceType,value:scope.evidenceValue,label:scope.evidenceValue,source:scope.evidenceSource || scope.source,counts:!exclusionsIncomplete && shaped.quality.sources.events.available && (scope.evidenceType!=='department' || (shaped.quality.sources.products.available && !shaped.quality.sources.products.truncated)) ? {...countsFor(matches),customers:ids.length} : null,customers,records,
    limited:matches.length>50 || ids.length>50 || shaped.quality.sources.events.truncated, limits:{records:{total:matches.length,returned:records.length,maximum:50},customers:{total:ids.length,returned:customers.length,maximum:50}},coverage};
}
