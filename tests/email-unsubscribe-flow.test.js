import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildComposedEmail,
  buildRecipientVars,
  buildUnsubscribeToken,
  fetchCustomerAudience,
  verifyUnsubscribeToken,
} from '../api/_brevo-email.js';

function fakeSupabase(tables) {
  const queries = [];
  return {
    queries,
    from(table) {
      const state = { table, filters: [] };
      queries.push(state);
      const builder = {
        select() { return builder; },
        range() { return builder; },
        eq(column, value) { state.filters.push({ column, value }); return builder; },
        in(column, value) { state.filters.push({ column, value }); return builder; },
        then(resolve, reject) {
          const rows = state.served ? [] : (tables[table] || []);
          state.served = true;
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

describe('marketing unsubscribe flow', () => {
  it('turns the backend unsubscribe merge tag into a per-recipient admin link', () => {
    vi.stubEnv('MARKETING_UNSUBSCRIBE_SECRET', 'test-secret');
    const vars = buildRecipientVars({ email: 'Jane@Example.co.za', first_name: 'Jane' });
    const email = buildComposedEmail({
      subject: 'Proto update',
      htmlBlock: '<a href="{{ unsubscribe }}">unsubscribe here</a>',
    }, vars);

    expect(email.htmlContent).toContain('https://admin.proto.co.za/api/email-unsubscribe?e=');
    expect(email.htmlContent).toContain('&t=');
    expect(email.htmlContent).not.toContain('{{ unsubscribe }}');
    expect(verifyUnsubscribeToken('jane@example.co.za', buildUnsubscribeToken('jane@example.co.za'))).toBe(true);
    expect(verifyUnsubscribeToken('other@example.co.za', buildUnsubscribeToken('jane@example.co.za'))).toBe(false);
  });

  it('filters opted-out contacts before Brevo receives the broadcast audience', async () => {
    const sb = fakeSupabase({
      customers: [
        { email: 'keep@example.co.za', is_approved: true, first_name: 'Keep' },
        { email: 'Stop@Example.co.za', is_approved: true, first_name: 'Stop' },
      ],
      marketing_email_opt_outs: [
        { email: 'stop@example.co.za' },
      ],
    });

    const recipients = await fetchCustomerAudience(sb, 'all-approved');

    expect(recipients.map((r) => r.email)).toEqual(['keep@example.co.za']);
    expect(sb.queries.some((q) => q.table === 'marketing_email_opt_outs')).toBe(true);
  });

  it('ships a database-backed suppression list and public opt-out endpoint', () => {
    const migration = fs.readFileSync(new URL('../migrations/064_marketing_email_opt_outs.sql', import.meta.url), 'utf8');
    const endpoint = fs.readFileSync(new URL('../api/email-unsubscribe.js', import.meta.url), 'utf8');
    const previewMergeTags = fs.readFileSync(new URL('../src/lib/emailMergeTags.js', import.meta.url), 'utf8');

    expect(migration).toMatch(/create table if not exists public\.marketing_email_opt_outs/);
    expect(migration).toMatch(/grant all on table public\.marketing_email_opt_outs to service_role/);
    expect(endpoint).toContain("from('marketing_email_opt_outs').upsert");
    expect(endpoint).toContain('verifyUnsubscribeToken');
    expect(previewMergeTags).toContain("key: 'unsubscribe'");
    expect(previewMergeTags).toContain("key: 'unsubscribe_url'");
  });
});
