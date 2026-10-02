import { describe, expect, it, vi } from 'vitest';
import { analyticsQuery, loadShoppingAnalytics, numberLabel, rateLabel, comparisonLabel } from '../src/lib/shoppingAnalyticsClient';

describe('shopping analytics client', () => {
  it('defaults to a bounded window and excludes internal activity', () => {
    expect(analyticsQuery({ days: 999, source: 'unknown' })).toBe('days=30&source=all&includeInternal=false');
  });
  it('passes approved filters and cancellation to a read-only authenticated request', async () => {
    const signal = new AbortController().signal;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ summary: { recordedVisits: 12 } }) }));
    await loadShoppingAnalytics({ days: 7, source: 'instore', includeInternal: true }, { fetchImpl, signal, getAccessToken: async () => 'test-token' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/shopping-analytics-dashboard?days=7&source=instore&includeInternal=true', expect.objectContaining({ method: 'GET', signal, cache: 'no-store', headers: { Authorization: 'Bearer test-token' } }));
  });
  it('reports a sign-in boundary instead of pretending the customer count is zero', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Denied' }) });
    await expect(loadShoppingAnalytics({}, { fetchImpl })).rejects.toThrow('Sign in with an approved admin account');
  });
  it('requires admin sign-in before fetching when a supplied token provider has no session', async () => {
    const fetchImpl = vi.fn();
    await expect(loadShoppingAnalytics({}, { fetchImpl, getAccessToken: async () => null })).rejects.toThrow('Sign in with an approved admin account');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not accept malformed success responses', async () => {
    await expect(loadShoppingAnalytics({}, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })).rejects.toThrow('incomplete response');
  });
  it('keeps unavailable rates distinct from recorded zero', () => {
    expect(rateLabel(null)).toBe('—'); expect(rateLabel(0)).toBe('0.0%'); expect(rateLabel(.375)).toBe('37.5%'); expect(numberLabel(undefined)).toBe('—');
  });
  it('accepts selected customer and lookup responses without requiring overview metrics',async()=>{
    const customerId='00000000-0000-4000-8000-000000000123';
    const detail=await loadShoppingAnalytics({customerId},{fetchImpl:async()=>({ok:true,json:async()=>({customer:{id:customerId,timeline:[]}})})});expect(detail.customer.id).toBe(customerId);
    const lookup=await loadShoppingAnalytics({customerSearch:'Example'},{fetchImpl:async()=>({ok:true,json:async()=>({customerMatches:[]})})});expect(lookup.customerMatches).toEqual([]);
    await expect(loadShoppingAnalytics({customerId},{fetchImpl:async()=>({ok:true,json:async()=>({customer:{id:'wrong'}})})})).rejects.toThrow('incomplete response');
  });
  it('formats comparable changes neutrally and rate changes as percentage points',()=>{
    expect(comparisonLabel({current:15,previous:10,absoluteDelta:5,relativeDelta:.5,status:'comparable'})).toBe('+5 recorded (+50%)');
    expect(comparisonLabel({current:0,previous:10,absoluteDelta:-10,relativeDelta:-1,status:'comparable'})).toBe('−10 recorded (−100%)');
    expect(comparisonLabel({current:.55,previous:.5,absoluteDelta:.05,relativeDelta:.1,status:'comparable'},{rate:true})).toBe('+5 percentage points');
    expect(comparisonLabel({current:0,previous:0,absoluteDelta:0,relativeDelta:null,status:'comparable'})).toBe('0 recorded');
  });
  it('never invents a percentage for missing, truncated or zero-history comparisons',()=>{
    expect(comparisonLabel({current:5,previous:0,status:'new_recorded_activity'})).toContain('percentage change unavailable');
    expect(comparisonLabel({current:null,previous:2,status:'not_comparable',reason:'Current read was truncated'})).toBe('Current read was truncated');
    expect(comparisonLabel({current:0,previous:null,status:'no_recorded_history'})).toBe('No recorded history to compare');
    expect(numberLabel(NaN)).toBe('—');expect(rateLabel(Infinity)).toBe('—');
  });
  it('encodes bounded evidence keys and preserves source/window and cancellation',async()=>{
    const filters={days:7,source:'all',evidenceType:'product',evidenceValue:'A&?/% 1',evidenceSource:'instore'};const query=new URLSearchParams(analyticsQuery(filters));
    expect(query.get('evidenceValue')).toBe('A&?/% 1');expect(query.get('evidenceSource')).toBe('instore');expect(query.get('days')).toBe('7');
    const signal=new AbortController().signal;const fetchImpl=vi.fn(async()=>({ok:true,json:async()=>({evidence:{type:'product',value:'A&?/% 1',records:[]}})}));
    await loadShoppingAnalytics(filters,{fetchImpl,signal,getAccessToken:async()=> 'test-token'});expect(fetchImpl.mock.calls[0][1].signal).toBe(signal);
    await expect(loadShoppingAnalytics({...filters,evidenceValue:'x'.repeat(161)},{fetchImpl})).rejects.toThrow('selection is unavailable');
  });
  it('rejects evidence responses for a different selection',async()=>{
    await expect(loadShoppingAnalytics({evidenceType:'term',evidenceValue:'paint'},{fetchImpl:async()=>({ok:true,json:async()=>({evidence:{type:'term',value:'other'}})})})).rejects.toThrow('incomplete response');
  });
  it('matches server evidence limits and renders coverage reason codes in plain language',async()=>{
    expect(new URLSearchParams(analyticsQuery({evidenceType:'term',evidenceValue:'x'.repeat(200)})).get('evidenceValue')).toHaveLength(200);
    const fetchImpl=vi.fn();
    for(const [type,limit] of [['term',200],['product',128],['department',160]])await expect(loadShoppingAnalytics({evidenceType:type,evidenceValue:'x'.repeat(limit+1)},{fetchImpl})).rejects.toThrow('selection is unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(comparisonLabel({status:'not_comparable',reason:'previous_events_partial'})).toBe('Previous shopping tracking: limited records; comparison unavailable');
    expect(comparisonLabel({status:'not_comparable',reason:'current_customer_exclusions_incomplete'})).toContain('could not be fully excluded');
  });
});
