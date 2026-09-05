import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_CSV_COLUMNS,
  isPlausibleEmail,
  mapHeaders,
  normaliseGroupName,
  parseGroupRows,
  sampleGroupCsv,
  validateMemberPayload,
} from '../lib/email-groups.mjs';

describe('mapHeaders', () => {
  it('accepts the spellings a spreadsheet actually produces', () => {
    expect(mapHeaders(['Email Address', 'Contact Name', 'Company'])).toEqual({
      email: 0, name: 1, business_name: 2,
    });
    expect(mapHeaders(['e-mail', 'Full Name', 'Business Name'])).toEqual({
      email: 0, name: 1, business_name: 2,
    });
  });

  it('ignores columns it does not recognise', () => {
    expect(mapHeaders(['email', 'phone', 'notes'])).toEqual({ email: 0 });
  });

  it('keeps the first match when a column is repeated', () => {
    expect(mapHeaders(['email', 'e-mail'])).toEqual({ email: 0 });
  });
});

describe('parseGroupRows', () => {
  it('reads a well-formed sheet', () => {
    const { members, skipped, duplicates } = parseGroupRows([
      ['email', 'name', 'business_name'],
      ['Jane@Example.co.za', ' Jane  Dlamini ', 'Dlamini Stationers'],
      ['sam@example.co.za', 'Sam', 'Naidoo Wholesale'],
    ]);
    expect(members).toEqual([
      { email: 'jane@example.co.za', name: 'Jane Dlamini', business_name: 'Dlamini Stationers' },
      { email: 'sam@example.co.za', name: 'Sam', business_name: 'Naidoo Wholesale' },
    ]);
    expect(skipped).toHaveLength(0);
    expect(duplicates).toBe(0);
  });

  it('accepts a bare list of addresses with no header', () => {
    const { members } = parseGroupRows([
      ['jane@example.co.za'],
      ['sam@example.co.za'],
    ]);
    expect(members.map((m) => m.email)).toEqual(['jane@example.co.za', 'sam@example.co.za']);
  });

  it('reports a usable error when there is no email column at all', () => {
    const result = parseGroupRows([['name', 'phone'], ['Jane', '0821234567']]);
    expect(result.members).toHaveLength(0);
    expect(result.error).toMatch(/email/i);
  });

  it('skips malformed addresses and says which row', () => {
    const { members, skipped } = parseGroupRows([
      ['email'],
      ['jane@example.co.za'],
      ['not-an-email'],
    ]);
    expect(members).toHaveLength(1);
    expect(skipped).toEqual([{ row: 3, value: 'not-an-email', reason: 'Not a valid email address' }]);
  });

  it('merges duplicates case-insensitively rather than importing twice', () => {
    const { members, duplicates } = parseGroupRows([
      ['email'],
      ['jane@example.co.za'],
      ['JANE@EXAMPLE.CO.ZA'],
    ]);
    expect(members).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it('ignores blank rows without counting them as skips', () => {
    const { members, skipped } = parseGroupRows([
      ['email'],
      ['jane@example.co.za'],
      ['', '', ''],
      [null],
    ]);
    expect(members).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('survives junk input instead of throwing', () => {
    expect(parseGroupRows(null).members).toEqual([]);
    expect(parseGroupRows([]).members).toEqual([]);
    expect(parseGroupRows('nope').members).toEqual([]);
  });
});

describe('validateMemberPayload', () => {
  it('is the server-side gate — never trusts the client parse', () => {
    const { ok, members } = validateMemberPayload([
      { email: ' JANE@example.co.za ', name: 'Jane' },
      { email: 'broken' },
      { email: 'jane@example.co.za', name: 'Jane again' },
      { name: 'no email' },
    ]);
    expect(ok).toBe(true);
    expect(members).toHaveLength(1);
    expect(members[0]).toEqual({ email: 'jane@example.co.za', name: 'Jane', business_name: '' });
  });

  it('rejects a non-array and an oversized list', () => {
    expect(validateMemberPayload('nope').ok).toBe(false);
    const huge = Array.from({ length: 11 }, (_, i) => ({ email: `p${i}@example.com` }));
    expect(validateMemberPayload(huge, { max: 10 }).ok).toBe(false);
  });
});

describe('group names', () => {
  it('collapses whitespace and caps the length', () => {
    expect(normaliseGroupName('  10000   club  ')).toBe('10000 club');
    expect(normaliseGroupName('x'.repeat(200))).toHaveLength(120);
  });
});

describe('sample CSV', () => {
  it('leads with the documented columns and parses back cleanly', () => {
    const csv = sampleGroupCsv();
    expect(csv.split('\n')[0]).toBe(GROUP_CSV_COLUMNS.join(','));

    const rows = csv.split('\n').map((line) => line.split(','));
    const { members, skipped } = parseGroupRows(rows);
    expect(skipped).toHaveLength(0);
    expect(members).toHaveLength(3);
    // The third sample row deliberately has no name — proving name is optional.
    expect(members[2].name).toBe('');
    expect(members[2].business_name).toBe('Corner Craft Shop');
  });
});

describe('isPlausibleEmail', () => {
  it('passes ordinary addresses and rejects obvious junk', () => {
    ['a@b.co', 'jane.d+tag@example.co.za'].forEach((e) => expect(isPlausibleEmail(e)).toBe(true));
    ['', 'a@b', 'a b@c.com', 'a@b.c,d@e.f', null, undefined].forEach((e) => expect(isPlausibleEmail(e)).toBe(false));
  });
});

describe('upsert conflict target (regression)', () => {
  /**
   * The first cut of migration 062 made the uniqueness index an EXPRESSION
   * index on (group_id, lower(btrim(email))). PostgREST emits
   * ON CONFLICT (group_id, email), which Postgres only matches against a
   * unique index on those exact columns — so every upload failed with
   * "no unique or exclusion constraint matching the ON CONFLICT
   * specification". Nothing in the test suite caught it because the failure
   * only happens in the database.
   */
  const migration = fs.readFileSync(
    new URL('../migrations/063_email_group_members_conflict_target.sql', import.meta.url), 'utf8',
  );
  const api = fs.readFileSync(new URL('../api/email-groups.js', import.meta.url), 'utf8');

  it('indexes the plain columns the upsert conflicts on', () => {
    // Comments explain the old expression index, so assert on the SQL only.
    const sql = migration.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/on public\.email_group_members \(group_id, email\)/);
    // An expression in the executed statements is exactly what broke it.
    expect(sql).not.toMatch(/lower\(btrim\(email\)\)/);
  });

  it('conflicts on the columns that index covers', () => {
    expect(api).toMatch(/onConflict: 'group_id,email'/);
  });

  it('still normalises every address, which is what makes a plain index safe', () => {
    // Without this the plain index would let Jane@x.com and jane@x.com both in.
    const { members } = validateMemberPayload([{ email: '  JANE@Example.CO.ZA ' }]);
    expect(members[0].email).toBe('jane@example.co.za');
  });
});
