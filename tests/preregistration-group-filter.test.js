import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
const lib = fs.readFileSync(new URL('../src/lib/customers.js', import.meta.url), 'utf8');

describe('pre-registration upload-group filter', () => {
  it('sends the batch to the API', () => {
    expect(lib).toMatch(/if \(batch\) params\.set\('batch', batch\)/);
    expect(page).toMatch(/searchQuery: customerSearchDebounced, batch: customerBatch/);
  });

  it('keys the page cache on the batch', () => {
    // Without this, switching groups would serve the previous group's cached
    // page — the list would look filtered while showing the wrong contacts.
    expect(page).toMatch(/\$\{customerBusinessType\}\|\$\{customerBatch\}/);
  });

  it('returns to page 1 when the group changes', () => {
    expect(page).toMatch(/setCustomerPage\(1\); \}, \[customerBatch, customerTab/);
  });

  it('loads the picker from its own endpoint, not the filtered page', () => {
    // Deriving the options from the page response meant a filtered page could
    // blank the dropdown that filtered it, and that endpoint is owner-only so
    // a non-owner admin got no options at all. A dedicated admin-guarded read
    // has neither problem.
    expect(page).toMatch(/fetchCustomerImportBatches\(\)/);
    expect(page).not.toMatch(/data\.batches/);
  });

  it('the groups endpoint is admin-guarded, not owner-only', () => {
    const api = fs.readFileSync(new URL('../api/customer-import-batches.js', import.meta.url), 'utf8');
    expect(api).toMatch(/if \(!\(await requireAdminKey\(req, res\)\)\) return;/);
    // The word appears in the comment explaining why; the guard must not use it.
    expect(api).not.toMatch(/await requireOwner\(/);
  });
});
