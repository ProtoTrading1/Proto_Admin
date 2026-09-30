import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDescriptionToAllRows, applySharedFieldsToAllRows } from '../src/lib/bulkProductEdit.js';

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

test('shared bulk fields change only filled-in fields and leave original rows untouched', () => {
  const rows = [
    { sku: 'GERMOL-5ALOE', title: 'Aloe soap', description: 'Aloe description', code: 'GERMOL' },
    { sku: 'GERMOL-4MENTHOL', title: 'Menthol soap', description: 'Menthol description', code: 'GERMOL' },
  ];

  assert.deepEqual(applySharedFieldsToAllRows(rows, { title: ' Germol soap ', description: '' }), [
    { sku: 'GERMOL-5ALOE', title: 'Germol soap', description: 'Aloe description', code: 'GERMOL' },
    { sku: 'GERMOL-4MENTHOL', title: 'Germol soap', description: 'Menthol description', code: 'GERMOL' },
  ]);
  assert.deepEqual(applySharedFieldsToAllRows(rows, { title: '', description: 'Shared soap description' }), [
    { sku: 'GERMOL-5ALOE', title: 'Aloe soap', description: 'Shared soap description', code: 'GERMOL' },
    { sku: 'GERMOL-4MENTHOL', title: 'Menthol soap', description: 'Shared soap description', code: 'GERMOL' },
  ]);
  assert.equal(rows[0].title, 'Aloe soap');
});
