// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShoppingAnalyticsDashboard, { evidenceLabel } from '../src/components/ShoppingAnalyticsDashboard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root; let container;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
const payload = () => ({ summary: { recordedVisits: 4, searchVisits: 2, searchUsageRate: .5, productViews: 3, basketAdds: 1, verifiedOrders: 0 }, trend: [], funnel: [], terms: [], products: [], departments: [], popup: {}, quality: {}, customers: [] });
async function render(props) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); await act(async () => root.render(<ShoppingAnalyticsDashboard {...props}/>)); }
async function click(element) { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }

describe('shopping analytics UI', () => {
  it('separates historical search trends and unknown outcomes from new journey measures',async()=>{
    const data=payload();data.historicalSearch={status:'complete',searches:25,noResults:4,unknownResultsCount:7,daily:[{date:'2026-09-29',searches:20,noResults:3,unknownResultsCount:5},{date:'2026-10-01',searches:5,noResults:1,unknownResultsCount:2}],terms:[{term:'craft paint',searches:18,noResults:0,unknownResultsCount:7},{term:'rare clip',searches:7,noResults:4,unknownResultsCount:0}],limitedTerms:false};
    await render({loader:async()=>data});const panel=container.querySelector('.sa2-historical-search');expect(panel.textContent).toContain('separate from the new linked shopping journey');expect(panel.querySelector('svg[role="img"]').getAttribute('aria-label')).toContain('historical search');expect(panel.querySelectorAll('.sa2-historical-kpis dd')[2].textContent).toBe('7');expect(panel.querySelectorAll('tbody tr')).toHaveLength(4);expect(panel.querySelector('.sa2-historical-rankings section:last-child').textContent).toContain('rare clip');expect(panel.querySelector('.sa2-historical-rankings section:last-child').textContent).not.toContain('craft paint');expect(panel.textContent).toContain('never treated as no results');expect(container.querySelector('.sa2-summary').textContent).not.toContain('25');
  });
  it('marks partial historical charts and bounded terms without presenting complete rankings',async()=>{
    const data=payload();data.historicalSearch={status:'partial',searches:10,noResults:2,unknownResultsCount:1,daily:[],terms:[{term:'paint',searches:10,noResults:2,unknownResultsCount:1}],limitedTerms:true,reason:'Returned subset only'};
    await render({loader:async()=>data});const panel=container.querySelector('.sa2-historical-search');expect(panel.textContent).toContain('not complete totals');expect(panel.textContent).toContain('At least 10');expect(panel.textContent).toContain('Returned subset only');expect(panel.textContent).toContain('omitted terms may also have no results');expect(panel.textContent).toContain('No daily historical search records returned');
  });
  it('ranks no-result terms independently so failures outside popular searches remain visible',async()=>{
    const data=payload();data.historicalSearch={status:'complete',searches:105,noResults:5,unknownResultsCount:0,daily:[],terms:[{term:'popular paint',searches:100,noResults:0,unknownResultsCount:0}],noResultTerms:[{term:'rare missing clips',searches:5,noResults:5,unknownResultsCount:0}],limitedTerms:true,limitedNoResultTerms:true};await render({loader:async()=>data});const rankings=container.querySelector('.sa2-historical-rankings');const popular=rankings.querySelector('section:first-child'),failures=rankings.querySelector('section:last-child');expect(popular.textContent).toContain('popular paint');expect(popular.textContent).not.toContain('rare missing clips');expect(failures.textContent).toContain('rare missing clips');expect(failures.textContent).toContain('Ranked independently');expect(failures.textContent).toContain('additional failing terms are omitted');expect(popular.textContent).toContain('less frequent terms are omitted');
  });
  it('uses explicitly labelled popular-term fallback only when independent historical failures are absent',async()=>{
    const data=payload();data.historicalSearch={status:'complete',searches:5,noResults:1,unknownResultsCount:0,terms:[{term:'paint',searches:5,noResults:1,unknownResultsCount:0}],noResultTerms:[],daily:[]};await render({loader:async()=>data});let failures=container.querySelector('.sa2-historical-rankings section:last-child');expect(failures.textContent).not.toContain('paint');expect(failures.textContent).toContain('No no-result terms returned');await act(async()=>{delete data.historicalSearch.noResultTerms;});await click([...container.querySelectorAll('button')].find(button=>button.textContent==='Refresh'));failures=container.querySelector('.sa2-historical-rankings section:last-child');expect(failures.textContent).toContain('paint');expect(failures.textContent).toContain('no independent no-result ranking');expect(failures.textContent).toContain('Only failures among the returned popular terms');
  });
  it('explains unavailable historical analysis and accepts older API responses',async()=>{
    const data=payload();data.historicalSearch={status:'unavailable',reason:'Historical search read failed',searches:null};await render({loader:async()=>data});const panel=container.querySelector('.sa2-historical-search');expect(panel.textContent).toContain('Historical search read failed');expect(panel.querySelector('.sa2-historical-kpis')).toBeNull();expect(container.querySelector('.sa2-tracking-health').textContent).toContain('unavailable in this response');
  });
  it('does not show combined historical searches for catalogue filters even if payload contains totals',async()=>{
    const data=payload();data.historicalSearch={status:'complete',searches:999,noResults:1,unknownResultsCount:0,daily:[],terms:[]};const loader=vi.fn(async()=>data);await render({loader});await act(async()=>{const select=container.querySelectorAll('select')[1];select.value='main';select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(loader.mock.calls.at(-1)[0].source).toBe('main');const panel=container.querySelector('.sa2-historical-search');expect(panel.textContent).toContain('Select All sources');expect(panel.textContent).not.toContain('999');expect(panel.querySelector('.sa2-historical-kpis')).toBeNull();
  });
  it('reports retained production activity with read gaps without claiming complete tracking',async()=>{
    const data=payload();data.trackingHealth={status:'available',lastProductionEventAt:'2026-10-02T02:00:00Z',description:'Timestamp-only production read'};data.quality={sources:{events:{available:true},searches:{available:false},legacyEvents:{available:true,truncated:true}}};await render({loader:async()=>data});const panel=container.querySelector('.sa2-tracking-health');expect(panel.textContent).toContain('Latest retained production event:');expect(panel.textContent).toContain('including internal activity');expect(panel.textContent).toContain('does not establish complete tracking');expect(panel.textContent).toContain('searches: Unavailable');expect(panel.textContent).toContain('legacyEvents: Limited records returned');expect(panel.textContent).not.toMatch(/healthy|working correctly|pipeline works/);
  });
  it('distinguishes no retained events from an unavailable latest-event read',async()=>{
    const data=payload();data.trackingHealth={status:'available',lastProductionEventAt:null};await render({loader:async()=>data});expect(container.querySelector('.sa2-tracking-health').textContent).toContain('No production shopping events are retained');expect(container.querySelector('.sa2-tracking-health').textContent).not.toContain('Latest retained production event:');
  });
  it('explains zero new tracking alongside positive earlier records without inventing a tracking start',async()=>{
    const data=payload();data.summary.recordedVisits=0;data.historicalSummary={searches:{count:18,status:'available',label:'Earlier search records',source:'Catalogue not recorded'},presenceRecords:{count:6,status:'available',label:'Presence records',source:'Catalogue not recorded'},actualOrders:{count:4,status:'available',label:'Saved order records',source:'All catalogues'}};
    await render({loader:async()=>data});const context=container.querySelector('.sa2-tracking-context');expect(context.textContent).toContain('first recorded production activity is unavailable');expect(context.textContent).toContain('existing records or saved orders are available');expect(context.textContent).toContain('18');expect(context.textContent).toContain('Saved order records');expect(context.textContent).toContain('all catalogues and statuses');expect(context.textContent).toContain('not unique customer visits');expect(container.textContent).toContain('Existing customer records may exist');
  });
  it('labels the first retained production event independently of selected filters without calling it activation',async()=>{
    const data=payload();data.trackingStart={firstProductionEventAt:'2026-09-01T12:00:00Z',available:true};await render({loader:async()=>data});const context=container.querySelector('.sa2-tracking-context');expect(context.textContent).toContain('First recorded production activity:');expect(context.textContent).toContain('including internal activity');expect(context.textContent).toContain('across all periods and catalogues');expect(context.textContent).toContain('not a deployment date');expect(context.textContent).toContain('Historical source counts are not supplied');
  });
  it('shows historical catalogue gaps, partial counts and missing sources as distinct states',async()=>{
    const data=payload();data.historicalSummary={searches:{count:null,status:'source_not_recorded',label:'Earlier search records',source:'Catalogue not recorded',reason:'Catalogue breakdown unavailable'},presenceRecords:{count:null,status:'unavailable',label:'Presence records'},actualOrders:{count:3,status:'partial',label:'Saved order records',source:'All catalogues',reason:'Retrieved subset only'}};await render({loader:async()=>data});const context=container.querySelector('.sa2-history-summary');expect(context.textContent).toContain('Unavailable');expect(context.textContent).toContain('At least 3');expect(context.textContent).toContain('Retrieved subset only');expect(context.textContent).not.toContain('null');
  });
  it('starts with live data and internal activity excluded', async () => {
    const loader = vi.fn(async () => payload());
    await render({ loader, sampleData: payload() });
    expect(loader.mock.calls[0][0]).toEqual({ days: 30, source: 'all', includeInternal: false });
    expect(container.textContent).toContain('50.0%');
    expect(container.textContent).not.toContain('Sample data —');
  });
  it('labels sample data only after an explicit choice', async () => {
    await render({ loader: async () => payload(), sampleData: payload() });
    const input = [...container.querySelectorAll('input')].find(element => element.parentElement.textContent.includes('Show sample data'));
    await click(input);
    expect(container.textContent).toContain('Sample data — illustrative customers and activity, not live records.');
  });
  it('exposes missing tracking instead of false zero popup engagement', async () => {
    await render({ loader: async () => ({ ...payload(), summary: { recordedVisits: null, searchUsageRate: null }, quality: { sources: { events: { available: false } }, missingSources: ['events'] } }) });
    expect(container.textContent).toContain('events: data unavailable');
    expect(container.textContent).toContain('Search tip tracking is not available yet.');
    expect(container.textContent).toContain('—');
  });
  it('keeps registration interests distinct from observed activity and hides unverified suggestions', async () => {
    const data = payload(); data.customers = [{ id: 'sample-1', name: 'Sample customer', interests: { productCategories: ['Craft'], salesChannels: ['Retail'], supplyNeeds: ['Stationery'] }, observedCategories: ['Art'], timeline: [], counts: {}, recommendations: [{ sku: 'NO', name: 'Unverified suggestion', verified: false }] }];
    await render({ loader: async () => data });
    await click([...container.querySelectorAll('button')].find(button => button.textContent === 'View activity'));
    expect(container.textContent).toContain('Selected at registration'); expect(container.textContent).toContain('Observed in this period'); expect(container.textContent).toContain('Retail'); expect(container.textContent).not.toContain('Unverified suggestion');
  });
  it('reports errors without rendering empty metrics', async () => {
    await render({ loader: async () => { throw new Error('Sign in required'); } });
    expect(container.querySelector('[role="alert"]').textContent).toContain('Sign in required');
    expect(container.querySelector('.sa2-summary')).toBeNull();
  });
  it('formats evidence as clear counts instead of raw JSON', () => {
    expect(evidenceLabel({ searches: 18, noResults: 5, customers: 3 })).toBe('18 searches · 5 with no results · 3 customers');
  });
  it('opens product evidence from a ranked bar without claiming a sale', async () => {
    const data = payload(); data.products = [{ id: 'DEMO-PAINT', sku: 'DEMO-PAINT', name: 'Example paint', source: 'main', views: 8, basketAdds: 2, customers: 3 }];
    await render({ loader: async () => data });
    await click(container.querySelector('.sa2-rank-button'));
    expect(container.querySelector('.sa2-product-detail').textContent).toContain('8 product views · 2 basket additions · 3 customers');
    await click([...container.querySelectorAll('button')].find(button => button.textContent === 'Close product details'));
    expect(container.querySelector('.sa2-product-detail')).toBeNull();
  });
  it('shows partial-read coverage and unknown search outcomes alongside available counts', async () => {
    const data = payload(); data.quality = { sources: { events: { available: true, truncated: true } } }; data.terms = [{ term: 'example', searches: 5, noResults: 1, unknownResults: 2, clicks: 1, customers: 3 }];
    await render({ loader: async () => data });
    expect(container.textContent).toContain('Counts are incomplete; conversion rates are unavailable.');
    expect(container.textContent).toContain('Unknown result count');
  });
  it('reveals additional returned customer activity without claiming unlimited history', async () => {
    const data=payload();data.customers=[{id:'sample',name:'Example customer',counts:{},timelineTruncated:true,timeline:Array.from({length:75},(_,index)=>({at:'2026-10-02T10:00:00Z',type:'product_viewed',label:`Example activity ${index+1}`}))}];
    await render({loader:async()=>data});await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity'));
    expect(container.querySelectorAll('.sa2-timeline li')).toHaveLength(50);
    await click([...container.querySelectorAll('button')].find(button=>button.textContent==='Show more activity'));
    expect(container.querySelectorAll('.sa2-timeline li')).toHaveLength(75);expect(container.textContent).toContain('Showing 75 of 75 returned activities');expect(container.textContent).toContain('older recorded activity is omitted');
    expect([...container.querySelectorAll('button')].some(button=>button.textContent==='Show more activity')).toBe(false);
  });
  it('loads only the selected customer details and provides a retry after an error',async()=>{
    const data=payload();data.customers=[{id:'sample',name:'Example customer',detailsAvailable:true,counts:{}}];let attempts=0;
    const loader=vi.fn(async filters=>{if(!filters.customerId)return data;if(++attempts===1)throw new Error('Temporary detail failure');return {customer:{...data.customers[0],timeline:[{at:'2026-10-02T10:00:00Z',type:'product_viewed',label:'Selected example activity'}]}};});
    await render({loader});expect(loader).toHaveBeenCalledTimes(1);await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity'));expect(container.textContent).toContain('Temporary detail failure');
    await click([...container.querySelectorAll('button')].find(button=>button.textContent==='Retry customer activity'));expect(container.textContent).toContain('Selected example activity');expect(loader.mock.calls[1][0]).toEqual({days:30,source:'all',includeInternal:false,customerId:'sample'});
  });
  it('aborts selected detail when filters change and ignores the stale response',async()=>{
    const data=payload();data.customers=[{id:'sample',name:'Example customer',detailsAvailable:true,counts:{}}];let resolveDetail;let detailSignal;
    const loader=async(filters,options)=>{if(!filters.customerId)return data;detailSignal=options.signal;return new Promise(resolve=>{resolveDetail=resolve;});};
    await render({loader});await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity'));expect(container.textContent).toContain('Loading this customer');
    await act(async()=>{const select=container.querySelector('select');select.value='7';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(detailSignal.aborted).toBe(true);
    await act(async()=>resolveDetail({customer:{...data.customers[0],timeline:[{label:'Stale secret detail'}]}}));expect(container.textContent).not.toContain('Stale secret detail');
  });
  it('finds a registered customer beyond the bounded overview through server lookup',async()=>{
    const data=payload();data.quality={responseLimits:{customers:{total:1000,returned:200,truncated:true}}};let lookupFilters;
    const loader=async filters=>{if(filters.customerSearch){lookupFilters=filters;return {customerMatches:[{id:'outside',name:'Outside overview',counts:{searches:null},detailsAvailable:true}],lookup:{limited:false}};}return data;};
    await render({loader});await act(async()=>{const input=container.querySelector('input[type="search"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Outside');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>new Promise(resolve=>setTimeout(resolve,350)));
    expect(lookupFilters?.customerSearch).toBe('Outside');expect(container.textContent).toContain('Outside overview');expect(container.textContent).toContain('search all registered customers');
  });
  it('shows equal previous periods with neutral changes and unavailable history distinctly',async()=>{
    const data=payload();data.comparison={current:{since:'2026-09-25T00:00:00Z',until:'2026-10-02T00:00:00Z'},previous:{since:'2026-09-18T00:00:00Z',until:'2026-09-25T00:00:00Z'},metrics:{recordedVisits:{current:4,previous:2,absoluteDelta:2,relativeDelta:1,status:'comparable'},searchUsageRate:{current:.5,previous:.4,absoluteDelta:.1,status:'comparable'},verifiedOrders:{current:0,previous:null,status:'not_comparable',reason:'Order history unavailable'}},searchChanges:[{term:'paint',currentSearches:4,previousSearches:0,status:'new_recorded_activity'}]};
    await render({loader:async()=>data});expect(container.textContent).toContain('Previous equal period');expect(container.textContent).toContain('End dates are exclusive');expect(container.textContent).toContain('+2 recorded (+100%)');expect(container.textContent).toContain('+10 percentage points');expect(container.textContent).toContain('Order history unavailable');expect(container.textContent).toContain('percentage change unavailable');expect(container.textContent).not.toMatch(/improved|paid revenue|Infinity/);
  });
  it('loads term evidence, then links a UUID customer to lazy scoped activity without raw history downloads',async()=>{
    const id='00000000-0000-4000-8000-000000000123';const data=payload();data.terms=[{term:'paint',searches:4}];
    const loader=vi.fn(async filters=>filters.evidenceType?{evidence:{type:'term',value:'paint',counts:{searches:4},limited:true,customers:[{id,name:'Evidence customer'}],records:[{at:'2026-10-02T10:00:00Z',type:'search_results_viewed',label:'paint',catalogueSource:'main'}]}}:filters.customerId?{customer:{id,name:'Evidence customer',counts:{},timeline:[{at:'2026-10-02T10:00:00Z',type:'search_results_viewed',label:'paint',source:'shopping'}]}}:data);
    await render({loader});await click(container.querySelector('.sa2-rank-button'));expect(loader.mock.calls[1][0]).toEqual({days:30,source:'all',includeInternal:false,evidenceType:'term',evidenceValue:'paint'});expect(container.textContent).toContain('Supporting records were limited');
    await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity for Evidence customer'));expect(loader.mock.calls[2][0].customerId).toBe(id);expect(container.textContent).toContain('Activity for Evidence customer');expect(container.textContent).toContain('Recent searches');
  });
  it('ignores stale evidence after filters change and does not treat unavailable records as zero',async()=>{
    const data=payload();data.departments=[{name:'Craft',views:3}];let resolve;let signal;
    const loader=async(filters,options)=>{if(filters.evidenceType){signal=options.signal;return new Promise(done=>{resolve=done;});}return data;};
    await render({loader});await click(container.querySelector('.sa2-rank-button'));expect(container.textContent).toContain('Loading supporting records');await act(async()=>{const select=container.querySelector('select');select.value='7';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(signal.aborted).toBe(true);
    await act(async()=>resolve({evidence:{type:'department',value:'Craft',records:[{label:'STALE EVIDENCE'}]}}));expect(container.textContent).not.toContain('STALE EVIDENCE');
  });
  it('keeps sample evidence local and never turns sample customer identifiers into live requests',async()=>{
    const data=payload();data.terms=[{term:'Sample term',searches:3}];const loader=vi.fn(async()=>payload());await render({loader,sampleData:data});const sample=[...container.querySelectorAll('input')].find(input=>input.parentElement.textContent.includes('Show sample data'));await click(sample);await click(container.querySelector('.sa2-rank-button'));expect(container.textContent).toContain('No additional supporting sample records');expect(loader).toHaveBeenCalledTimes(1);
  });
  it('shows recent returned activity with stated interests separate and no complete-history claim',async()=>{
    const data=payload();data.customers=[{id:'sample',name:'Recent customer',interests:{productCategories:['Craft']},timeline:[{at:'2026-10-02T10:00:00Z',type:'search',label:'paint',source:'legacy-search'},{at:'2026-10-02T10:01:00Z',type:'product_viewed',label:'Olive paint',sku:'CP50',source:'shopping'},{at:'2026-10-02T10:02:00Z',type:'actual_order',label:'Order request 123',source:'actual-order'}]}];await render({loader:async()=>data});await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity'));expect(container.querySelector('.sa2-recent-grid').textContent).toContain('paint');expect(container.querySelector('.sa2-recent-grid').textContent).toContain('Order request 123');expect(container.textContent).toContain('not a complete lifetime history');expect(container.textContent).toContain('Selected at registration');
  });
  it('renders supplied fictional supporting evidence without any live evidence or customer request',async()=>{
    const data=payload();data.terms=[{term:'Fictional paint',searches:3}];const loader=vi.fn(async()=>payload());
    const sampleEvidence=vi.fn(async filters=>({evidence:{type:filters.evidenceType,value:filters.evidenceValue,counts:null,customers:[],records:[{at:'2026-10-02T10:00:00Z',type:'search_results_viewed',label:'FICTIONAL RECORD'}],coverage:{notes:['Fictional supporting records only.']}}}));
    await render({loader,sampleData:data,sampleEvidence});await click([...container.querySelectorAll('input')].find(input=>input.parentElement.textContent.includes('Show sample data')));await click(container.querySelector('.sa2-rank-button'));
    expect(sampleEvidence.mock.calls[0][0].evidenceValue).toBe('Fictional paint');expect(container.textContent).toContain('FICTIONAL RECORD');expect(container.textContent).toContain('Fictional supporting records only.');expect(loader).toHaveBeenCalledTimes(1);
  });
  it('prefers actual order records and deduplicates their references in recent order summaries',async()=>{
    const data=payload();data.customers=[{id:'sample',name:'Order customer',timeline:[{type:'order_submitted',orderId:'123',label:'Tracking submission 123'},{type:'actual_order',source:'actual-order',orderId:'123',label:'Actual order PT123'},{type:'actual_order',source:'actual-order',orderId:'123',label:'Duplicate PT123'}]}];
    await render({loader:async()=>data});await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity'));const recent=container.querySelector('.sa2-recent-grid').textContent;expect(recent).toContain('Actual order PT123');expect(recent).not.toContain('Tracking submission');expect(recent).not.toContain('Duplicate PT123');
  });
  it('reads backend source coverage for evidence without claiming an empty successful read',async()=>{
    const data=payload();data.terms=[{term:'paint',searches:4}];await render({loader:async filters=>filters.evidenceType?{evidence:{type:'term',value:'paint',counts:null,records:[],coverage:{events:{available:false},notes:['Shopping tracking is unavailable.']}}}:data});await click(container.querySelector('.sa2-rank-button'));
    expect(container.textContent).toContain('No supporting records could be retrieved');expect(container.textContent).toContain('not a recorded zero');expect(container.textContent).not.toContain('No matching activity was recorded');
  });
  it('reveals and focuses selected evidence, restores its invoking button, and reaches customer detail',async()=>{
    const id='00000000-0000-4000-8000-000000000123';const data=payload();data.terms=[{term:'paint',searches:3}];const revealed=[];
    const original=HTMLElement.prototype.scrollIntoView;HTMLElement.prototype.scrollIntoView=function(){revealed.push(this);};
    try {
      await render({loader:async filters=>filters.evidenceType?{evidence:{type:'term',value:'paint',records:[],customers:[{id,name:'Linked customer'}]}}:filters.customerId?{customer:{id,name:'Linked customer',timeline:[]}}:data});
      const origin=container.querySelector('.sa2-rank-button');origin.focus();await click(origin);const heading=container.querySelector('.sa2-evidence-frame h2');expect(document.activeElement).toBe(heading);expect(revealed).toContain(heading);expect(heading.tabIndex).toBe(-1);
      await click([...container.querySelectorAll('button')].find(button=>button.textContent==='Close supporting activity'));expect(document.activeElement).toBe(origin);expect(revealed.at(-1)).toBe(origin);
      await click(origin);await click([...container.querySelectorAll('button')].find(button=>button.textContent==='View activity for Linked customer'));const customerHeading=container.querySelector('.sa2-customer-detail > h3');expect(document.activeElement).toBe(customerHeading);expect(revealed.at(-1)).toBe(customerHeading);
    } finally {HTMLElement.prototype.scrollIntoView=original;}
  });
});
