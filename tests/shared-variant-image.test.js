import { describe, expect, it } from 'vitest';
import { planSharedVariantImage } from '../src/lib/sharedVariantImage.js';

describe('explicit shared family image', () => {
  it('plans exact Positill variants without inventing the unsuffixed product', () => {
    expect(planSharedVariantImage('8626000775', '8626000775.jpg', '8626000775B, 8626000775H 8626000775M;8626000775P 8626000775U'))
      .toEqual(['B', 'H', 'M', 'P', 'U'].map((suffix) => ({ code: `8626000775${suffix}`, filename: `8626000775${suffix}.jpg` })));
  });
  it('accepts a second family-photo filename but requires deliberate selection', () => {
    expect(planSharedVariantImage('8626000775', '8626000775-1.jpg', '8626000775B')).toHaveLength(1);
  });
  it('blocks unrelated, duplicate, or already staged variants', () => {
    expect(() => planSharedVariantImage('8626000775', '8626000775.jpg', '8626000776B')).toThrow(/this ten-digit code/);
    expect(() => planSharedVariantImage('8626000775', '8626000775.jpg', '8626000775B,8626000775B')).toThrow(/only once/);
    expect(() => planSharedVariantImage('8626000775', '8626000775.jpg', '8626000775B', ['8626000775B'])).toThrow(/already in this batch/);
    expect(() => planSharedVariantImage('8626000775', 'unrelated.jpg', '8626000775B')).toThrow(/does not match/);
  });
});
