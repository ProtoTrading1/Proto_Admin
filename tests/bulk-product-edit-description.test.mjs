import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDescriptionToAllRows } from '../src/lib/bulkProductEdit.js';

test('bulk product description control copies the draft description without changing other fields', () => {
  const rows = [
    { sku: 'CAR-RED', description: 'Red racing car', code: '8987890055' },
    { sku: 'CAR-BLUE', description: 'Blue racing car', code: '8987890056' },
  ];

  assert.deepEqual(applyDescriptionToAllRows(rows, 'Metal die-cast racing car'), [
    { sku: 'CAR-RED', description: 'Metal die-cast racing car', code: '8987890055' },
    { sku: 'CAR-BLUE', description: 'Metal die-cast racing car', code: '8987890056' },
  ]);
  assert.equal(rows[1].description, 'Blue racing car');
});
