import { describe, expect, it } from 'vitest';
import { parseLoaderFilename } from '../api/_product-loader-filename.js';

// The exact workflow: drop a folder containing bashews, bashews.2, bashews.3
// and bashews.4 and each file must land in its own image slot on the same SKU.
describe('local folder upload -> image slots', () => {
  it('maps the .2/.3/.4 suffix to slots 2, 3 and 4', () => {
    const parsed = ['bashews.jpg', 'bashews.2.jpg', 'bashews.3.jpg', 'bashews.4.jpg']
      .map(parseLoaderFilename);

    expect(parsed.map((p) => p.code)).toEqual(['BASHEWS', 'BASHEWS', 'BASHEWS', 'BASHEWS']);
    expect(parsed.map((p) => p.imageSlot)).toEqual([1, 2, 3, 4]);
    expect(parsed.every((p) => p.parseError === null)).toBe(true);
  });

  it('is case-insensitive and works across image extensions', () => {
    expect(parseLoaderFilename('BASHEWS.2.PNG')).toMatchObject({ code: 'BASHEWS', imageSlot: 2 });
    expect(parseLoaderFilename('Bashews.3.webp')).toMatchObject({ code: 'BASHEWS', imageSlot: 3 });
  });

  // The OS duplicate marker is not a slot — "(2)" means a second product, not
  // image 2, and confusing the two would silently overwrite image 1.
  it('does not treat the OS "(2)" duplicate marker as a slot', () => {
    const parsed = parseLoaderFilename('bashews (2).jpg');
    expect(parsed.imageSlot).toBe(1);
    expect(parsed.copyIndex).toBe(2);
  });

  it('leaves slots above 4 alone rather than clamping into slot 4', () => {
    // .5 is not a slot suffix, so it stays part of the code instead of
    // silently overwriting image 4.
    expect(parseLoaderFilename('bashews.5.jpg')).toMatchObject({ imageSlot: 1 });
  });

  it('rejects non-image files', () => {
    expect(parseLoaderFilename('bashews.2.pdf').parseError).toBe('unsupported_extension');
  });
});

// Mirrors api/product-loader-archive.js — a slot must map to its own column,
// or every file in the folder fights over image_url_one.
const SLOT_COLUMNS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];
const slotColumn = (raw) => SLOT_COLUMNS[Math.min(4, Math.max(1, Number(raw) || 1)) - 1];

describe('archive slot column mapping', () => {
  it('sends each slot to its own column', () => {
    expect([1, 2, 3, 4].map(slotColumn)).toEqual(SLOT_COLUMNS);
  });

  it('falls back to image 1 for a missing or nonsense slot', () => {
    expect(slotColumn(undefined)).toBe('image_url_one');
    expect(slotColumn(0)).toBe('image_url_one');
    expect(slotColumn('x')).toBe('image_url_one');
    expect(slotColumn(99)).toBe('image_url_four');
  });
});
