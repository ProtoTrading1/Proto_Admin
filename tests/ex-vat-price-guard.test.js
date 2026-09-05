import { describe, expect, it } from 'vitest';
import { looksLikeExVatPrice } from '../lib/catalogue-price.mjs';

// The July 2026 import captured EX-VAT prices where Proto's incl-VAT customer
// prices belong, and 91 live products published at the wrong amount labelled
// "Incl. VAT". The fingerprint: the price is off Proto's .00/.50 grid, but
// ×1.15 lands on it exactly. These cases are the real repaired data.
describe('looksLikeExVatPrice', () => {
  it('flags every price shape from the July import', () => {
    expect(looksLikeExVatPrice(12.61)).toBe(true); // → 14.50 coin purse / key charm
    expect(looksLikeExVatPrice(15.22)).toBe(true); // → 17.50 key charm elephant
    expect(looksLikeExVatPrice(16.09)).toBe(true); // → 18.50 key charm octopus
    expect(looksLikeExVatPrice(18.26)).toBe(true); // → 21.00 XGIFT
    expect(looksLikeExVatPrice(25.65)).toBe(true); // → 29.50 3D toy dragon
    expect(looksLikeExVatPrice(19.57)).toBe(true); // → 22.50 coin purse (cent-rounded input)
    expect(looksLikeExVatPrice(43.04)).toBe(true); // → 49.50 sting ray
    expect(looksLikeExVatPrice(51.74)).toBe(true); // → 59.50 fidget ball
    expect(looksLikeExVatPrice(73.91)).toBe(true); // → 85.00 fidget egg
    expect(looksLikeExVatPrice(503.48)).toBe(true); // → 579.00 leather sling bag
  });

  it('passes correctly captured incl-VAT prices', () => {
    // Anything already on the .00/.50 grid is a legitimate customer price —
    // including ones whose ×1.15 also lands on the grid (R10.00 → R11.50).
    expect(looksLikeExVatPrice(10.0)).toBe(false);
    expect(looksLikeExVatPrice(11.5)).toBe(false);
    expect(looksLikeExVatPrice(14.5)).toBe(false);
    expect(looksLikeExVatPrice(239.5)).toBe(false);
    expect(looksLikeExVatPrice(579.0)).toBe(false);
    // Off-grid prices whose ×1.15 is ALSO off-grid are odd but not the
    // ex-VAT fingerprint — flagging them would cry wolf.
    expect(looksLikeExVatPrice(239.43)).toBe(false);
    expect(looksLikeExVatPrice(12.34)).toBe(false);
  });

  it('never flags missing or nonsense prices', () => {
    expect(looksLikeExVatPrice(0)).toBe(false);
    expect(looksLikeExVatPrice(-14.5)).toBe(false);
    expect(looksLikeExVatPrice(null)).toBe(false);
    expect(looksLikeExVatPrice(undefined)).toBe(false);
    expect(looksLikeExVatPrice('abc')).toBe(false);
  });

  it('survives float-cent artefacts', () => {
    // 16.09 * 115 = 1850.3499999... — integer-cent rounding must still land it.
    expect(looksLikeExVatPrice(16.09)).toBe(true);
    expect(looksLikeExVatPrice(43.48)).toBe(true); // → 50.00 within half a cent
  });
});
