import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShoppingAnalytics, buildShoppingComparison, buildShoppingEvidence } from '../lib/shopping-analytics.mjs';

const at = n => `2026-10-02T10:00:${String(n).padStart(2,'0')}Z`;
const event = (type,n,extra={}) => ({event_id:`e${n}`,event_type:type,created_at:at(n),customer_id:'c1',session_id:'s1',source:'main',environment:'production',...extra});
const fixture = events => ({events,visits:[],searches:[],journeys:[],legacyEvents:[],orders:[],customers:[{id:'c1',name:'Shop',product_categories:['Paint'],sales_channels:['Retail'],supply_needs:['Monthly']}],products:[{sku:'P1',name:'Olive paint',category:'Paint',is_archived:false,stock_on_hand:12}]});

test('empty new tracking preserves separate older records and all saved order statuses without funnel credit',()=>{
  const input=fixture([]);input.visits=[{id:'v1',customer_id:'c1',started_at:at(1)}];input.searches=[{id:'q1',customer_id:'c1',created_at:at(2),search_term:'paint'}];input.journeys=[{id:'j1',customer_id:'c1',created_at:at(3)}];input.legacyEvents=[{id:'l1',customer_id:'c1',created_at:at(4)}];input.orders=[{id:'o1',customer_id:'c1',status:'cancelled',created_at:at(5)},{id:'o2',customer_id:'c1',status:'submitted',created_at:at(6)}];input.orders.push({...input.orders[1]});
  const result=buildShoppingAnalytics(input);assert.equal(result.summary.recordedVisits,0);assert.equal(result.summary.verifiedOrders,0);assert.equal(result.historicalSummary.searches.count,1);assert.equal(result.historicalSummary.presenceRecords.count,1);assert.equal(result.historicalSummary.actualOrders.count,2);assert.equal(result.summary.actualOrders,1);assert.deepEqual(result.funnel.map(stage=>stage.count),[0,0,0,0,0,0]);
});
test('older catalogue splits remain unknown even if an untrusted legacy row carries a source',()=>{
  const input=fixture([]);input.searches=[{id:'q1',customer_id:'c1',created_at:at(2),source:'main'}];input.visits=[{id:'v1',customer_id:'c1',started_at:at(1)}];input.orders=[{id:'o1',customer_id:'c1',created_at:at(3)}];
  for(const source of ['main','instore']){const h=buildShoppingAnalytics(input,{source}).historicalSummary;for(const key of ['searches','journeys','events','presenceRecords']){assert.equal(h[key].count,null);assert.equal(h[key].status,'source_not_recorded');}assert.equal(h.actualOrders.count,1);assert.equal(h.actualOrders.source,'All catalogues');}
});
test('historical missing and partial reads distinguish unavailable from subset counts and verified zero',()=>{
  const input=fixture([]);input.searches=[{id:'q1',customer_id:'c1',created_at:at(2)}];input.sourceStatuses={searches:{available:true,truncated:true,error:'row_limit'},visits:{available:false,error:'read_failed'}};
  const h=buildShoppingAnalytics(input).historicalSummary;assert.equal(h.searches.count,1);assert.equal(h.searches.status,'partial');assert.equal(h.presenceRecords.count,null);assert.equal(h.presenceRecords.status,'unavailable');assert.equal(h.events.count,0);assert.equal(h.events.status,'available');assert.equal(buildShoppingAnalytics({}).historicalSummary.actualOrders.count,null);
});
test('historical date window and staff exclusions apply without merging old customer sessions',()=>{
  const input=fixture([]);input.customers.push({id:'staff',role:'admin'});input.searches=[{id:'old',customer_id:'c1',created_at:'2026-10-01T10:00:00Z'},{id:'new',customer_id:'c1',created_at:at(2)},{id:'staff',customer_id:'staff',created_at:at(3)},{id:'preview',customer_id:'c1',created_at:at(4),environment:'preview'}];
  const scope={since:'2026-10-02T00:00:00Z',until:'2026-10-03T00:00:00Z'};assert.equal(buildShoppingAnalytics(input,scope).historicalSummary.searches.count,1);assert.equal(buildShoppingAnalytics(input,{...scope,includeInternal:true}).historicalSummary.searches.count,3);
});
test('incomplete customer profiles suppress older counts until internal inclusion is explicit',()=>{
  const input=fixture([]);input.searches=[{id:'q',customer_id:'c1',created_at:at(2)}];input.sourceStatuses={customers:{available:true,truncated:true}};
  assert.equal(buildShoppingAnalytics(input).historicalSummary.searches.count,null);assert.equal(buildShoppingAnalytics(input).historicalSummary.actualOrders.count,null);assert.equal(buildShoppingAnalytics(input,{includeInternal:true}).historicalSummary.searches.count,1);
});

test('zero denominators remain unavailable, unavailable sources never become successful zeros',()=>{
  assert.equal(buildShoppingAnalytics(fixture([])).summary.searchUsageRate,null);
  assert.equal(buildShoppingAnalytics({}).summary.searches,null);
  assert.equal(buildShoppingAnalytics({}).quality.status,'partial');
  assert.equal(buildShoppingAnalytics(fixture([event('search_results_viewed',1,{search_term:'paint'})])).summary.searchUsageRate,null);
});
test('append-only click events preserve multiple clicks but duplicate delivery is counted once',()=>{
  const s=event('search_results_viewed',2,{event_id:'q',search_term:' Paint ',results_count:2});
  const c=event('search_result_clicked',3,{search_id:'q',product_id:'P1'});
  const result=buildShoppingAnalytics(fixture([event('catalogue_viewed',1),s,c,{...c},event('search_result_clicked',4,{search_id:'q',product_id:'P2'})]));
  assert.equal(result.terms[0].clicks,2); assert.equal(result.summary.searchUsageRate,1);
});
test('no cross-customer or cross-session click joins and legacy results stay separate',()=>{
  const input=fixture([event('search_results_viewed',2,{event_id:'q',search_term:'paint',results_count:0}),event('search_result_clicked',3,{search_id:'q',customer_id:'c2'})]);
  input.searches=[{id:'old',customer_id:'c1',session_id:'old-session',search_term:'paint',created_at:at(2),results_found:20,clicked_product_sku:'P1'}];
  const result=buildShoppingAnalytics(input); assert.equal(result.terms[0].clicks,0);assert.equal(result.summary.searches,1);assert.equal(result.quality.legacyCounts.searches,1);assert.equal(result.customers.find(c=>c.id==='c1').timeline.some(t=>t.source==='legacy-search'),true);
});
test('funnel requires ordered events and same-product addition, not accumulated stage totals',()=>{
  const wrong=fixture([event('catalogue_viewed',1),event('basket_item_added',2,{product_id:'P1'}),event('search_results_viewed',3),event('product_viewed',4,{product_id:'P1'}),event('basket_item_added',5,{product_id:'P2'}),event('checkout_started',6)]);
  assert.deepEqual(buildShoppingAnalytics(wrong).funnel.map(s=>s.count),[1,1,1,0,0,0]);
  wrong.events.push(event('basket_item_added',7,{product_id:'P1'}),event('checkout_started',8));
  assert.deepEqual(buildShoppingAnalytics(wrong).funnel.map(s=>s.count),[1,1,1,1,1,0]);
});
test('orders are verified against ownership, status, date and ID; replay does not inflate',()=>{
  const input=fixture([event('catalogue_viewed',1),event('search_results_viewed',2),event('product_viewed',3,{product_id:'P1'}),event('basket_item_added',4,{product_id:'P1'}),event('checkout_started',5),event('order_submitted',6,{order_id:'o1'}),event('order_submitted',7,{order_id:'o1'}),event('order_submitted',8,{order_id:'o2'}),event('order_submitted',9,{order_id:'o3'}),event('order_submitted',10,{order_id:'missing'})]);
  input.orders=[{id:'o1',customer_id:'c1',status:'submitted',created_at:at(6)},{id:'o2',customer_id:'c2',status:'submitted',created_at:at(8)},{id:'o3',customer_id:'c1',status:'cancelled',created_at:at(9)}];
  const result=buildShoppingAnalytics(input);assert.equal(result.summary.verifiedOrders,1);assert.equal(result.funnel.at(-1).count,1);assert.equal(result.quality.rejectedOrderEvents,3);
  assert.equal(buildShoppingAnalytics({...input,orders:undefined}).summary.verifiedOrders,null);
});
test('source/date/environment/staff/exact-ID exclusions apply before aggregating',()=>{
  const input=fixture([event('catalogue_viewed',1),event('search_results_viewed',2,{source:'instore'}),event('search_results_viewed',3,{environment:'preview'}),event('search_results_viewed',4,{customer_id:'staff'}),event('search_results_viewed',5,{customer_id:'excluded'}),event('search_results_viewed',6,{is_internal:true})]);
  input.customers.push({id:'staff',role:'admin'});
  assert.equal(buildShoppingAnalytics(input,{excludedCustomerIds:['excluded']}).summary.searches,1);
  assert.equal(buildShoppingAnalytics(input,{source:'main',since:at(2),until:at(5),excludedCustomerIds:['excluded']}).summary.searches,0);
  assert.equal(buildShoppingAnalytics(input,{includeInternal:true}).summary.searches,5);
  assert.throws(()=>buildShoppingAnalytics(input,{since:'invalid'}),RangeError);
});
test('interests remain distinct from observations; recommendations require exact verified catalog categories',()=>{
  const input=fixture([event('product_viewed',1,{product_id:'P1'}),event('product_viewed',2,{product_id:'unknown'})]);
  input.products.push({sku:'P2',name:'Paintbrush',category:'Paint supplies',is_archived:false,stock_on_hand:12});
  const customer=buildShoppingAnalytics(input).customers[0];
  assert.deepEqual(customer.interests.productCategories,['Paint']);assert.deepEqual(customer.observedCategories,['Paint']);assert.deepEqual(customer.matchedInterests,['Paint']);assert.equal(customer.recommendations.length,1);assert.equal(customer.recommendations[0].sku,'P1');assert.equal(customer.recommendations[0].verified,true);
});
test('popup search association is ordered within the same session and not just button clicks',()=>{
  const input=fixture([event('search_results_viewed',1),event('search_tip_shown',2),event('search_tip_search_clicked',3),event('search_results_viewed',4,{session_id:'other'})]);
  assert.equal(buildShoppingAnalytics(input).popup.searchAfterTip,0);
  input.events.push(event('search_results_viewed',5));assert.equal(buildShoppingAnalytics(input).popup.searchAfterTip,1);
});
test('truncation/errors are visible and bounded timelines retain source labels',()=>{
  const input=fixture([event('catalogue_viewed',1)]);input.sourceStatuses={events:{available:true,truncated:true},journeys:{available:false,error:'permission_denied'}};
  const result=buildShoppingAnalytics(input);assert.equal(result.quality.status,'partial');assert.equal(result.quality.sources.events.truncated,true);assert.equal(result.quality.sources.journeys.error,'permission_denied');assert.equal(result.customers[0].timeline[0].source,'shopping');
  assert.equal(result.summary.searchUsageRate,null);assert.equal(result.funnel[0].rate,null);
});
test('code/category_path adapter and curated registration mapping use exact verified path segments',()=>{
  const input=fixture([event('product_viewed',1,{product_id:'CP50'})]);input.products=[{id:'uuid',code:'CP50',name:'Craft paint',category_path:['arts-crafts-stationery','paint-art-supplies'],is_archived:false,stock_on_hand:8}];input.customers[0].product_categories=['Art, craft & beads'];
  const result=buildShoppingAnalytics(input);assert.equal(result.products[0].name,'Craft paint');assert.deepEqual(result.customers[0].matchedInterests,['Art, craft & beads']);assert.equal(result.customers[0].recommendations[0].sku,'CP50');
});
test('source filter retains session-bound nondimensional checkout but excludes unrelated sessions and end timestamp',()=>{
  const input=fixture([event('catalogue_viewed',1),event('search_results_viewed',2),event('product_viewed',3,{product_id:'P1'}),event('basket_item_added',4,{product_id:'P1'}),event('checkout_started',5,{source:null}),event('search_tip_shown',6,{source:null,session_id:'other'})]);
  assert.equal(buildShoppingAnalytics(input,{source:'main'}).funnel[4].count,1);assert.equal(buildShoppingAnalytics(input,{source:'main'}).popup.shown,0);assert.equal(buildShoppingAnalytics(input,{until:at(5)}).funnel[4].count,0);
});
test('action recommendations use minimum sample sizes and never claim demand or causation',()=>{
  const input=fixture([1,2,3].map(n=>event('search_results_viewed',n,{search_term:'missing',results_count:0})));
  const result=buildShoppingAnalytics(input);assert.equal(result.actions.length,1);assert.equal(result.actions[0].minimumSample,3);assert.equal(result.actions[0].evidence.noResults,3);
  input.events.pop();assert.equal(buildShoppingAnalytics(input).actions.length,0);
});
test('unknown search outcomes do not count as successful results in no-result rates',()=>{
  const input=fixture([event('search_results_viewed',1,{search_term:'paint',results_count:0}),event('search_results_viewed',2,{search_term:'paint',results_count:3}),event('search_results_viewed',3,{search_term:'paint',results_count:null}),event('search_results_viewed',4,{search_term:'paint'}),event('search_results_viewed',5,{search_term:'unknown',results_count:null})]);
  const result=buildShoppingAnalytics(input);const paint=result.terms.find(term=>term.term==='paint');
  assert.equal(paint.searches,4);assert.equal(paint.unknownResults,2);assert.equal(paint.knownResults,2);assert.equal(paint.noResultRate,.5);
  assert.equal(result.terms.find(term=>term.term==='unknown').noResultRate,null);
});
test('identical SKUs in main, Instore and unknown sources remain separate activity records',()=>{
  const input=fixture([event('product_viewed',1,{product_id:'P1',source:'main'}),event('product_viewed',2,{product_id:'P1',source:'instore'}),event('product_viewed',3,{product_id:'P1',source:null}),event('basket_item_added',4,{product_id:'P1',source:'instore'})]);
  const products=buildShoppingAnalytics(input).products;
  assert.equal(products.length,3);assert.equal(new Set(products.map(product=>product.id)).size,3);
  assert.equal(products.find(product=>product.source==='main').basketAdds,0);assert.equal(products.find(product=>product.source==='instore').basketAdds,1);assert.equal(products.find(product=>product.source===null).views,1);
});
test('same-SKU product investigation actions have unique source-specific identities',()=>{
  const events=[];let minute=1;for(const source of ['main','instore'])for(let index=0;index<6;index++)events.push(event('product_viewed',minute++,{product_id:'P1',source,customer_id:`shop-${index%3}`}));
  const result=buildShoppingAnalytics(fixture(events));const actions=result.actions.filter(action=>action.id.startsWith('product:'));
  assert.equal(actions.length,2);assert.equal(new Set(actions.map(action=>action.id)).size,2);assert.ok(actions.some(action=>action.id==='product:main:P1'));assert.ok(actions.some(action=>action.id==='product:instore:P1'));
  assert.match(result.definitions.products,/variants are not separately measured/);
});
test('reusing an older owned order cannot complete a later checkout funnel',()=>{
  const input=fixture([event('catalogue_viewed',1),event('search_results_viewed',2),event('product_viewed',3,{product_id:'P1'}),event('basket_item_added',4,{product_id:'P1'}),event('checkout_started',5),event('order_submitted',6,{order_id:'old-owned'})]);
  input.orders=[{id:'old-owned',customer_id:'c1',status:'submitted',created_at:at(1)}];
  const result=buildShoppingAnalytics(input);
  assert.equal(result.summary.actualOrders,1);assert.equal(result.summary.verifiedOrders,1);assert.equal(result.funnel[4].count,1);assert.equal(result.funnel[5].count,0);
  assert.match(result.definitions.funnel,/older owned order cannot complete a new checkout/);
});
test('order funnel requires actual creation inside checkout-to-submission time bounds',()=>{
  const input=fixture([event('catalogue_viewed',1),event('search_results_viewed',2),event('product_viewed',3,{product_id:'P1'}),event('basket_item_added',4,{product_id:'P1'}),event('checkout_started',5),event('order_submitted',6,{order_id:'new-order'})]);
  const order={id:'new-order',customer_id:'c1',status:'submitted',created_at:at(5)};
  input.orders=[order];assert.equal(buildShoppingAnalytics(input).funnel[5].count,1);
  input.orders=[{...order,created_at:new Date(Date.parse(at(6))+60000).toISOString()}];assert.equal(buildShoppingAnalytics(input).funnel[5].count,1);
  input.orders=[{...order,created_at:new Date(Date.parse(at(6))+60001).toISOString()}];assert.equal(buildShoppingAnalytics(input).funnel[5].count,0);
  input.orders=[{...order,customer_id:'another-customer'}];assert.equal(buildShoppingAnalytics(input).funnel[5].count,0);
  input.orders=[{...order,status:'cancelled'}];assert.equal(buildShoppingAnalytics(input).funnel[5].count,0);
});
test('actionable interest suggestions exclude archived and unknown or unavailable stock',()=>{
  const input=fixture([]);const product={name:'Example paint',category:'Paint',is_archived:false,stock_on_hand:4};
  input.products=[{...product,sku:'AVAILABLE'},{...product,sku:'ARCHIVED',is_archived:true},{...product,sku:'ARCHIVE-UNKNOWN',is_archived:undefined},{...product,sku:'ZERO',stock_on_hand:0},{...product,sku:'NEGATIVE',stock_on_hand:-1},{...product,sku:'STOCK-UNKNOWN',stock_on_hand:null},{...product,sku:'NONFINITE',stock_on_hand:Infinity}];
  const result=buildShoppingAnalytics(input);assert.deepEqual(result.customers[0].recommendations.map(product=>product.sku),['AVAILABLE']);assert.equal(result.customers[0].recommendations[0].verified,true);
  assert.match(result.definitions.interests,/Unknown availability is omitted/);
});
test('a duplicate SKU alias cannot replace an eligible suggestion with an archived catalogue row',()=>{
  const input=fixture([]);input.products=[{id:'current-row',code:'PAINT',name:'Current paint',category:'Paint',is_archived:false,stock_on_hand:4},{id:'old-row',code:'PAINT',name:'Archived paint',category:'Paint',is_archived:true,stock_on_hand:9}];
  const suggestions=buildShoppingAnalytics(input).customers[0].recommendations;
  assert.equal(suggestions.length,1);assert.equal(suggestions[0].name,'Current paint');assert.equal(suggestions[0].sku,'PAINT');
});
test('overview aggregation skips timelines and suggestions but preserves activity totals and freshness',()=>{
  const input=fixture([event('catalogue_viewed',1),event('product_viewed',2,{product_id:'P1'})]);input.searches=[{id:'legacy',customer_id:'c1',created_at:at(3),search_term:'older tracking'}];
  const full=buildShoppingAnalytics(input);const overview=buildShoppingAnalytics(input,{overview:true});
  assert.deepEqual(overview.summary,full.summary);assert.deepEqual(overview.customers[0].counts,full.customers[0].counts);assert.equal(overview.customers[0].lastActiveAt,full.customers[0].lastActiveAt);assert.deepEqual(overview.customers[0].timeline,[]);assert.deepEqual(overview.customers[0].recommendations,[]);assert.ok(full.customers[0].timeline.length>0);assert.ok(full.customers[0].recommendations.length>0);
});

const currentScope={since:'2026-09-25T00:00:00Z',until:'2026-10-02T00:00:00Z',source:'main'};
const priorScope={...currentScope,since:'2026-09-18T00:00:00Z',until:currentScope.since};
const dated=(type,id,date,extra={})=>({...event(type,1,extra),event_id:id,created_at:date});
test('period comparisons use adjacent windows and identical staff/source filters without legacy visits',()=>{
 const current=fixture([dated('search_results_viewed','c1','2026-09-26T00:00:00Z',{search_term:'paint'}),dated('search_results_viewed','c2',currentScope.since,{search_term:'paint'}),dated('search_results_viewed','end',currentScope.until),dated('search_results_viewed','staff','2026-09-26T00:00:00Z',{customer_id:'staff'}),dated('search_results_viewed','instore','2026-09-26T00:00:00Z',{source:'instore'})]);current.customers.push({id:'staff',role:'admin'});
 const prior=fixture([dated('search_results_viewed','p1','2026-09-20T00:00:00Z',{search_term:'paint'}),...current.events]);prior.customers=current.customers;prior.visits=[{id:'old',created_at:'2026-09-20T00:00:00Z',customer_id:'c1',session_id:'old'}];
 const result=buildShoppingComparison(current,prior,currentScope,priorScope);assert.equal(result.metrics.searches.current,2);assert.equal(result.metrics.searches.previous,1);assert.equal(result.metrics.searches.absoluteDelta,1);assert.equal(result.metrics.searches.relativeDelta,1);assert.equal(result.metrics.recordedVisits.status,'no_recorded_history');assert.equal(result.searchChanges[0].term,'paint');
});
test('zero baselines, unavailable and partial sources never produce misleading percentage changes',()=>{
 const current=fixture([dated('search_results_viewed','c','2026-09-26T00:00:00Z',{search_term:'paint'})]);const prior=fixture([]);
 assert.equal(buildShoppingComparison(current,prior,currentScope,priorScope).metrics.searches.status,'new_recorded_activity');
 prior.statuses={events:{available:true,error:'row_limit',truncated:true}};const result=buildShoppingComparison(current,prior,currentScope,priorScope);assert.equal(result.metrics.searches.status,'not_comparable');assert.equal(result.metrics.searches.absoluteDelta,null);assert.equal(result.quality.previous.events.available,true);assert.equal(result.metrics.actualOrders.status,'no_recorded_history');
 const partial=buildShoppingAnalytics(prior);assert.deepEqual(partial.quality.partialSources,['events']);assert.equal(partial.quality.missingSources.includes('events'),false);assert.ok(partial.actions.some(a=>a.id==='partial-coverage'));assert.equal(partial.actions.some(a=>a.detail.includes('Unavailable sources: events')),false);
 prior.statuses.events={available:false,error:'not_installed'};assert.equal(buildShoppingComparison(current,prior,currentScope,priorScope).metrics.searches.reason,'previous_events_unavailable');
});
test('evidence preserves exact source SKU, exclusions, linked search lineage and bounded examples',()=>{
 const rows=Array.from({length:60},(_,i)=>dated('product_viewed','v'+i,'2026-09-26T00:00:00Z',{product_id:'P1'}));rows.push(dated('product_viewed','other','2026-09-26T00:00:00Z',{product_id:'P1',source:'instore'}),dated('product_viewed','internal','2026-09-26T00:00:00Z',{product_id:'P1',is_internal:true}));const input=fixture(rows);
 const result=buildShoppingEvidence(input,{...currentScope,evidenceType:'product',evidenceValue:'P1',evidenceSource:'main'});assert.equal(result.counts.productViews,60);assert.equal(result.records.length,50);assert.equal(result.limited,true);assert.equal(result.customers[0].id,'c1');assert.equal(result.records.some(row=>row.catalogueSource!=='main'),false);
 const search=dated('search_results_viewed','q','2026-09-26T00:00:00Z',{search_term:'  PAINT  '});input.events=[search,dated('search_result_clicked','click','2026-09-26T00:01:00Z',{search_id:'q'}),dated('search_result_clicked','wrong','2026-09-26T00:01:00Z',{search_id:'q',customer_id:'c2'})];const term=buildShoppingEvidence(input,{...currentScope,evidenceType:'term',evidenceValue:'paint'});assert.equal(term.counts.searches,1);assert.equal(term.counts.clicks,1);
});

test('comparisons isolate actual-order dependencies and do not fabricate term counts when tracking is absent',()=>{
 const current=fixture([]),prior=fixture([dated('search_results_viewed','prior','2026-09-20T00:00:00Z',{search_term:'paint'})]);current.statuses={events:{available:false,error:'not_installed'}};
 current.orders=[{id:'c',customer_id:'c1',status:'submitted',created_at:'2026-09-26T00:00:00Z'},{id:'c2',customer_id:'c1',status:'submitted',created_at:'2026-09-27T00:00:00Z'}];prior.orders=[{id:'p',customer_id:'c1',status:'submitted',created_at:'2026-09-20T00:00:00Z'}];
 const result=buildShoppingComparison(current,prior,currentScope,priorScope);assert.equal(result.metrics.actualOrders.absoluteDelta,1);assert.equal(result.metrics.verifiedOrders.absoluteDelta,null);assert.equal(result.searchChanges[0].currentSearches,null);assert.equal(result.current.latestOrderAt,'2026-09-27T00:00:00Z');
 prior.statuses={customers:{available:true,truncated:true,error:'row_limit'}};assert.equal(buildShoppingComparison(current,prior,currentScope,priorScope).metrics.actualOrders.reason,'previous_customer_exclusions_incomplete');
});
test('evidence rejects clicks preceding their search and department counts expose incomplete catalogue coverage',()=>{
 const input=fixture([dated('search_results_viewed','q','2026-09-26T00:01:00Z',{search_term:'paint'}),dated('search_result_clicked','before','2026-09-26T00:00:00Z',{search_id:'q'}),dated('product_viewed','paint','2026-09-26T00:02:00Z',{product_id:'P1'}),dated('department_viewed','dept','2026-09-26T00:03:00Z',{metadata:{department:'Paint'}})]);
 assert.equal(buildShoppingEvidence(input,{...currentScope,evidenceType:'term',evidenceValue:'paint'}).counts.clicks,0);
 const dept=buildShoppingEvidence(input,{...currentScope,evidenceType:'department',evidenceValue:'Paint'});assert.equal(dept.counts.productViews,1);assert.equal(dept.counts.departmentViews,1);
 input.statuses={products:{available:false,error:'read_failed'}};assert.equal(buildShoppingEvidence(input,{...currentScope,evidenceType:'department',evidenceValue:'Paint'}).counts,null);
 input.statuses={events:{available:false,error:'not_installed'}};assert.equal(buildShoppingEvidence(input,{...currentScope,evidenceType:'product',evidenceValue:'P1'}).counts,null);
});
test('actual order timeline shows the reference and status without presenting tracking submissions as orders',()=>{
 const input=fixture([event('order_submitted',2,{order_id:'o'})]);input.orders=[{id:'o',customer_id:'c1',order_number:'PROTO-SAMPLE',status:'submitted',created_at:at(2)}];const timeline=buildShoppingAnalytics(input).customers[0].timeline;const actual=timeline.find(row=>row.source==='actual-order');assert.equal(actual.label,'PROTO-SAMPLE');assert.equal(actual.orderId,'o');assert.equal(actual.orderStatus,'submitted');assert.equal(timeline.filter(row=>row.source==='actual-order').length,1);
});

test('evidence counts are unavailable when missing or partial profiles prevent trusted staff exclusions',()=>{
 const input=fixture([dated('product_viewed','customer','2026-09-26T00:00:00Z',{product_id:'P1'}),dated('product_viewed','unidentified','2026-09-26T00:00:00Z',{product_id:'P1',customer_id:'unknown-role'})]);
 for(const status of [{available:false,error:'read_failed'},{available:true,truncated:true,error:'row_limit'}]){
   input.statuses={customers:status};const scope={...currentScope,evidenceType:'product',evidenceValue:'P1'};
   const result=buildShoppingEvidence(input,scope);assert.equal(result.counts,null);assert.equal(result.coverage.exclusionsIncomplete,true);assert.ok(result.coverage.notes.some(note=>note.includes('staff exclusions cannot be verified')));
   const included=buildShoppingEvidence(input,{...scope,includeInternal:true});assert.equal(included.counts.productViews,2);assert.equal(included.coverage.exclusionsIncomplete,false);
 }
});
