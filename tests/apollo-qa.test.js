import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { answerApolloQuestion } from '../lib/apollo-qa.mjs';

const window = { kind: 'week', start: '2026-09-07T00:00:00.000Z', end: '2026-09-12T12:00:00.000Z' };
const report = overrides => ({
  checkedAt: '2026-09-12T12:00:00.000Z', window,
  orders: { source: 'portal.orders', status: 'available', complete: true, lastSuccessfulAt: '2026-09-12T12:00:00.000Z', data: { orders: 4, revenue: 250, revenueKnown: true } },
  searches: { source: 'portal.search_analytics', status: 'available', complete: true, lastSuccessfulAt: '2026-09-12T12:00:00.000Z', data: { recordedSearches: 4, topTerms: [{ term: 'wooden bracelet', searches: 2, zeroResults: 1 }] } },
  searchActivity: { source: 'apollo_activity_events', status: 'partial', complete: false, lastSuccessfulAt: '2026-09-12T12:00:00.000Z', data: { surfaces: { main: { coverage: 'partial', topTerms: [{ term: 'wooden bracelet', searches: 2, zeroResults: 1 }] }, instore: { coverage: 'unavailable', topTerms: [] } } } },
  positill: { source: 'read-only POS bridge', status: 'available', complete: false, data: { rawTotal: 99 } },
  baskets: { source: 'portal.customer_account_carts', status: 'available', complete: true, data: { openBaskets: 2, totalUnits: 5, valueInclVat: 82.5 } },
  activeTime: { source: 'apollo_activity_events', status: 'unavailable', complete: false, data: null, reason: 'coverage not verified' },
  ...overrides,
});

test('answers website-order value from the selected server report without calling it POS sales', () => {
  const result = answerApolloQuestion('How much order value this week?', { report: report(), selectedPeriod: 'week' });
  assert.equal(result.status, 'answered');
  assert.match(result.answer, /4 recorded website orders/);
  assert.match(result.answer, /not Positill sales/);
  assert.equal(result.source, 'portal.orders');
  assert.match(result.period, /SAST/);
});

test('answers comparison questions only from the report comparison envelope', () => {
  const base = report();
  base.orders.data.comparison = { metrics: { revenue: { status: 'available', current: 250, previous: 200, delta: 50, percentChange: 25 } } };
  const result = answerApolloQuestion('How did website sales compare?', { report: base, selectedPeriod: 'week' });
  assert.equal(result.status, 'answered');
  assert.match(result.answer, /R\s?250.*current vs R\s?200/);
  assert.match(result.answer, /R\s?50/);
  assert.match(result.answer, /not Positill sales/);
  const unavailable = answerApolloQuestion('Compare the website sales', { report: report(), selectedPeriod: 'week' });
  assert.equal(unavailable.status, 'unavailable');
});

test('uses source-separated searches when present and discloses partial coverage', () => {
  const result = answerApolloQuestion('What are the most popular searches?', { report: report(), selectedPeriod: 'week' });
  assert.equal(result.status, 'partial');
  assert.match(result.answer, /wooden bracelet/);
  assert.match(result.answer, /Partial coverage/);
});

test('prioritizes actual zero-result searches for no-result questions', () => {
  const base = report();
  base.searchActivity.data.surfaces.main.topTerms = [
    { term: 'mug', searches: 10, zeroResults: 0 },
    { term: 'rare clasp', searches: 2, zeroResults: 2 },
  ];
  const result = answerApolloQuestion('Which Main website searches returned no results?', { report: base, selectedPeriod: 'week' });
  assert.equal(result.status, 'partial');
  assert.match(result.answer, /rare clasp/);
  assert.doesNotMatch(result.answer, /\bmug\b/);
});

test('does not relabel legacy source-unknown searches as Instore searches', () => {
  const result = answerApolloQuestion('What were the Instore searches?', { report: report(), selectedPeriod: 'week' });
  assert.equal(result.status, 'partial');
  assert.match(result.answer, /legacy Analytics records/);
  assert.doesNotMatch(result.answer, /wooden bracelet/);
});

test('answers product and category interest from deliberate source-separated views', () => {
  const base = report();
  base.searchActivity.data.surfaces.instore.topProducts = [{ product: 'SKU-86', views: 3 }];
  base.searchActivity.data.surfaces.instore.topCategories = [{ category: 'Jewellery', views: 2 }];
  const result = answerApolloQuestion('Which products were viewed in Instore?', { report: base, selectedPeriod: 'week' });
  assert.equal(result.status, 'partial');
  assert.match(result.answer, /SKU-86/);
  assert.doesNotMatch(result.answer, /wooden bracelet/);
});

test('never promotes raw Positill evidence to verified sales', () => {
  const result = answerApolloQuestion('What were Positill sales?', { report: report(), selectedPeriod: 'week' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.answer, /cannot report verified Positill sales/);
  assert.match(result.answer, /credit-note treatment/);
});

test('basket snapshots are explicit and live names come only from the owner-only live feed', () => {
  const baskets = answerApolloQuestion('What is the basket value?', { report: report(), selectedPeriod: 'week' });
  assert.match(baskets.answer, /not sales/);
  assert.match(baskets.answer, /incl\. VAT/);
  const live = answerApolloQuestion('Who is online?', { report: report(), selectedPeriod: 'week', liveReport: { checkedAt: '2026-09-12T12:00:00Z', live: { source: 'portal presence', status: 'available', complete: true, data: { customers: [{ name: 'Test Customer', currentSection: 'instore', basket: { value: 25 } }] } } } });
  assert.match(live.answer, /Test Customer/);
  assert.match(live.answer, /anonymous visitors are not included/i);
  assert.match(live.period, /Live snapshot/);
});

test('labels stale report answers partial rather than fresh', () => {
  const result = answerApolloQuestion('What is the order value?', { report: { ...report(), stale: true }, selectedPeriod: 'week' });
  assert.equal(result.status, 'partial');
  assert.match(result.answer, /Partial or unverified evidence/);
});

test('refuses a question for a different period than the selected report', () => {
  const result = answerApolloQuestion('What were sales this month?', { report: report(), selectedPeriod: 'week' });
  assert.equal(result.status, 'needs_period');
  assert.match(result.answer, /Change the report Period control/);
});

test('unknown topics and unavailable evidence never become guessed answers', () => {
  assert.equal(answerApolloQuestion('Will sales grow next year?', { report: report(), selectedPeriod: 'week' }).status, 'unsupported');
  const result = answerApolloQuestion('How long did customers stay on the site?', { report: report(), selectedPeriod: 'week' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.answer, /coverage not verified/);
});

