import { describe, expect, it } from 'vitest';
import { parseNutstoreFilename } from '../api/_nutstore-filename.js';
import { readFileSync } from 'node:fs';

describe('Nutstore Image Processing Centre intake', () => {
  it('preserves explicit image slots while retaining the full SKU for exact matching', () => {
    expect(parseNutstoreFilename('BASHEWS.3.jpg')).toMatchObject({
      code: 'BASHEWS', fullCode: 'BASHEWS.3', imageSlot: 3, parseError: null,
    });
  });

  it('keeps a real dot-suffixed SKU available for exact-match-first lookup', () => {
    expect(parseNutstoreFilename('MKT822662.2.webp')).toMatchObject({
      fullCode: 'MKT822662.2', imageSlot: 2,
    });
  });

  it('requires strict exact website matching for Image Processing queue eligibility', () => {
    const source = readFileSync(new URL('../api/nutstore-batch-lookup.js', import.meta.url), 'utf8');
    expect(source).toContain("purpose === 'image_processing'");
    expect(source).toContain('strictExact: forImageProcessing');
    expect(source).toContain('canQueue: !forImageProcessing || Boolean(');
    expect(source).toContain('imageSlot: row.parsed.imageSlot || 1');
  });
});
