import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const updateApi = readFileSync(new URL('../api/update-product.js', import.meta.url), 'utf8');
const adminPage = readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/060_product_minimum_order_quantity.sql', import.meta.url), 'utf8');

describe('product minimum order quantity', () => {
  it('is editable as a whole-number selling-unit minimum', () => {
    expect(adminPage).toContain('Minimum order quantity');
    expect(adminPage).toContain('Number of selling units required');
    const productEditorStart = adminPage.indexOf('id="product-editor-selling-unit-options"');
    const contentEditorStart = adminPage.indexOf('id="content-edit-selling-unit-options"');
    const minimumField = adminPage.indexOf('Minimum order quantity');
    expect(productEditorStart).toBeGreaterThan(-1);
    expect(minimumField).toBeGreaterThan(productEditorStart);
    expect(adminPage.slice(contentEditorStart, productEditorStart)).not.toContain('Minimum order quantity');
    expect(updateApi).toContain('patch.min_order_qty = parsedMinQty');
  });

  it('is constrained and preserved when products move through archive', () => {
    expect(migration).toMatch(/check \(min_order_qty between 1 and 9999\)/i);
    expect(migration).toMatch(/units_of_issue, min_order_qty, is_new_arrival/i);
    expect(migration).toContain('coalesce(min_order_qty, 1)');
  });
});
