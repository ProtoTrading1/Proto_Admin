import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHistoricalAggregate,readHistoricalAggregate,buildHistoricalSearchFallback,applyHistoricalCoverage} from '../lib/historical-analytics.mjs';
import {buildShoppingAnalytics} from '../lib/shopping-analytics.mjs';
const scope={source:'all',since:'2026-10-01T00:00:00Z',until:'2026-10-03T00:00:00Z',includeInternal:false,excludedCustomerIds:['00000000-0000-4000-8000-000000000001','not-uuid'],excludedCustomerEmails:['staff@example.invalid']};
function raw(){return {historicalSummary:Object.fromEntries(['presenceRecords','searches','journeys','events','actualOrders'].map(key=>[key,{count:key==='searches'?3:12,status:'complete'}])),historicalSearch:{status:'complete',count:3,noResults:1,unknownResults:1,daily:[{date:'2026-10-01',searches:3,noResults:1,unknownResults:1}],terms:[{term:'paint',searches:3,noResults:1,unknownResults:1}],termsLimit:{truncated:false},privateEmail:'private@example.invalid'}};}
test('RPC only receives structured exclusions/window; raw private fields never escape',async()=>{
 let args; const result=await readHistoricalAggregate({rpc:async(...value)=>{args=value;return {data:raw()}}},scope);
 assert.equal(args[0],'proto_shopping_history_summary');assert.deepEqual(args[1].p_excluded_customer_ids,[scope.excludedCustomerIds[0]]);assert.deepEqual(args[1].p_excluded_customer_emails,scope.excludedCustomerEmails);assert.equal(args[1].p_until,scope.until);assert.equal(result.historicalSearch.searches,3);assert.equal(result.historicalSearch.unknownResultsCount,1);assert.equal(JSON.stringify(result).includes('private@example'),false);
});
test('catalogue unknown prevents historical catalogue counts; saved orders explicitly remain all-source',()=>{
 const result=normalizeHistoricalAggregate(raw(),{...scope,source:'instore'});assert.equal(result.historicalSearch.status,'unavailable');assert.equal(result.historicalSearch.searches,null);assert.deepEqual(result.historicalSearch.daily,[]);assert.equal(result.historicalSummary.searches.status,'source_not_recorded');assert.equal(result.historicalSummary.actualOrders.count,12);
});
test('missing, failed, malformed or thrown RPC cannot masquerade as a valid empty aggregate',async()=>{
 for(const result of [{error:{code:'PGRST202',message:'private'}},{error:{code:'42501',message:'private'}},{data:{}},{data:{...raw(),historicalSearch:{...raw().historicalSearch,count:-1}}}]){const read=await readHistoricalAggregate({rpc:async()=>result},scope);assert.equal(read.available,false);assert.equal(JSON.stringify(read).includes('private'),false);}
 assert.equal((await readHistoricalAggregate({rpc:async()=>{throw Error('private')}},scope)).available,false);
});
test('fallback deduplicates record IDs, excludes staff, respects exclusive end, separates unknown outcomes and UTC day',()=>{
 const rows=[{id:'a',customer_id:'customer',created_at:'2026-10-01T01:00:00Z',search_term:' PAINT ',results_found:0},{id:'a',customer_id:'customer',created_at:'2026-10-01T01:00:00Z',search_term:'paint',results_found:0},{id:'b',customer_id:'customer',created_at:'2026-10-02T02:00:00Z',search_term:'paint',results_found:null},{id:'c',customer_id:'staff',created_at:'2026-10-02T02:00:00Z',search_term:'staff',results_found:0},{id:'d',customer_id:'customer',created_at:scope.until,search_term:'outside',results_found:0}];
 const input={searches:rows,customers:[{id:'staff',role:'admin'},{id:'customer'}],statuses:{searches:{available:true,truncated:true}}};const shaped=buildShoppingAnalytics(input,scope);const value=buildHistoricalSearchFallback(input,scope,shaped);
 assert.equal(value.status,'partial');assert.equal(value.searches,2);assert.equal(value.noResults,1);assert.equal(value.unknownResultsCount,1);assert.deepEqual(value.daily.map(row=>row.date),['2026-10-01','2026-10-02']);assert.equal(value.terms.length,1);assert.equal(value.terms[0].term,'paint');
});
test('aggregate coverage keeps raw orders partial, removes fake missing legacy actions and does not invent session matching',()=>{
 const shaped=buildShoppingAnalytics({events:[],orders:[],customers:[],products:[],statuses:{orders:{available:true,truncated:true}}},scope);const aggregate=normalizeHistoricalAggregate(raw(),scope);applyHistoricalCoverage(shaped,aggregate);
 assert.equal(shaped.quality.sources.orders.truncated,true);assert.equal(shaped.quality.sources.searches.aggregated,true);assert.equal(shaped.quality.legacyCounts.searches,3);assert.equal(shaped.quality.matchedPresenceVisits,null);assert.deepEqual(shaped.quality.missingSources,[]);assert.equal(shaped.actions.some(action=>action.id==='coverage'),false);assert.equal(shaped.actions.some(action=>action.id==='partial-coverage'),true);
});

test('no-result terms are ranked independently so a rare failed term is not hidden by the popular-term limit',()=>{
 const searches=[];for(let i=0;i<110;i++)for(let j=0;j<2;j++)searches.push({id:`${i}-${j}`,created_at:'2026-10-01T01:00:00Z',search_term:`popular ${i}`,results_found:4});
 searches.push({id:'rare-failed',created_at:'2026-10-01T01:00:00Z',search_term:'rare failed',results_found:0});
 const input={searches,customers:[]};const shaped=buildShoppingAnalytics(input,scope);const value=buildHistoricalSearchFallback(input,scope,shaped);
 assert.equal(value.limitedTerms,true);assert.equal(value.terms.some(row=>row.term==='rare failed'),false);assert.equal(value.noResultTerms[0].term,'rare failed');assert.equal(value.limitedNoResultTerms,false);
 const rpc=raw();rpc.historicalSearch.noResultTerms=[{term:'rare failed',searches:1,noResults:1,unknownResults:0}];rpc.historicalSearch.noResultTermsLimit={truncated:true};const normalized=normalizeHistoricalAggregate(rpc,scope);assert.equal(normalized.historicalSearch.noResultTerms[0].unknownResultsCount,0);assert.equal(normalized.historicalSearch.limitedNoResultTerms,true);
});

test('malformed aggregates cannot claim complete totals with inconsistent days, duplicate terms or invalid array shapes',()=>{
 for(const mutate of [value=>{value.historicalSearch.daily={}},value=>{value.historicalSearch.noResultTerms='bad'},value=>{value.historicalSearch.daily[0].searches=4},value=>{value.historicalSearch.daily[0].date='2026-02-30'},value=>{value.historicalSearch.daily[0].date='2025-10-01'},value=>{value.historicalSearch.terms.push({...value.historicalSearch.terms[0]})},value=>{value.historicalSummary.searches.count=4}]){const value=raw();mutate(value);assert.equal(normalizeHistoricalAggregate(value,scope),null);}
});

test('bounded term rankings may omit terms but cannot exceed global counts or contain nonfailing terms',()=>{
 for(const mutate of [value=>{value.historicalSearch.terms[0].searches=999},value=>{value.historicalSearch.terms[0].noResults=2},value=>{value.historicalSearch.terms[0].unknownResults=2},value=>{value.historicalSearch.noResultTerms=[{term:'bad',searches:999,noResults:999,unknownResults:0}]},value=>{value.historicalSearch.noResultTerms=[{term:'not failing',searches:1,noResults:0,unknownResults:0}]}]){const value=raw();mutate(value);assert.equal(normalizeHistoricalAggregate(value,scope),null);}
 const bounded=raw();bounded.historicalSearch.terms=[{term:'subset',searches:1,noResults:0,unknownResults:0}];bounded.historicalSearch.termsLimit.truncated=true;bounded.historicalSearch.noResultTerms=[{term:'failed subset',searches:1,noResults:1,unknownResults:0}];assert.equal(normalizeHistoricalAggregate(bounded,scope).historicalSearch.status,'complete');
});

