import { describe, expect, it } from 'vitest';
import {
  clearPendingNutstoreHandoff,
  IMAGE_PROCESSING_HANDOFF_KEY,
  loadImageProcessingIntake,
  loadPendingNutstoreHandoff,
  saveImageProcessingIntake,
  savePendingNutstoreHandoff,
} from '../src/lib/imageProcessingHandoff.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe('Image Processing Centre Nutstore handoff persistence', () => {
  it('restores an exact pending selection after navigation or refresh', () => {
    const storage = memoryStorage();
    savePendingNutstoreHandoff([
      { path: '/PTR-photos/101/ABC-1.jpg', filename: 'ABC-1.jpg' },
      { path: '/PTR-photos/101/ABC-1.jpg', filename: 'duplicate.jpg' },
    ], { storage, now: 1_000 });

    expect(loadPendingNutstoreHandoff({ storage, now: 2_000 })).toEqual([
      { path: '/PTR-photos/101/ABC-1.jpg', filename: 'ABC-1.jpg' },
    ]);
  });

  it('expires stale selections instead of silently resurfacing them later', () => {
    const storage = memoryStorage();
    savePendingNutstoreHandoff([{ path: '/PTR-photos/OLD.jpg' }], {
      storage,
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(loadPendingNutstoreHandoff({ storage, now: 61_001 })).toEqual([]);
    expect(storage.getItem(IMAGE_PROCESSING_HANDOFF_KEY)).toBeNull();
  });

  it('clears the shared handoff only after successful consumption', () => {
    const storage = memoryStorage();
    savePendingNutstoreHandoff([{ path: '/PTR-photos/READY.jpg' }], { storage, now: 1_000 });
    clearPendingNutstoreHandoff({ storage });

    expect(loadPendingNutstoreHandoff({ storage, now: 2_000 })).toEqual([]);
  });

  it('retains the selected treatment and instructions across the Nutstore round-trip', () => {
    const storage = memoryStorage();
    saveImageProcessingIntake({
      treatment: 'beads_fine_detail',
      instructions: 'Preserve every label and number.',
    }, { storage });

    expect(loadImageProcessingIntake({ storage })).toEqual({
      treatment: 'beads_fine_detail',
      instructions: 'Preserve every label and number.',
    });
  });
});
