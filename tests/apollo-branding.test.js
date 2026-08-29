import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

describe('Apollo admin branding', () => {
  it('uses Apollo for every user-facing intelligence label while preserving the existing route id', () => {
    const sidebar = read('src/components/GroupedSidebar.jsx');
    const foundation = read('src/components/HermesPanel.jsx');
    const productIntelligence = read('src/components/ProductIntelligencePanel.jsx');
    const buying = read('src/components/BuyingPanel.jsx');
    const analyst = read('src/components/BackendAnalyticsAnalyst.jsx');
    const adminPage = read('src/pages/AdminPage.jsx');

    expect(sidebar).toContain("{ id: 'hermes', label: 'Apollo'");
    expect(foundation).toContain('className="adm-section-title">Apollo</h2>');
    expect(productIntelligence).toContain('/> Apollo</div>');
    expect(buying).toContain('/> Apollo</div>');
    expect(analyst).toContain('Codex CLI runs through Apollo in read-only mode.');
    expect(adminPage).toContain('title="Apollo crashed"');
    expect(adminPage).toContain('label="Loading Apollo…"');
  });
});
