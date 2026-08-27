import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const centreSource = readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');

describe('Image Processing Centre Nutstore handoff safety UX', () => {
  it('explains that restored bead intake choices still need fresh safety confirmation', () => {
    expect(centreSource).toContain('nutstoreSelection.length > 0 && intakeRequiresSafeCutout && !manualSafeCutout');
    expect(centreSource).toContain('Treatment and instructions were restored from your Nutstore handoff.');
    expect(centreSource).toContain('Re-confirm the safety checkbox before adding these images.');
  });
});

