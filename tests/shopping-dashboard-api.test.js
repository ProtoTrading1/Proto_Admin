import test from 'node:test';
import assert from 'node:assert/strict';
import { createShoppingDashboardHandler } from '../api/shopping-analytics-dashboard.js';
import { createAnalyticsAdminGuard } from '../api/_analytics-auth.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const ENV = { VITE_SUPABASE_URL: 'https://example.invalid', VITE_SUPABASE_ANON_KEY: 'test-anon-key', SUPABASE_SERVICE_ROLE_KEY: 'test-service-secret', ANALYTICS_EXCLUDED_CUSTOMER_IDS: 'excluded' };
const at = minute => new Date(NOW.getTime() - 3600000 + minute * 60000).toISOString();
function response() { return { statusCode: null, body: null, headers: {}, setHeader(key,value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function fixture() { return { shopping_events: [], customer_visits: [], search_analytics: [], customer_journey_events: [], analytics_events: [], orders: [], customers: [], products: [] }; }
function event(type, minute, extra = {}) { return { event_id: `${type}-${minute}`, event_type: type, created_at: at(minute), customer_id: 'customer', session_id: 'session', source: 'main', environment: 'production', ...extra }; }
function setup({ tables = fixture(), statuses = {}, admin = true, guard, reader, historyReader, healthReader, startReader = async () => ({ firstProductionEventAt: null, available: true, error: null }), client = {} } = {}) {
  const calls = [];
  const requireAdmin = guard || (async (_req,res) => { if (!admin) { res.status(401).json({ error: 'Sign in required' }); return null; } return { id: 'admin' }; });
  const clientFactory = (...args) => { calls.push(args); return client; };
  const readSource = reader || (async (_client,definition) => ({ rows: tables[definition.table] || [], status: statuses[definition.table] || { available: true, error: null, truncated: false } }));
  return { calls, handler: createShoppingDashboardHandler({ requireAdmin, clientFactory, readSource, readStart: startReader, ...(historyReader?{readHistory:historyReader}:{}), ...(healthReader?{readHealth:healthReader}:{}), environment: ENV, now: () => NOW }) };
}
const req = query => ({ method: 'GET', query: query || {}, headers: {} });

test('GET only rejects writes before authentication or database access', async () => {
  const { handler,calls } = setup(); const res = response();
  await handler({ ...req(), method: 'DELETE' },res);
  assert.equal(res.statusCode,405); assert.equal(res.headers.Allow,'GET'); assert.equal(calls.length,0);
});
test('unauthenticated requests never create a service client or query customer records', async () => {
  let reads = 0; const { handler,calls } = setup({ admin: false, reader: async () => { reads++; } }); const res=response();
  await handler(req(),res); assert.equal(res.statusCode,401); assert.equal(calls.length,0); assert.equal(reads,0); assert.equal(res.headers['Cache-Control'],'no-store');
});
test('verified non-admin email stays forbidden regardless of browser metadata claims', async () => {
  const guard = createAnalyticsAdminGuard({ environment: ENV, clientFactory: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'customer', email: 'customer@example.invalid', user_metadata: { role:'owner' } } } }) } }) });
  const { handler,calls }=setup({guard}); const res=response(); await handler({ ...req(),headers:{authorization:'Bearer test-customer-token'} },res);
  assert.equal(res.statusCode,403); assert.equal(calls.length,0);
});
test('expired auth fails closed; allowed verified email uses anon verification key only',async()=>{
  let authArgs; const guard=createAnalyticsAdminGuard({environment:ENV,clientFactory:(...args)=>{authArgs=args;return {auth:{getUser:async()=>({data:{user:null},error:{message:'Expired'}})}}}});
  const res=response(); await guard({...req(),headers:{authorization:'Bearer expired'}},res); assert.equal(res.statusCode,401); assert.equal(authArgs[1],ENV.VITE_SUPABASE_ANON_KEY);
  const valid=createAnalyticsAdminGuard({environment:ENV,clientFactory:()=>({auth:{getUser:async token=>({data:{user:{id:'admin',email:'GEORGE@PROTO.CO.ZA'}}})}})});
  const result=await valid({...req(),headers:{authorization:'Bearer test-admin'}},response()); assert.equal(result.id,'admin');
});
test('invalid scope rejects unbounded periods, unknown sources and ambiguous internal filter',async()=>{
  for(const query of [{days:'365'},{source:'any'},{includeInternal:'yes'}]){ const {handler,calls}=setup(); const res=response(); await handler(req(query),res); assert.equal(res.statusCode,400); assert.equal(calls.length,0); }
});
test('missing shopping table returns explicit partial coverage and unavailable metrics, not zeros',async()=>{
  const {handler}=setup({statuses:{shopping_events:{available:false,error:'not_installed',truncated:false}}}); const res=response(); await handler(req(),res);
  assert.equal(res.statusCode,200); assert.equal(res.body.summary.recordedVisits,null); assert.equal(res.body.summary.searches,null); assert.equal(res.body.summary.searchUsageRate,null); assert.equal(res.body.quality.sources.events.error,'not_installed'); assert.equal(res.body.quality.status,'partial');
});
test('truncated sources suppress rates and remain visible in coverage',async()=>{
  const tables=fixture(); tables.shopping_events=[event('catalogue_viewed',1),event('search_results_viewed',2,{search_term:'paint',results_count:4})];
  const {handler}=setup({tables,statuses:{shopping_events:{available:true,error:null,truncated:true}}}); const res=response(); await handler(req(),res);
  assert.equal(res.body.quality.sources.events.truncated,true); assert.equal(res.body.summary.searchUsageRate,null); assert.equal(res.body.funnel[1].rate,null);
});
test('source filters and server-side staff exclusions apply while actual orders remain explicitly all-source',async()=>{
  const tables=fixture(); tables.customers=[{id:'customer',name:'Example customer'},{id:'staff',role:'admin'},{id:'excluded'}];
  tables.shopping_events=[event('catalogue_viewed',1,{source:'instore'}),event('search_results_viewed',2,{source:'instore',search_term:'clip on',results_count:1}),event('search_results_viewed',3,{source:'main'}),event('search_results_viewed',4,{source:'instore',customer_id:'staff'}),event('search_results_viewed',5,{source:'instore',customer_id:'excluded'}),event('search_results_viewed',6,{source:'instore',environment:'preview'})];
  tables.orders=[{id:'o1',customer_id:'customer',status:'submitted',created_at:at(8)},{id:'o2',customer_id:'staff',status:'submitted',created_at:at(8)}];
  const {handler}=setup({tables}); const res=response(); await handler(req({source:'instore'}),res);
  assert.equal(res.body.summary.searches,1); assert.equal(res.body.terms[0].term,'clip on'); assert.equal(res.body.summary.actualOrders,1); assert.equal(res.body.summary.verifiedOrders,0); assert.ok(res.body.quality.notes.some(note=>note.includes('order totals remain all-source')));
});
test('service role credential never appears in API payload, definitions or errors',async()=>{
  const {handler,calls}=setup(); const res=response(); await handler(req(),res);
  assert.equal(calls[0][1],ENV.SUPABASE_SERVICE_ROLE_KEY); assert.equal(JSON.stringify(res.body).includes(ENV.SUPABASE_SERVICE_ROLE_KEY),false);
  const failed=setup({reader:async()=>{throw new Error(`Database failed with ${ENV.SUPABASE_SERVICE_ROLE_KEY}`)}}); const failedRes=response(); await failed.handler(req(),failedRes);
  assert.equal(failedRes.statusCode,503); assert.equal(JSON.stringify(failedRes.body).includes(ENV.SUPABASE_SERVICE_ROLE_KEY),false);
});
test('verified caller identity is excluded by default even when the customer role is absent',async()=>{
  const tables=fixture(); tables.customers=[{id:'admin',name:'Example internal tester'},{id:'customer',name:'Example customer'}];
  tables.shopping_events=[event('catalogue_viewed',1,{customer_id:'admin'}),event('search_results_viewed',2,{customer_id:'admin',search_term:'staff test'}),event('catalogue_viewed',3),event('search_results_viewed',4,{search_term:'customer search'})];
  const {handler}=setup({tables}); const res=response(); await handler(req(),res);
  assert.equal(res.body.summary.recordedVisits,1); assert.equal(res.body.summary.searches,1); assert.equal(res.body.customers.some(customer=>customer.id==='admin'),false);
  const included=response(); await handler(req({includeInternal:'true'}),included); assert.equal(included.body.summary.recordedVisits,2); assert.equal(included.body.summary.searches,2);
});
test('all server-allowlisted admin emails are excluded despite customer roles and email is never returned',async()=>{
  const tables=fixture(); tables.customers=[{id:'other-admin',name:'Example internal customer',email:'DanielJoffeInfo@gmail.com',role:'customer'},{id:'customer',name:'Example customer',email:'example-customer@example.invalid',role:'customer'}];
  tables.shopping_events=[event('catalogue_viewed',1,{customer_id:'other-admin'}),event('search_results_viewed',2,{customer_id:'other-admin',search_term:'internal test'}),event('catalogue_viewed',3),event('search_results_viewed',4,{search_term:'customer search'})];
  const {handler}=setup({tables});const res=response();await handler(req(),res);
  assert.equal(res.body.summary.searches,1);assert.equal(res.body.customers.some(customer=>customer.id==='other-admin'),false);
  assert.equal(JSON.stringify(res.body).includes('DanielJoffeInfo@gmail.com'),false);assert.equal(JSON.stringify(res.body).includes('example-customer@example.invalid'),false);
  const included=response();await handler(req({includeInternal:'true'}),included);assert.equal(included.body.summary.searches,2);assert.equal(included.body.customers.some(customer=>customer.id==='other-admin'),true);
  assert.equal(JSON.stringify(included.body).includes('DanielJoffeInfo@gmail.com'),false);
});
test('overview responses omit every customer timeline and bound lists without changing aggregate totals',async()=>{
  const tables=fixture();for(let index=0;index<1000;index++){const id=`customer-${index}`;tables.customers.push({id,name:`Example customer ${index}`,product_categories:['Paint']});tables.shopping_events.push(event('catalogue_viewed',1,{event_id:`visit-${index}`,customer_id:id,session_id:`session-${index}`}));tables.shopping_events.push(event('search_results_viewed',2,{event_id:`search-${index}`,customer_id:id,session_id:`session-${index}`,search_term:`example search ${index}`,results_count:0}));}
  const {handler}=setup({tables});const res=response();await handler(req(),res);
  assert.equal(res.body.summary.recordedVisits,1000);assert.equal(res.body.summary.searches,1000);assert.equal(res.body.customers.length,200);assert.equal(res.body.terms.length,100);assert.equal(res.body.quality.responseLimits.customers.total,1000);assert.equal(res.body.quality.responseLimits.customers.truncated,true);
  assert.ok(res.body.customers.every(customer=>!('timeline' in customer)&&customer.detailsAvailable));assert.equal('overview' in res.body,false);assert.ok(Buffer.byteLength(JSON.stringify(res.body))<500000);
});
test('customer detail response returns only the requested UUID and requires the same admin boundary',async()=>{
  const id='00000000-0000-4000-8000-000000000123';const other='00000000-0000-4000-8000-000000000456';const tables=fixture();tables.customers=[{id,name:'Requested example'},{id:other,name:'Other example'}];tables.shopping_events=[event('product_viewed',1,{customer_id:id,product_id:'PAINT'}),event('product_viewed',2,{customer_id:other,product_id:'BOOK'})];
  const {handler}=setup({tables});const res=response();await handler(req({customerId:id}),res);assert.equal(res.body.customer.id,id);assert.equal(res.body.customer.timeline.length,1);assert.equal('customers' in res.body,false);assert.equal(JSON.stringify(res.body).includes('Other example'),false);
  const denied=setup({admin:false,tables});const denial=response();await denied.handler(req({customerId:id}),denial);assert.equal(denial.statusCode,401);assert.equal(denied.calls.length,0);
  const invalid=response();await handler(req({customerId:'bogus'}),invalid);assert.equal(invalid.statusCode,400);
});
test('bounded structured lookup discovers profiles outside the overview and does not interpolate an OR filter',async()=>{
  const id='00000000-0000-4000-8000-000000000777';const operations=[];const row={id,name:'Outside overview',business_name:'Example supplies',email:'private@example.invalid',product_categories:['Paint']};
  const client={from(table){assert.equal(table,'customers');return {select(columns){operations.push(['select',columns]);return this;},ilike(column,pattern){operations.push(['ilike',column,pattern]);return this;},order(){return this;},async limit(limit){operations.push(['limit',limit]);return {data:[row]};}};}};
  const {handler}=setup({client});const res=response();await handler(req({customerSearch:'Outside_%'}),res);
  assert.equal(res.statusCode,200);assert.equal(res.body.customerMatches.length,1);assert.equal(res.body.customerMatches[0].id,id);assert.equal(res.body.customerMatches[0].counts.searches,null);assert.equal(JSON.stringify(res.body).includes('private@example.invalid'),false);
  assert.deepEqual(operations.filter(operation=>operation[0]==='ilike').map(operation=>operation.slice(1)),[['name','%Outside\\_\\%%'],['business_name','%Outside\\_\\%%']]);assert.equal(operations.filter(operation=>operation[0]==='limit').length,2);assert.ok(operations.filter(operation=>operation[0]==='limit').every(operation=>operation[1]===50));
  const denied=setup({client,admin:false});const denial=response();await denied.handler(req({customerSearch:'Outside'}),denial);assert.equal(denial.statusCode,401);assert.equal(denied.calls.length,0);
});
test('selected detail source failures do not become zero customer activity',async()=>{
  const id='00000000-0000-4000-8000-000000000123';const tables=fixture();tables.customers=[{id,name:'Example customer'}];
  const {handler}=setup({tables,statuses:{shopping_events:{available:false,error:'read_failed'}}});const res=response();await handler(req({customerId:id}),res);
  assert.equal(res.body.customer.counts.searches,null);assert.equal(res.body.customer.counts.orders,null);assert.equal(res.body.customer.dataCoverage.available,false);
});

test('overview comparison reads only two prior sources; evidence and details avoid prior reads',async()=>{
 const calls=[];const reader=async(_client,definition,scope)=>{calls.push({table:definition.table,scope});return {rows:[],status:{available:true,error:null,truncated:false}}};const {handler}=setup({reader});const overview=response();await handler(req({days:'7',source:'instore'}),overview);assert.equal(overview.statusCode,200);assert.equal(calls.length,10);const prior=calls.filter(call=>call.scope.until===overview.body.scope.since);assert.deepEqual(prior.map(call=>call.table).sort(),['orders','shopping_events']);assert.equal(overview.body.comparison.previous.until,overview.body.scope.since);assert.equal(prior.every(call=>call.scope.source==='instore'),true);
 calls.length=0;const evidence=response();await handler(req({evidenceType:'term',evidenceValue:'paint'}),evidence);assert.equal(evidence.statusCode,200);assert.equal(calls.length,3);assert.equal(evidence.body.comparison,undefined);assert.equal(evidence.body.evidence.counts.searches,0);
});
test('evidence endpoint retains admin boundary, validates mode and exposes no registration emails',async()=>{
 let reads=0;const blocked=setup({admin:false,reader:async()=>{reads++}});const denied=response();await blocked.handler(req({evidenceType:'product',evidenceValue:'P1'}),denied);assert.equal(denied.statusCode,401);assert.equal(reads,0);
 const invalid=setup();const bad=response();await invalid.handler(req({evidenceType:'department',evidenceValue:'x',customerSearch:'shop'}),bad);assert.equal(bad.statusCode,400);assert.equal(invalid.calls.length,0);
 const tables=fixture();tables.customers=[{id:'customer',name:'Sample',email:'secret@example.invalid'}];tables.shopping_events=[event('product_viewed',1,{product_id:'P1'})];const allowed=setup({tables});const result=response();await allowed.handler(req({evidenceType:'product',evidenceValue:'P1',evidenceSource:'main'}),result);assert.equal(result.body.evidence.counts.productViews,1);assert.equal(JSON.stringify(result.body).includes('secret@example.invalid'),false);assert.equal(JSON.stringify(result.body).includes(ENV.SUPABASE_SERVICE_ROLE_KEY),false);
});

test('tracking start is additive overview metadata independent of date/source/internal filters',async()=>{
 let starts=0;const first='2026-10-01T22:00:00Z';const {handler}=setup({startReader:async()=>{starts++;return {firstProductionEventAt:first,available:true,error:null,meaning:'First retained production activity, including internal activity.'}}});
 for(const query of [{days:'7',source:'main'},{days:'90',source:'instore',includeInternal:'true'}]){const res=response();await handler(req(query),res);assert.equal(res.statusCode,200);assert.equal(res.body.trackingStart.firstProductionEventAt,first);assert.equal(res.body.summary.recordedVisits,0);}
 assert.equal(starts,2);
 for(const query of [{customerId:'00000000-0000-0000-0000-000000000001'},{evidenceType:'term',evidenceValue:'paint'}]){await handler(req(query),response());}assert.equal(starts,2);
});
test('tracking metadata is guarded and failure remains explicit without inventing a start date',async()=>{
 let starts=0;const denied=setup({admin:false,startReader:async()=>{starts++;}});const blocked=response();await denied.handler(req(),blocked);assert.equal(blocked.statusCode,401);assert.equal(starts,0);
 const unavailable=setup({startReader:async()=>({firstProductionEventAt:null,available:false,error:'read_failed'})});const res=response();await unavailable.handler(req(),res);assert.equal(res.statusCode,200);assert.equal(res.body.trackingStart.available,false);assert.equal(res.body.trackingStart.firstProductionEventAt,null);assert.equal(res.body.trackingStart.error,'read_failed');
});

test('overview exposes earlier searches and saved orders separately from a newly empty customer tracking stream',async()=>{
 const tables=fixture();tables.customers=[{id:'customer',name:'Sample customer'},{id:'admin',role:'admin'}];tables.shopping_events=[event('catalogue_viewed',1,{customer_id:'admin'})];
 tables.search_analytics=[{id:'legacy-customer',customer_id:'customer',search_term:'paint',created_at:at(2)},{id:'legacy-admin',customer_id:'admin',search_term:'test',created_at:at(3)}];
 tables.orders=[{id:'saved-submitted',customer_id:'customer',status:'submitted',created_at:at(4)},{id:'saved-draft',customer_id:'customer',status:'draft',created_at:at(5)},{id:'staff-order',customer_id:'admin',status:'submitted',created_at:at(6)}];
 const {handler}=setup({tables});const res=response();await handler(req(),res);assert.equal(res.statusCode,200);assert.equal(res.body.summary.recordedVisits,0);assert.equal(res.body.summary.verifiedOrders,0);assert.equal(res.body.historicalSummary.searches.count,1);assert.equal(res.body.historicalSummary.searches.status,'available');assert.equal(res.body.historicalSummary.actualOrders.count,2);assert.equal(res.body.historicalSummary.actualOrders.source,'All catalogues');assert.equal(res.body.summary.actualOrders,1);
 const filtered=response();await handler(req({source:'instore'}),filtered);assert.equal(filtered.body.historicalSummary.searches.count,null);assert.equal(filtered.body.historicalSummary.searches.status,'source_not_recorded');assert.equal(filtered.body.historicalSummary.actualOrders.count,2);
 const included=response();await handler(req({includeInternal:'true'}),included);assert.equal(included.body.historicalSummary.searches.count,2);assert.equal(included.body.historicalSummary.actualOrders.count,3);
});
test('historical read failures and row caps remain distinct from no customer activity',async()=>{
 const tables=fixture();tables.search_analytics=[{id:'legacy',customer_id:'customer',search_term:'paint',created_at:at(1)}];
 const capped=setup({tables,statuses:{search_analytics:{available:true,truncated:true,error:'row_limit'}}});const partial=response();await capped.handler(req(),partial);assert.equal(partial.body.historicalSummary.searches.count,1);assert.equal(partial.body.historicalSummary.searches.status,'partial');
 const failed=setup({tables,statuses:{search_analytics:{available:false,truncated:false,error:'read_failed'}}});const unavailable=response();await failed.handler(req(),unavailable);assert.equal(unavailable.body.historicalSummary.searches.count,null);assert.equal(unavailable.body.historicalSummary.searches.status,'unavailable');assert.equal(unavailable.body.summary.searches,0);
});

test('database aggregates skip all four raw history tables in overview without blending new metrics',async()=>{
 const reads=[];let historyCalls=0;const historicalSummary=Object.fromEntries(['presenceRecords','searches','journeys','events','actualOrders'].map(key=>[key,{count:123,status:'available',label:key,source:'Catalogue not recorded',reason:null}]));
 const historyReader=async()=>{historyCalls++;return {available:true,historicalSummary,historicalSearch:{status:'complete',searches:123,noResults:10,unknownResultsCount:3,daily:[],terms:[],noResultTerms:[],limitedTerms:false,limitedNoResultTerms:false}}};
 const reader=async(_client,definition,scope,options)=>{reads.push({table:definition.table,scope,options});return {rows:[],status:{available:true,truncated:false}}};
 const {handler}=setup({reader,historyReader,healthReader:async()=>({status:'available',lastProductionEventAt:'2026-10-02T10:00:00Z'})});const res=response();await handler(req(),res);
 assert.equal(res.statusCode,200);assert.equal(historyCalls,1);assert.equal(reads.length,6);assert.ok(reads.every(row=>!['customer_visits','search_analytics','customer_journey_events','analytics_events'].includes(row.table)));assert.equal(res.body.summary.searches,0);assert.equal(res.body.historicalSearch.searches,123);assert.equal(res.body.quality.legacyCounts.searches,123);assert.equal(res.body.quality.sources.searches.aggregated,true);assert.equal(res.body.trackingHealth.lastProductionEventAt,'2026-10-02T10:00:00Z');assert.equal(res.body.actions.some(row=>row.id==='coverage'),false);
});

test('missing aggregate uses explicit bounded fallback; auth, evidence, details and lookup never call it',async()=>{
 let histories=0;const reads=[];const historyReader=async()=>{histories++;return {available:false,error:'not_installed'}};
 const reader=async(_client,definition,_scope,options)=>{reads.push([definition.table,options]);return {rows:[],status:{available:true,truncated:false}}};
 const {handler}=setup({reader,historyReader});const res=response();await handler(req(),res);assert.equal(res.body.historicalSearch.status,'complete');assert.equal(histories,1);assert.deepEqual(reads.filter(([,options])=>options).map(([,options])=>options.maxRows),[5000,5000,5000,5000]);
 for(const query of [{customerId:'00000000-0000-4000-8000-000000000001'},{evidenceType:'term',evidenceValue:'paint'}])await handler(req(query),response());assert.equal(histories,1);
 const denied=setup({admin:false,historyReader});await denied.handler(req(),response());assert.equal(histories,1);
});
