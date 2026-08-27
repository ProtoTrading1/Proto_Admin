import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNutstoreFilename } from '../api/_nutstore-filename.js';

const processSource = readFileSync(new URL('../api/nutstore-process.js', import.meta.url), 'utf8');

describe('Nutstore colour and slot safety', () => {
  it('preserves a colour SKU and explicit slot in the Nutstore parser', () => {
    expect(parseNutstoreFilename('8640000171-BLU.jpg')).toMatchObject({
      code: '8640000171-BLU',
      displayCode: '8640000171-BLU',
      imageSlot: 1,
    });
    expect(parseNutstoreFilename('8640000171-BLU.2.jpg')).toMatchObject({
      code: '8640000171-BLU',
      displayCode: '8640000171-BLU',
      imageSlot: 2,
    });
  });

  it('keeps direct Nutstore writes slot-aware and checks the row before upload', () => {
    expect(processSource).toContain('const slot = slotNumber(item.imageSlot);');
    expect(processSource).toContain('const imageField = slotField(slot);');
    expect(processSource).toContain('if (existing?.[imageField] && !shouldOverwrite)');
    expect(processSource).toContain('uploadImageBuffer(sb, { sku, slot, filename, buffer, contentType });');
    expect(processSource).toContain('[slotField(slot)]: imageUrl');
    expect(processSource).not.toContain('uploadImageBuffer(sb, { sku, slot: 1,');
  });
});
