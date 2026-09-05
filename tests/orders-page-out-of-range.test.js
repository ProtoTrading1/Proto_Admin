import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../api/admin-orders.js', import.meta.url), 'utf8');

/**
 * "The orders vanish until I refresh."
 *
 * PostgREST answers 416 (range not satisfiable) whenever the requested window
 * starts past the end of the result set. fetchAdminOrdersPage swallowed that
 * into `rows: []` with `total: 0` — indistinguishable from an empty tab, with
 * no error surfaced. The tab badge comes from a separate count query, so it
 * kept showing a number while the table said "No orders in this tab", and a
 * refresh only appeared to help because it reset the page.
 *
 * A window past the end is not an empty tab: fall back to the first page.
 */
describe('orders page out of range', () => {
  it('retries on page 1 rather than returning an empty list', () => {
    expect(source).toMatch(/if \(error && isRangeNotSatisfiable\(error\) && page > 1\)/);
    expect(source).toMatch(/await runPage\(1\)/);
  });

  it('still surfaces genuine query errors', () => {
    expect(source).toMatch(/if \(error && !isRangeNotSatisfiable\(error\)\) throw error;/);
  });

  it('applies the same tab and search filters on the retry', () => {
    const runPage = source.slice(source.indexOf('const runPage'), source.indexOf('let { data, error, count }'));
    expect(runPage).toMatch(/applyOrderSearch/);
    expect(runPage).toMatch(/tab === 'handed'/);
    expect(runPage).toMatch(/tab === 'new'/);
    expect(runPage).toMatch(/tab === 'progress'/);
  });
});
