import { describe, expect, it } from 'vitest';
import { getInstorePreviewSafety } from '../api/_instore-preview-safety.js';

const testRef = 'zbxvcdkcarrgtmdhwmdm';
const safe = {
  INSTORE_ADMIN_PREVIEW_ONLY: 'true',
  INSTORE_ADMIN_TEST_PROJECT_REF: testRef,
  STOCK_SUPABASE_URL: `https://${testRef}.supabase.co`,
  STOCK_SUPABASE_KEY: 'test-only-server-key',
  VERCEL_ENV: 'preview',
};

describe('Instore connected-preview safety', () => {
  it('allows only an explicitly named non-production test project', () => {
    expect(getInstorePreviewSafety(safe)).toMatchObject({ ok: true, projectRef: testRef });
  });

  it('keeps the connected Preview read-only until a separate test-write switch is enabled', () => {
    expect(getInstorePreviewSafety(safe).allowTestWrites).toBe(false);
    expect(getInstorePreviewSafety({ ...safe, INSTORE_ADMIN_TEST_WRITES: 'true' }).allowTestWrites).toBe(true);
  });

  it('rejects production deployments and production-looking database URLs', () => {
    expect(getInstorePreviewSafety({ ...safe, VERCEL_ENV: 'production' }).ok).toBe(false);
    expect(getInstorePreviewSafety({ ...safe, STOCK_SUPABASE_URL: 'https://yiqsvwajozafvalwcero.supabase.co' }).ok).toBe(false);
  });

  it('never falls back to a browser-exposed VITE stock URL', () => {
    const env = { ...safe };
    delete env.STOCK_SUPABASE_URL;
    env.VITE_STOCK_SUPABASE_URL = `https://${testRef}.supabase.co`;
    expect(getInstorePreviewSafety(env).ok).toBe(false);
  });
});
