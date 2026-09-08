import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const adminPage = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
const application = fs.readFileSync(new URL('../src/components/CustomerApplicationDetails.jsx', import.meta.url), 'utf8');
const customersApi = fs.readFileSync(new URL('../api/admin-customers.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/066_school_signup.sql', import.meta.url), 'utf8');
const typeMigration = fs.readFileSync(new URL('../migrations/067_school_type.sql', import.meta.url), 'utf8');

describe('school customer badge', () => {
  it('badges accounts registered on the school-supply site', () => {
    expect(adminPage).toContain('function SchoolBadge({ customer })');
    expect(adminPage).toMatch(/customer\?\.is_school === true/);
    expect(adminPage).toContain('SCHOOL');
  });

  it('still badges schools registered before the migration landed', () => {
    // is_school is null on rows written before migration 066; the institution
    // sales channel is the fallback signal.
    expect(adminPage).toMatch(/sales_channels\?\.includes\?\.\('School, church or institution'\)/);
  });

  it('shows the badge everywhere a customer is listed', () => {
    const renders = adminPage.match(/<SchoolBadge customer=\{/g) || [];
    expect(renders.length).toBe(3);
    // Alongside the 10000 club badge, never replacing it.
    expect(adminPage).toMatch(/<TenThousandClubBadge customer=\{person\} \/>\s*<SchoolBadge customer=\{person\} \/>/);
  });

  it('distinguishes public from private schools', () => {
    expect(application).toContain("label=\"School type\"");
    expect(application).toMatch(/customer\.school_type/);
    expect(adminPage).toMatch(/customer\?\.school_type/);
    expect(typeMigration).toMatch(/add column if not exists school_type text/i);
    expect(typeMigration).toMatch(/'Public school', 'Private school'/);
  });

  it('surfaces the school answers in the application panel', () => {
    expect(application).toContain("label=\"Role at the school\"");
    expect(application).toContain("label=\"Supply needs\"");
    expect(application).toMatch(/isSchool \? 'School registration' : 'Online trade application'/);
    expect(application).toMatch(/customer\.school_role/);
    expect(application).toMatch(/values\(customer\.supply_needs\)/);
  });

  it('lets an admin correct the school fields', () => {
    expect(customersApi).toContain("'is_school', 'school_type', 'school_role', 'supply_needs'");
  });

  it('adds the columns the badge reads', () => {
    expect(migration).toMatch(/add column if not exists is_school boolean not null default false/i);
    expect(migration).toMatch(/add column if not exists school_role text/i);
    expect(migration).toMatch(/add column if not exists supply_needs text\[\]/i);
  });
});
