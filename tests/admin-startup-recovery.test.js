import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OperationTimeoutError, withTimeout } from '../src/lib/asyncTimeout';

const rootSource = readFileSync(new URL('../src/Root.jsx', import.meta.url), 'utf8');
const authCheckSource = readFileSync(new URL('../api/auth-check.js', import.meta.url), 'utf8');

describe('admin startup recovery', () => {
  it('returns a completed session check before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ready'), 100, 'too slow')).resolves.toBe('ready');
  });

  it('ends a stalled session check instead of leaving the dashboard loading forever', async () => {
    vi.useFakeTimers();
    const stalled = new Promise(() => {});
    const result = withTimeout(stalled, 10_000, 'Session check timed out', 'admin_session_timeout');
    const rejection = expect(result).rejects.toMatchObject({
      name: 'OperationTimeoutError',
      code: 'admin_session_timeout',
      message: 'Session check timed out',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    vi.useRealTimers();
  });

  it('exposes a distinct timeout error for recovery UI', () => {
    expect(new OperationTimeoutError('slow', 'startup_slow')).toMatchObject({
      name: 'OperationTimeoutError',
      code: 'startup_slow',
    });
  });

  it('offers retry and sign-out actions when startup fails', () => {
    expect(rootSource).toContain('Dashboard didn’t load');
    expect(rootSource).toContain('Retry');
    expect(rootSource).toContain('Sign out');
    expect(rootSource).toContain('proto_admin_last_startup_failure');
  });

  it('does not repeat the server-side Supabase user verification', () => {
    expect(authCheckSource.match(/verifyAdminUser\(req\)/g)).toHaveLength(1);
  });
});
