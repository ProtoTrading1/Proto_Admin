import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(new URL('../src/components/GroupedSidebar.jsx', import.meta.url), 'utf8');
const adminPage = readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
const productManager = readFileSync(new URL('../src/components/ProductManagerEngine.jsx', import.meta.url), 'utf8');

describe('To-order products workspace', () => {
  it('has a dedicated backend navigation entry backed by the existing catalogue filter', () => {
    expect(sidebar).toContain("{ id: 'to-order', label: 'To-order products'");
    expect(sidebar).toContain("if (sectionId === 'to-order') qs.set('toOrderOnly', 'true')");
    expect(adminPage).toContain("activeSection === 'catalogue' || activeSection === 'to-order'");
    expect(adminPage).toContain("initialToOrderOnly={activeSection === 'to-order'}");
    expect(productManager).toContain('setOnlyInStock(initialToOrderOnly ? false : readOnlyInStockPref())');
    expect(productManager).toContain('!initialToOrderOnly && {');
  });

  it('keeps full editing and status removal available in the focused list', () => {
    expect(adminPage).toContain("onEditProduct={(item) => openEditProduct(item)}");
    expect(productManager).toContain('onToggleToOrder={toggleToOrder}');
    expect(productManager).toContain("item.toOrder ? ' pm-toorder-btn--on' : ''");
    expect(productManager).toContain('Unit: {sellingUnitLabel(item.unitsOfIssue)}');
    expect(productManager).toContain('Minimum: {Math.max(1, Number(item.minQty) || 1)}');
    expect(adminPage).toContain('Every product customers can order when stock is unavailable');
  });
});
