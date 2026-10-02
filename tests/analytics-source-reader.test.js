import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_DEFINITIONS, parseAnalyticsScope, previousAnalyticsScope, readAnalyticsSource } from '../lib/analytics-source-reader.mjs';

test('range and source are validated and upper time bound excludes future records', () => {
  const scope = parseAnalyticsScope({ days: '7', source: 'instore' }, new Date('2026-10-02T10:00:00Z'));
  assert.equal(scope.since, '2026-09-25T10:00:00.000Z');
  assert.equal(scope.until, '2026-10-02T10:00:00.000Z');
  assert.equal(scope.includeInternal, false);
  assert.throws(() => parseAnalyticsScope({ days: 365 }));
  assert.throws(() => parseAnalyticsScope({ source: 'arbitrary' }));
});
function mockClient(batches) {
  let calls = 0;
  const query = { select() { return this; }, order() { return this; }, gte() { return this; }, lt() { return this; },
    async range() { return batches[calls++]; } };
  return { from() { return query; }, get calls() { return calls; } };
}
const definition = { table: 'shopping_events', columns: '*', timestamp: 'created_at' };
test('multiple pages are read rather than silently stopped at first default page', async () => {
  const client = mockClient([{ data: [{ id: 1 }, { id: 2 }] }, { data: [{ id: 3 }] }]);
  const result = await readAnalyticsSource(client, definition, parseAnalyticsScope(), { pageSize: 2, maxRows: 10 });
  assert.equal(result.rows.length, 3);
  assert.equal(result.status.truncated, false);
  assert.equal(client.calls, 2);
});
test('read errors cannot masquerade as valid zero activity', async () => {
  const result = await readAnalyticsSource(mockClient([{ error: { code: '42501' } }]), definition, parseAnalyticsScope());
  assert.equal(result.status.available, false);
  assert.equal(result.status.error, 'read_failed');
});
test('new table absent and bounded reads explicitly report coverage', async () => {
  const absent = await readAnalyticsSource(mockClient([{ error: { code: '42P01' } }]), definition, parseAnalyticsScope());
  assert.equal(absent.status.error, 'not_installed');
  const capped = await readAnalyticsSource(mockClient([{ data: [{ id: 1 }, { id: 2 }] }]), definition, parseAnalyticsScope(), { pageSize: 2, maxRows: 2 });
  assert.equal(capped.status.truncated, true);
});
test('shopping event reads use an explicit safe column list and the actual event primary key', async () => {
  const orders=[]; let selected;
  const query={select(columns){selected=columns;return this;},order(column){orders.push(column);return this;},gte(){return this;},lt(){return this;},async range(){return {data:[]};}};
  await readAnalyticsSource({from:()=>query},SOURCE_DEFINITIONS.events,parseAnalyticsScope());
  assert.equal(selected.includes('*'),false);assert.ok(selected.includes('event_id'));assert.ok(selected.includes('environment'));assert.ok(selected.includes('is_internal'));
  assert.deepEqual(orders,['created_at','event_id']);assert.equal(selected.split(',').includes('id'),false);
});
test('customer detail scope is UUID validated and pushed down to source reads',async()=>{
  const customerId='00000000-0000-4000-8000-000000000123';const scope=parseAnalyticsScope({customerId});
  assert.throws(()=>parseAnalyticsScope({customerId:'not-an-id'}));assert.throws(()=>parseAnalyticsScope({customerId,customerSearch:'example'}));
  const filters=[];const query={select(){return this;},order(){return this;},gte(){return this;},lt(){return this;},eq(column,value){filters.push([column,value]);return this;},async range(){return {data:[]};}};
  for(const definition of Object.values(SOURCE_DEFINITIONS))await readAnalyticsSource({from:()=>query},definition,scope);
  assert.equal(filters.filter(([column])=>column==='customer_id').length,6);assert.ok(filters.some(([column,value])=>column==='id'&&value===customerId));assert.equal(filters.length,7);
});

test('previous windows have equal duration and adjacent exclusive boundaries for every supported range',()=>{
  for(const days of [7,30,90]){const current=parseAnalyticsScope({days,source:'instore',includeInternal:'true'},new Date('2026-10-02T10:00:00Z'));const prior=previousAnalyticsScope(current);assert.equal(prior.until,current.since);assert.equal(Date.parse(prior.until)-Date.parse(prior.since),days*86400000);assert.equal(prior.source,'instore');assert.equal(prior.includeInternal,true);}
});
test('evidence validation rejects incompatible modes and product filters use structured equality',async()=>{
  for(const query of [{evidenceType:'sql',evidenceValue:'x'},{evidenceType:'term',evidenceValue:''},{evidenceType:'term',evidenceValue:'x',customerSearch:'shop'},{evidenceType:'product',evidenceValue:'x',source:'main',evidenceSource:'instore'}])assert.throws(()=>parseAnalyticsScope(query));
  const calls=[];const query={select(){return this},order(){return this},eq(...args){calls.push(args);return this},gte(){return this},lt(){return this},async range(){return {data:[],error:null}}};
  await readAnalyticsSource({from(){return query}},SOURCE_DEFINITIONS.events,parseAnalyticsScope({evidenceType:'product',evidenceValue:'SKU,or(injection)',evidenceSource:'instore'}));assert.deepEqual(calls,[['product_id','SKU,or(injection)'],['source','instore']]);
});

test('evidence keys use the persisted type-specific lengths rather than truncating valid searches',()=>{
 assert.equal(parseAnalyticsScope({evidenceType:'term',evidenceValue:'x'.repeat(200)}).evidenceValue.length,200);
 for(const [type,max] of [['term',200],['product',128],['department',160]]){
   assert.equal(parseAnalyticsScope({evidenceType:type,evidenceValue:'x'.repeat(max)}).evidenceValue.length,max);
   assert.throws(()=>parseAnalyticsScope({evidenceType:type,evidenceValue:'x'.repeat(max+1)}));
 }
});
