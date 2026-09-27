import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8');

describe('Analytics mobile layout', () => {
  it('allows the tab strip and dashboard to shrink without clipping the Instore tab', () => {
    expect(css).toMatch(/\.oa-hub\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[^}]*\.adm-customer-tabs\.oa-hub-tabs\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.oa-hub-view,\s*\.ia-dashboard\s*\{\s*min-width:\s*0/);
    expect(css).toMatch(/\.ia-dashboard\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
