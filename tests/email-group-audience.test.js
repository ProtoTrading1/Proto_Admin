import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchCustomerAudience } from '../api/_brevo-email.js';

/**
 * Replaces the old import-batch audience tests. Pre-registration, trade
 * requests and "approved + pre-registration" were removed from the composer
 * on purpose: a broadcast can now target approved trade customers or one
 * uploaded group, and nothing else. These cover the group half.
 */

/** Supabase double that records the filters applied to each table. */
function fakeSupabase(tables) {
  const queries = [];
  return {
    queries,
    from(table) {
      const state = { table, filters: [] };
      queries.push(state);
      // fetchAllFromTable calls .range() BEFORE the caller's buildQuery, so
      // every step has to stay chainable and only resolve when awaited.
      const builder = {
        select() { return builder; },
        order() { return builder; },
        range() { return builder; },
        eq(column, value) { state.filters.push({ column, value }); return builder; },
        in(column, value) { state.filters.push({ column, value }); return builder; },
        then(resolve, reject) {
          // Second page must come back empty or the pager loops forever.
          const rows = state.served ? [] : (tables[table] || []);
          state.served = true;
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const GROUP_MEMBERS = [
  { email: 'Jane@Example.co.za', name: 'Jane', business_name: 'Dlamini Stationers' },
  { email: 'sam@example.co.za', name: '', business_name: 'Naidoo Wholesale' },
];

describe('group audience resolution', () => {
  it('resolves a group to its members', async () => {
    const sb = fakeSupabase({ email_group_members: GROUP_MEMBERS });
    const recipients = await fetchCustomerAudience(sb, 'group', { groupId: 'grp-1' });

    expect(recipients.map((r) => r.email)).toEqual(['jane@example.co.za', 'sam@example.co.za']);
    const memberQuery = sb.queries.find((q) => q.table === 'email_group_members');
    expect(memberQuery.filters).toContainEqual({ column: 'group_id', value: 'grp-1' });
  });

  it('never touches the customers table for a group send', async () => {
    const sb = fakeSupabase({ email_group_members: GROUP_MEMBERS, customers: [{ email: 'someone@else.com' }] });
    await fetchCustomerAudience(sb, 'group', { groupId: 'grp-1' });

    // Group members are not customers; mixing the two would mail people the
    // admin did not choose.
    expect(sb.queries.some((q) => q.table === 'customers')).toBe(false);
  });

  it('returns nobody when no group is named, rather than everybody', async () => {
    const sb = fakeSupabase({ email_group_members: GROUP_MEMBERS });
    expect(await fetchCustomerAudience(sb, 'group', { groupId: '' })).toEqual([]);
    expect(await fetchCustomerAudience(sb, 'group', {})).toEqual([]);
  });

  it('ignores a business-type filter on a group instead of emptying the send', async () => {
    // Members carry no business_type, so applying the filter would match none
    // of them and silently send to nobody.
    const sb = fakeSupabase({ email_group_members: GROUP_MEMBERS });
    const recipients = await fetchCustomerAudience(sb, 'group', {
      groupId: 'grp-1',
      businessTypes: ['Retail store'],
    });
    expect(recipients).toHaveLength(2);
  });

  it('falls back to the business name when a member has no name', async () => {
    const sb = fakeSupabase({ email_group_members: GROUP_MEMBERS });
    const [, sam] = await fetchCustomerAudience(sb, 'group', { groupId: 'grp-1' });
    expect(sam.name).toBe('Naidoo Wholesale');
  });
});

describe('group audience wiring', () => {
  const sender = fs.readFileSync(new URL('../api/_send-email-broadcast.js', import.meta.url), 'utf8');
  const endpoint = fs.readFileSync(new URL('../api/customer-email-broadcast.js', import.meta.url), 'utf8');
  const modal = fs.readFileSync(new URL('../src/components/CustomerEmailModal.jsx', import.meta.url), 'utf8');

  it('accepts "group" as an audience and threads the id to the resolver', () => {
    expect(sender).toMatch(/'group'/);
    expect(sender).toMatch(/groupId,/);
    expect(endpoint).toMatch(/groupId: String\(groupId \|\| ''\)\.trim\(\)/);
  });

  it('refuses a group send with no group chosen', () => {
    expect(endpoint).toMatch(/aud === 'group' && !String\(groupId \|\| ''\)\.trim\(\)/);
  });

  it('sends the group id on BOTH the test and the real send', () => {
    // An early edit reached only the test payload once, which would have
    // previewed one audience and sent to another.
    const hits = modal.match(/groupId: audience === 'group' \? groupId : ''/g) || [];
    expect(hits.length).toBe(2);
  });

  it('offers only approved customers and groups in the dropdown', () => {
    expect(modal).toMatch(/value: 'all-approved'/);
    expect(modal).toMatch(/value: `group::\$\{g\.id\}`/);
    // The removed audiences must not come back as pickable options.
    expect(modal).not.toMatch(/value: 'requests'/);
    expect(modal).not.toMatch(/value: 'proto-active'/);
    expect(modal).not.toMatch(/value: 'all-portal'/);
  });

  it('hides empty groups, which would send to nobody', () => {
    expect(modal).toMatch(/\.filter\(\(g\) => g\.memberCount > 0\)/);
  });

  it('clears business types when a group is chosen', () => {
    expect(modal).toMatch(/if \(aud === 'group'\) setBusinessTypes\(\[\]\)/);
  });

  it('offers business types as checkboxes, so segments can overlap', () => {
    expect(modal).toMatch(/type="checkbox"/);
    expect(modal).toMatch(/prev\.includes\(type\) \? prev\.filter\(\(t\) => t !== type\) : \[\.\.\.prev, type\]/);
  });
});
