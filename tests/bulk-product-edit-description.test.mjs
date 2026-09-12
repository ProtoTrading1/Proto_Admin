import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDescriptionToAllRows, applyTitleToAllRows } from '../src/lib/bulkProductEdit.js';

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

test('bulk product name control copies the draft name without changing other fields', () => {
  const rows = [
    { sku: 'CURTAIN-RED', title: 'Party foil curtain red', description: 'Red curtain' },
    { sku: 'CURTAIN-GOLD', title: 'Party foil curtain gold', description: 'Gold curtain' },
  ];

  assert.deepEqual(applyTitleToAllRows(rows, 'Party foil curtain'), [
    { sku: 'CURTAIN-RED', title: 'Party foil curtain', description: 'Red curtain' },
    { sku: 'CURTAIN-GOLD', title: 'Party foil curtain', description: 'Gold curtain' },
  ]);
  assert.equal(rows[1].title, 'Party foil curtain gold');
});
