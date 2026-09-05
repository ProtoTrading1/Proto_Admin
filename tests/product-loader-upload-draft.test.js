import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  clearProductLoaderUploadDraft,
  getProductLoaderUploadDraft,
  getProductLoaderUploadDraftRecovery,
  saveProductLoaderUploadDraft,
} from '../src/lib/productLoaderUploadDraft.js';

const upload = readFileSync(new URL('../src/components/productLoader/ProductLoaderUpload.jsx', import.meta.url), 'utf8');
const draft = readFileSync(new URL('../src/lib/productLoaderUploadDraft.js', import.meta.url), 'utf8');

describe('Product Loader upload draft retention', () => {
  beforeEach(() => {
    const values = new Map();
    globalThis.window = {
      sessionStorage: {
        getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
      },
    };
  });

  afterEach(() => {
    clearProductLoaderUploadDraft();
    delete globalThis.window;
  });

  it('keeps selected files in a local draft across Upload tab remounts', () => {
    expect(upload).toContain('getProductLoaderUploadDraft');
    expect(upload).toContain('saveProductLoaderUploadDraft(items)');
    expect(draft).toContain('memoryDraft = items');
  });

  it('shows recovery and a deliberate discard state without publishing', () => {
    expect(upload).toContain('Upload draft saved in this browser');
    expect(upload).toContain('it was never published');
    expect(upload).toContain('Discard draft');
  });

  it('clears the draft after completed publish or archive actions', () => {
    expect(upload).toContain('clearDraftAfterCompleteAction');
    expect(upload).toContain('clearDraftIfEveryRowFinished(new Set(ready.map((row) => row.filename)))');
    expect(upload).toContain('clearDraftIfEveryRowFinished(new Set(rows.map((row) => row.filename)))');
  });

  it('does not clear a mixed upload draft after a partial group action', () => {
    expect(upload).toContain('function isDraftRowFinished(row)');
    expect(upload).toContain('completedFilenames.has(row.filename) || isDraftRowFinished(row)');
    expect(upload).toContain('!isDraftRowFinished(i) && i.file && i.code && !i.parseError');
  });

  it('stores a recoverable session marker and clears it explicitly', () => {
    const items = [{ filename: 'qa one.jpg' }, { filename: 'qa two.png' }];

    saveProductLoaderUploadDraft(items);

    expect(getProductLoaderUploadDraft()).toBe(items);
    expect(getProductLoaderUploadDraftRecovery()).toEqual({
      count: 2,
      filenames: ['qa one.jpg', 'qa two.png'],
    });

    clearProductLoaderUploadDraft();

    expect(getProductLoaderUploadDraft()).toBeNull();
    expect(getProductLoaderUploadDraftRecovery()).toBeNull();
  });
});
