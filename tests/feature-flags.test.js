import { describe, expect, it } from 'vitest';
import { FEATURE_DEFAULTS, normalizeFeatureFlags } from '../api/_feature-flags.js';

describe('normalizeFeatureFlags', () => {
  it('defaults every flag to off', () => {
    expect(normalizeFeatureFlags(null)).toEqual(FEATURE_DEFAULTS);
    expect(normalizeFeatureFlags({})).toEqual(FEATURE_DEFAULTS);
    expect(Object.values(FEATURE_DEFAULTS).every((v) => v === false)).toBe(true);
  });

  it('reads a flag that is on', () => {
    expect(normalizeFeatureFlags({ multiPlacement: true }).multiPlacement).toBe(true);
  });

  // A malformed store must not accidentally switch a feature ON.
  it('coerces non-boolean values to false rather than truthy', () => {
    expect(normalizeFeatureFlags({ multiPlacement: 'true' }).multiPlacement).toBe(false);
    expect(normalizeFeatureFlags({ multiPlacement: 1 }).multiPlacement).toBe(false);
    expect(normalizeFeatureFlags({ multiPlacement: {} }).multiPlacement).toBe(false);
  });

  it('ignores unknown keys', () => {
    const flags = normalizeFeatureFlags({ somethingElse: true });
    expect(flags.somethingElse).toBeUndefined();
    expect(flags).toEqual(FEATURE_DEFAULTS);
  });

  it('never mutates the caller object', () => {
    const input = { multiPlacement: true };
    normalizeFeatureFlags(input);
    expect(input).toEqual({ multiPlacement: true });
  });

  it('survives a non-object store', () => {
    expect(normalizeFeatureFlags('nope')).toEqual(FEATURE_DEFAULTS);
    expect(normalizeFeatureFlags([])).toEqual(FEATURE_DEFAULTS);
  });
});
