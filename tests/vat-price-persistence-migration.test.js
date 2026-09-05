import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../migrations/058_vat_price_persistence.sql', import.meta.url),
  'utf8',
);

describe('VAT price persistence migration', () => {
  it('fails closed unless the verified 36-row repair set is unchanged', () => {
    expect(sql).toMatch(/if v_matches <> 36 then/i);
    expect(sql).toMatch(/if v_updated <> 36 then/i);
    expect(sql).toMatch(/mod\(round\(ws\.price \* 100\)::bigint, 50\) <> 0/i);
    expect(sql).toMatch(/round\(\(ws\.price \* 1\.15\) \* 2\) \/ 2\.0/i);
  });

  it('keeps a private rollback ledger for exactly the corrected rows', () => {
    expect(sql).toMatch(/website_price_vat_repair_20260801/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/revoke all on table public\.website_price_vat_repair_20260801 from public, anon, authenticated/i);
    expect(sql).toMatch(/old_price numeric not null/i);
    expect(sql).toMatch(/new_price numeric not null/i);
  });

  it('applies the guarded VAT conversion in both future sync paths', () => {
    expect(sql).toMatch(/v_website_price := case/i);
    expect(sql).toMatch(/set price\s*=\s*v_website_price/i);
    expect(sql.match(/end as website_price/g)).toHaveLength(2);
    expect(sql).toMatch(/set price\s*=\s*p\.website_price/i);
  });

  it('continues preserving the authored website selling unit', () => {
    expect(sql).not.toMatch(/units_of_issue\s*=\s*(?:NEW|p)\./i);
    expect(sql).toMatch(/after insert or update of sell_price, stock_qty, available_stock/i);
  });
});
