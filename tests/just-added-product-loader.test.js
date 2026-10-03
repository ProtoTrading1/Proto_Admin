import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Product Loader creations are automatically marked Just added', async () => {
  const source = await readFile(new URL('../api/product-loader-publish.js', import.meta.url), 'utf8');
  assert.match(source, /const insertRow = \{[\s\S]*is_new_arrival:\s*true/);
  assert.match(source, /justAdded:\s*action === 'create'/);
});

test('Nutstore creations are automatically marked Just added', async () => {
  const source = await readFile(new URL('../api/nutstore-process.js', import.meta.url), 'utf8');
  assert.match(source, /\.insert\(\{[\s\S]*is_new_arrival:\s*true/);
  assert.match(source, /justAdded:\s*action === 'create'/);
});
