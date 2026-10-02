const KEYS = ['presenceRecords', 'searches', 'journeys', 'events', 'actualOrders'];
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const sourceKeys = { presenceRecords: 'visits', searches: 'searches', journeys: 'journeys', events: 'legacyEvents', actualOrders: 'orders' };

/** Only summaries cross the admin API; never return arbitrary RPC fields. */
export function normalizeHistoricalAggregate(value, scope) {
  if (!value || !value.historicalSummary || !value.historicalSearch) return null;
  const historicalSummary = {};
  for (const key of KEYS) {
    const metric = value.historicalSummary[key];
    if (!metric || !['complete', 'available', 'partial', 'unavailable'].includes(metric.status) || (metric.status !== 'unavailable' && !safeCount(metric.count))) return null;
    historicalSummary[key] = { count: metric.status === 'unavailable' ? null : metric.count,
      status: metric.status === 'complete' ? 'available' : metric.status,
      label: {presenceRecords:'Presence records', searches:'Existing search records', journeys:'Existing journey records', events:'Existing activity records', actualOrders:'Saved order records'}[key],
      source: key === 'actualOrders' ? 'All catalogues' : 'Catalogue not recorded',
      reason: metric.status === 'unavailable' ? 'This historical source could not be read.' : metric.status === 'partial' ? 'This aggregate covers only part of the selected records.' : null };
    if (scope.source !== 'all' && key !== 'actualOrders') historicalSummary[key] = {...historicalSummary[key], count:null, status:'source_not_recorded',reason:'Older records do not identify Main catalogue or Instore; this catalogue breakdown is unavailable.'};
  }
  const raw = value.historicalSearch;
  if (!raw || !['daily','terms','noResultTerms'].every(key=>Array.isArray(raw[key] ?? (key==='noResultTerms'?[]:null)))) return null;
  if(['daily','terms','noResultTerms'].some(key=>(raw[key] || []).some(row=>!row || typeof row!=='object')))return null;
  const search = {...raw, searches:raw.searches ?? raw.count, unknownResultsCount:raw.unknownResultsCount ?? raw.unknownResults,
    daily:raw.daily?.map(row=>({...row,unknownResultsCount:row.unknownResultsCount ?? row.unknownResults})),
    terms:raw.terms?.map(row=>({...row,unknownResultsCount:row.unknownResultsCount ?? row.unknownResults})),limitedTerms:raw.limitedTerms ?? raw.termsLimit?.truncated,
    noResultTerms:(raw.noResultTerms || []).map(row=>({...row,unknownResultsCount:row.unknownResultsCount ?? row.unknownResults})),limitedNoResultTerms:raw.limitedNoResultTerms ?? raw.noResultTermsLimit?.truncated};
  if (!['complete','partial','unavailable'].includes(search.status)) return null;
  const unavailable = scope.source !== 'all' || search.status === 'unavailable';
  if (!unavailable && (![search.searches, search.noResults, search.unknownResultsCount].every(safeCount) || search.noResults + search.unknownResultsCount > search.searches || !Array.isArray(search.daily) || !Array.isArray(search.terms))) return null;
  const validRows = (rows, field) => rows.every(row => typeof row[field] === 'string' && [row.searches,row.noResults,row.unknownResultsCount].every(safeCount) && row.noResults + row.unknownResultsCount <= row.searches && (field === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(row.date) : row.term.length <= 200));
  if (!unavailable && (!validRows(search.daily,'date') || !validRows(search.terms,'term') || !validRows(search.noResultTerms,'term') || search.daily.length > 92 || search.terms.length > 100 || search.noResultTerms.length > 100)) return null;
  if(!unavailable) {
    const unique= (rows,key)=>new Set(rows.map(row=>row[key])).size===rows.length;
    const earliest=scope.since?.slice(0,10),latest=scope.until?.slice(0,10);
    if(!unique(search.daily,'date') || !unique(search.terms,'term') || !unique(search.noResultTerms,'term') || search.daily.some(row=>!Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0,10)!==row.date || (earliest && row.date<earliest) || (latest && row.date>latest)))return null;
    if([search.terms,search.noResultTerms].some(rows=>['searches','noResults','unknownResultsCount'].some(key=>rows.reduce((sum,row)=>sum+row[key],0)>search[key])) || search.noResultTerms.some(row=>row.noResults===0))return null;
    if(search.status==='complete' && (['searches','noResults','unknownResultsCount'].some(key=>search.daily.reduce((sum,row)=>sum+row[key],0)!==search[key]) || historicalSummary.searches.count!==search.searches))return null;
  }
  return { historicalSummary, historicalSearch: { status: unavailable ? 'unavailable' : search.status,
    reason: scope.source !== 'all' ? 'Older search records do not record the catalogue.' : unavailable ? 'Historical searches could not be read.' : search.status === 'partial' ? 'These figures cover only a retrieved subset.' : null,
    searches: unavailable ? null : search.searches, noResults: unavailable ? null : search.noResults, unknownResultsCount: unavailable ? null : search.unknownResultsCount,
    daily: unavailable ? [] : search.daily.map(({date,searches,noResults,unknownResultsCount})=>({date,searches,noResults,unknownResultsCount})),
    terms: unavailable ? [] : search.terms.map(({term,searches,noResults,unknownResultsCount})=>({term,searches,noResults,unknownResultsCount})), limitedTerms: !unavailable && search.limitedTerms === true,
    noResultTerms:unavailable?[]:search.noResultTerms.map(({term,searches,noResults,unknownResultsCount})=>({term,searches,noResults,unknownResultsCount})),limitedNoResultTerms:!unavailable && search.limitedNoResultTerms===true,
    source:'search_analytics',population:'historical_records' } };
}

export async function readHistoricalAggregate(client, scope) {
  try {
    const {data,error} = await client.rpc('proto_shopping_history_summary', {
      p_since:scope.since,p_until:scope.until,
      p_excluded_customer_ids:scope.excludedCustomerIds.filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)),
      p_excluded_customer_emails:scope.excludedCustomerEmails,p_include_internal:scope.includeInternal,
    });
    if (error) return {available:false,error:['42883','PGRST202'].includes(error.code)?'not_installed':'read_failed'};
    const normalized=normalizeHistoricalAggregate(data,scope);
    return normalized ? {available:true,...normalized} : {available:false,error:'invalid_aggregate'};
  } catch { return {available:false,error:'read_failed'}; }
}

export function buildHistoricalSearchFallback(input, scope, shaped) {
  const metric=shaped.historicalSummary.searches;
  if (metric.count === null) return {status:'unavailable',reason:metric.reason,searches:null,noResults:null,unknownResultsCount:null,daily:[],terms:[],limitedTerms:false,noResultTerms:[],limitedNoResultTerms:false,source:'search_analytics',population:'historical_records'};
  const excluded=new Set(shaped.quality.excludedCustomerIds); const seen=new Set();
  const rows=(input.searches || []).filter(row=>{
    const time=Date.parse(row.created_at);
    if (row.id && seen.has(row.id)) return false;
    if (row.id) seen.add(row.id);
    return time>=Date.parse(scope.since) && time<Date.parse(scope.until) && (scope.includeInternal || (!excluded.has(row.customer_id) && row.is_internal!==true && (!row.environment || row.environment==='production')));
  });
  const daily=new Map(),terms=new Map(); let noResults=0,unknownResultsCount=0;
  for (const row of rows) {
    const known=typeof row.results_found==='number' && Number.isFinite(row.results_found) && row.results_found>=0;
    const zero=known && row.results_found===0; noResults+=Number(zero); unknownResultsCount+=Number(!known);
    const date=new Date(row.created_at).toISOString().slice(0,10);
    const term=String(String(row.normalized_search_term || '').trim() || row.search_term || '').trim().toLowerCase().replace(/\s+/g,' ').slice(0,200) || '(empty term)';
    for (const [map,key,field] of [[daily,date,'date'],[terms,term,'term']]) { const item=map.get(key)||{[field]:key,searches:0,noResults:0,unknownResultsCount:0};item.searches++;item.noResults+=Number(zero);item.unknownResultsCount+=Number(!known);map.set(key,item); }
  }
  const failedTerms=[...terms.values()].filter(row=>row.noResults>0).sort((a,b)=>b.noResults-a.noResults || b.searches-a.searches || a.term.localeCompare(b.term));
  return {status:metric.status==='partial'?'partial':'complete',reason:metric.reason,searches:rows.length,noResults,unknownResultsCount,daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),terms:[...terms.values()].sort((a,b)=>b.searches-a.searches || a.term.localeCompare(b.term)).slice(0,100),limitedTerms:terms.size>100,noResultTerms:failedTerms.slice(0,100),limitedNoResultTerms:failedTerms.length>100,source:'search_analytics',population:'historical_records'};
}

export function applyHistoricalCoverage(data, aggregate) {
  for (const [metric,key] of Object.entries(sourceKeys)) {
    if (key==='orders') continue; // New order verification still depends on its bounded raw read.
    const item=aggregate.historicalSummary[metric];
    data.quality.sources[key]={available:item.status!=='unavailable',error:item.status==='unavailable'?'read_failed':null,truncated:item.status==='partial',count:item.count,aggregated:true,catalogueRecorded:false};
  }
  data.quality.legacyCounts={searches:aggregate.historicalSummary.searches.count,journeys:aggregate.historicalSummary.journeys.count,events:aggregate.historicalSummary.events.count,visits:aggregate.historicalSummary.presenceRecords.count};
  // Aggregated legacy records cannot verify a shared session with the new stream.
  data.quality.matchedPresenceVisits=null;
  data.quality.missingSources=Object.entries(data.quality.sources).filter(([,status])=>!status.available).map(([key])=>key);
  data.quality.partialSources=Object.entries(data.quality.sources).filter(([,status])=>status.truncated).map(([key])=>key);
  data.quality.status=data.quality.missingSources.length || data.quality.partialSources.length || data.quality.unlinkedEvents ? 'partial':'available';
  data.actions=data.actions.filter(action=>!['coverage','partial-coverage'].includes(action.id));
  if(data.quality.partialSources.length)data.actions.unshift({id:'partial-coverage',title:'Review retrieval limits before comparing performance',detail:`Partial sources: ${data.quality.partialSources.join(', ')}. Retrieved counts are subsets.`,evidence:{partialSources:data.quality.partialSources}});
  if(data.quality.missingSources.length)data.actions.unshift({id:'coverage',title:'Review unavailable sources before interpreting conversion',detail:`Unavailable sources: ${data.quality.missingSources.join(', ')}`,evidence:{missingSources:data.quality.missingSources}});
}
