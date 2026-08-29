import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../src/components/EmailAnalyticsPanel.jsx', import.meta.url), 'utf8');

describe('email campaign delivery analytics', () => {
  it('derives delivered emails from Brevo-accepted sends less bounces', () => {
    expect(source).toMatch(/const delivered = Math\.max\(0, sent - bounced\);/);
  });

  it('does not use the inconsistent delivered webhook event as the displayed delivery count', () => {
    expect(source).not.toMatch(/const delivered = e\.delivered \|\| 0;/);
  });

  it('explains the delivery calculation in the dashboard', () => {
    expect(source).toContain('Delivered means emails accepted by Brevo, less recorded bounces.');
  });

  it('separates reporting periods and draft campaigns from sent campaigns', () => {
    expect(source).toContain("[['all', 'All time'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']]");
    expect(source).toContain('const sentRows = rows.filter((row) => !row.isDraft && row.sent > 0);');
    expect(source).toContain('Tracking confidence');
  });

  it('shows opt-outs and recipient-tracking status per campaign', () => {
    expect(source).toContain('label="Opt-outs"');
    expect(source).toContain('<th className="adm-sheet__num">Opt-outs</th>');
    expect(source).toContain("r.hasRecipientSnapshot ? 'Tracked' : 'Legacy'");
  });
});
