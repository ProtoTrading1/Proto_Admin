import { describe, expect, it } from 'vitest';
import { INTAKE_IMAGE_ACCEPT, inspectIntakeImageSelection } from '../src/lib/intakeImageSelection.js';
import { parseLoaderFilename } from '../api/_product-loader-filename.js';

describe('Product Loader supported image selection', () => {
  it('accepts only filename formats understood by the backend, even without MIME', () => {
    const files = ['A.jpg', 'B.JPEG', 'C.PNG', 'D.webp'].map((name) => ({ name, type: '' }));
    expect(inspectIntakeImageSelection(files).accepted).toEqual(files);
    expect(INTAKE_IMAGE_ACCEPT).toBe('.jpg,.jpeg,.png,.webp');
    for (const file of files) expect(parseLoaderFilename(file.name).parseError).not.toBe('unsupported_extension');
  });
  it('rejects SVG/HEIC/GIF despite image MIME with conversion guidance, not SKU advice', () => {
    const result = inspectIntakeImageSelection([
      { name: '8620200200.svg', type: 'image/svg+xml' },
      { name: '8620200201.heic', type: '' },
      { name: '8620200202.gif', type: 'image/gif' },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(3);
    expect(result.message).toContain('Convert to JPG, PNG or WebP');
    expect(result.message).toContain('current batch has not been changed');
    expect(result.message).not.toContain('SKU');
  });
  it('keeps valid images in mixed folders and ignores folder metadata', () => {
    const valid = { name: '8620200200.png', type: 'image/png' };
    const result = inspectIntakeImageSelection([valid, { name: 'bad.svg', type: 'image/svg+xml' }, { name: 'desktop.ini', type: '' }]);
    expect(result.accepted).toEqual([valid]);
    expect(result.rejected).toHaveLength(1);
    expect(result.message).toContain('Supported images will still be checked');
  });
  it('does not accept a fake image MIME on unsupported filename', () => {
    expect(inspectIntakeImageSelection([{ name: 'photo.exe', type: 'image/png' }]).accepted).toHaveLength(0);
  });
});
