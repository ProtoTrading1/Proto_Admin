import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every auth guard a route calls must actually be imported in that file.
 *
 * api/category-sort-order.js shipped for weeks calling requireAdminKey while
 * importing only requireOwner: commit 1bc7f3e ("Limit catalogue and settings
 * changes to owners") swapped the import and updated the GET call site but
 * missed the POST one. Because the reference sits above the try block, every
 * sort-order save crashed with an unhandled ReferenceError rather than a
 * handled 500 — a silent break of the Reorder Grid.
 *
 * A missing guard import fails closed (the route 500s rather than letting an
 * unauthenticated caller through), so this is a reliability guard, not a
 * security hole. It is still the kind of fault that unit tests never see,
 * because nothing imports these route modules.
 */

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
const GUARDS = [
  'requireAdminKey',
  'requireOwner',
  'requireCronOrAdminKey',
  'requireAdminOrOrderToken',
];

function adminAuthImportedNames(source) {
  const names = new Set();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/_admin-auth\.js['"]/g;
  let match = importRe.exec(source);
  while (match) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
    match = importRe.exec(source);
  }
  return names;
}

function guardsCalled(source) {
  const called = new Set();
  for (const guard of GUARDS) {
    // A call site, not the import list or the definition itself.
    if (new RegExp(`(?<!function\\s)\\b${guard}\\s*\\(`).test(source)) called.add(guard);
  }
  return called;
}

describe('auth guard imports', () => {
  const files = readdirSync(API_DIR)
    .filter((name) => name.endsWith('.js') && name !== '_admin-auth.js');

  it('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s imports every auth guard it calls', (name) => {
    const source = readFileSync(join(API_DIR, name), 'utf8');
    const imported = adminAuthImportedNames(source);
    const missing = [...guardsCalled(source)].filter((guard) => !imported.has(guard));
    expect(missing, `${name} calls ${missing.join(', ')} without importing it`).toEqual([]);
  });
});
