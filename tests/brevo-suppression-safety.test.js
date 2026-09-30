import { afterEach, describe, expect, it, vi } from 'vitest';
import { excludeBrevoSuppressedRecipients, listBrevoSuppressedContacts } from '../api/_brevo-suppression.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const response = (contacts, count = contacts.length) => ({ ok: true, status: 200, json: async () => ({ contacts, count }) });
describe('complete Brevo suppression checks', () => {
  it('excludes global opt-outs case-insensitively, even absent from Proto records', async () => {
    vi.stubEnv('BREVO_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([{ email: 'Stop@Example.test', emailBlacklisted: true }])));
    expect(await excludeBrevoSuppressedRecipients([{ email: 'stop@example.test' }, { email: 'keep@example.test' }]))
      .toEqual([{ email: 'keep@example.test' }]);
  });
  it('fails closed on a lookup error rather than returning unfiltered recipients', async () => {
    vi.stubEnv('BREVO_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    await expect(excludeBrevoSuppressedRecipients([{ email: 'keep@example.test' }])).rejects.toThrow('Brevo 503');
  });
  it('refuses a truncated list above the scan limit', async () => {
    vi.stubEnv('BREVO_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([], 50001)));
    await expect(listBrevoSuppressedContacts()).rejects.toThrow('complete suppression-check limit');
  });
  it('refuses a malformed or incomplete response', async () => {
    vi.stubEnv('BREVO_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([], 1)));
    await expect(listBrevoSuppressedContacts()).rejects.toThrow('incomplete');
  });
  it('backs off on 429 then completes, without retrying indefinitely', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BREVO_API_KEY', 'test-only');
    const spy = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '1' }, json: async () => ({}) })
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', spy);
    const result = listBrevoSuppressedContacts();
    await vi.runAllTimersAsync();
    expect(await result).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
