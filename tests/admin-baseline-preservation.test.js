import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

describe('protected admin baseline', () => {
  it('keeps every current main navigation destination while adding the approved changes', () => {
    const sidebar = readFileSync(resolve(ROOT, 'src/components/GroupedSidebar.jsx'), 'utf8');
    const adminPage = readFileSync(resolve(ROOT, 'src/pages/AdminPage.jsx'), 'utf8');
    const sectionIds = [
      'orders',
      'hermes',
      'product-intelligence',
      'buying',
      'product-loader',
      'image-processing',
      'title-replace',
      'catalogue',
      'to-order',
      'archive',
      'reorder',
      'customers',
      'comms',
      'site-content',
      'analytics',
      'backend-health',
      'pricing',
      'team',
    ];

    for (const id of sectionIds) {
      expect(sidebar).toContain(`id: '${id}'`);
      if (id !== 'team') expect(adminPage).toContain(`activeSection === '${id}'`);
    }
  });

  it('keeps Stock available distinct from To order on desktop and mobile rows', () => {
    const productManager = readFileSync(resolve(ROOT, 'src/components/ProductManagerEngine.jsx'), 'utf8');
    const mutations = readFileSync(resolve(ROOT, 'src/hooks/useCatalogMutations.js'), 'utf8');

    expect(productManager.match(/Stock available/g)?.length).toBeGreaterThanOrEqual(4);
    expect(productManager).toContain('toggleStockAvailable');
    expect(productManager).toContain('toggleToOrder');
    expect(mutations).toContain("incomingStatus: stockAvailable ? 'landed_awaiting_grv' : 'none'");
    expect(mutations).toContain('incomingQty: stockAvailable ? 0.001 : 0');
  });
});
