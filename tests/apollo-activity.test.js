import { describe, it, expect } from 'vitest';
import { activityEventRowsToIntervals, aggregateActiveIntervals } from '../lib/apollo-activity.mjs';
const at = sec => new Date(Date.UTC(2026, 8, 12, 12, 0, sec)).toISOString();
const verified = { verified: true, start: at(0), end: at(180) };
const window = { start: at(0), end: at(180), coverage: { main: verified, instore: verified } };
const row = (id, a, b, extra = {}) => ({event_id:id, customer_id:'synthetic', source:'main', start_at:at(a), end_at:at(b), ...extra});
describe('active interval aggregation', () => {
  it('maps only strict private event-table payloads into report intervals', () => {
    const input = [{event_id:'a',customer_id:'synthetic',source:'main',event_type:'active_interval',payload:{start_at:at(0),end_at:at(30),seconds:30}},
      {event_id:'bad',customer_id:'synthetic',source:'main',event_type:'active_interval',payload:{start_at:at(0),end_at:at(30),seconds:1,extra:true}},
      {event_id:'view',customer_id:'synthetic',source:'main',event_type:'product_view',payload:{}}];
    const mapped = activityEventRowsToIntervals(input);
    expect(mapped.rejectedRecords).toBe(2); expect(mapped.intervals).toEqual([{event_id:'a',customer_id:'synthetic',source:'main',start_at:at(0),end_at:at(30)}]);
  });
  it('unions overlapping tabs and retries instead of summing them', () => {
    const result = aggregateActiveIntervals([row('a',0,60),row('b',30,90),row('a',0,60)],window);
    expect(result.activeSeconds).toBe(90); expect(result.duplicateRecords).toBe(1); expect(result.complete).toBe(true);
  });
  it('unions Main/Instore separately and across surfaces', () => {
    const result = aggregateActiveIntervals([row('a',0,60),row('b',30,90,{source:'instore'})],window);
    expect(result.customers[0]).toMatchObject({mainSeconds:60,instoreSeconds:60,activeSeconds:90});
  });
  it('does not merge different customers', () => {
    expect(aggregateActiveIntervals([row('a',0,60),row('b',0,60,{customer_id:'other'})],window).activeSeconds).toBe(120);
  });
  it('clips to requested period', () => {
    expect(aggregateActiveIntervals([row('a',-30,30),row('b',160,200)],window).activeSeconds).toBe(50);
  });
  it('rejects malformed, overlong and conflicting records without calling them complete', () => {
    const result = aggregateActiveIntervals([row('a',0,60),row('a',10,20),row('b',0,61),row('c',1,0),row('d',0,20,{source:'other'})],window);
    expect(result.rejectedRecords).toBe(4); expect(result.complete).toBe(false);
  });
  it('unknown collection is not zero, verified empty collection is zero', () => {
    expect(aggregateActiveIntervals([], { start: window.start, end: window.end }).activeSeconds).toBe(null);
    expect(aggregateActiveIntervals([],window).activeSeconds).toBe(0);
  });
  it('requires verified coverage of the requested window for each source', () => {
    const result = aggregateActiveIntervals([row('a', 0, 30)], { start: window.start, end: window.end,
      coverage: { main: verified, instore: { verified: true, start: at(10), end: at(180) } } });
    expect(result).toMatchObject({ complete: false, coverage: { main: true, instore: false }, activeSeconds: 30 });
    expect(result.customers[0]).toMatchObject({ mainSeconds: 30, instoreSeconds: null });
  });
  it('keeps a measured partial source but never invents an uncovered zero', () => {
    const result = aggregateActiveIntervals([row('a', 0, 30, { source: 'instore' })], { start: window.start, end: window.end });
    expect(result.customers[0]).toMatchObject({ mainSeconds: null, instoreSeconds: 30, activeSeconds: 30 });
    expect(result.complete).toBe(false);
  });
  it('requires explicit timezone boundaries and a positive window', () => {
    expect(()=>aggregateActiveIntervals([],{start:'2026-09-12',end:at(60)})).toThrow();
    expect(()=>aggregateActiveIntervals([],{start:at(60),end:at(0)})).toThrow();
  });
});
