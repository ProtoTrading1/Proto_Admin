import { describe, expect, it } from 'vitest';
import {
  buildImageProcessingLiveObjectPath,
  buildLiveObjectPath,
} from '../api/_staging-storage.js';

describe('Image Processing Centre storage isolation', () => {
  it('uses a versioned permanent path instead of the shared SKU/slot object', () => {
    const ipcPath = buildImageProcessingLiveObjectPath('SKU 123', 2, 'attempt-123');
    expect(ipcPath).toBe('image-processing/live/SKU_123/s2/attempt-123.jpg');
    expect(ipcPath).not.toBe(buildLiveObjectPath('SKU 123', 2));
    expect(ipcPath).not.toMatch(/^SKU_123\/2\.jpg$/);
  });
});
