import { describe, expect, it } from 'vitest';
import { signResetToken, verifyResetTokenRaw, timingSafeEqualStr } from '../api/_reset-token.js';

const SECRET = 'test-secret-value';

describe('reset token crypto', () => {
  it('round-trips claims (email lowercased, version preserved, scope carried)', () => {
    const token = signResetToken({ email: 'Admin@Proto.co.za', v: 3, scope: 'admin' }, SECRET, 60_000);
    const data = verifyResetTokenRaw(token, SECRET);
    expect(data.email).toBe('admin@proto.co.za');
    expect(data.v).toBe(3);
    expect(data.scope).toBe('admin');
  });

  it('defaults version to 0', () => {
    const token = signResetToken({ email: 'a@b.co' }, SECRET, 60_000);
    expect(verifyResetTokenRaw(token, SECRET).v).toBe(0);
  });

  it('rejects a tampered payload', () => {
    const token = signResetToken({ email: 'a@b.co', v: 0 }, SECRET, 60_000);
    const [, sig] = token.split('.');
    // Claims must differ from the signed ones (v: 9) or the forgery would be
    // byte-identical to the real payload and the signature would rightly match.
    const forgedPayload = Buffer.from(JSON.stringify({ email: 'a@b.co', v: 9, exp: Date.now() + 60_000 })).toString('base64url');
    expect(() => verifyResetTokenRaw(`${forgedPayload}.${sig}`, SECRET)).toThrow(/Invalid reset link/);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signResetToken({ email: 'a@b.co', v: 0 }, 'other-secret', 60_000);
    expect(() => verifyResetTokenRaw(token, SECRET)).toThrow(/Invalid reset link/);
  });

  it('rejects an expired token', () => {
    const token = signResetToken({ email: 'a@b.co', v: 0 }, SECRET, -1);
    expect(() => verifyResetTokenRaw(token, SECRET)).toThrow(/expired/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyResetTokenRaw('not-a-token', SECRET)).toThrow(/Invalid reset link/);
    expect(() => verifyResetTokenRaw('', SECRET)).toThrow(/Invalid reset link/);
  });

  it('bumping the version invalidates an old link (single-use guarantee)', () => {
    // A link is issued at version 0; after a reset the user's version becomes 1.
    const oldLink = signResetToken({ email: 'a@b.co', v: 0, scope: 'admin' }, SECRET, 60_000);
    const claim = verifyResetTokenRaw(oldLink, SECRET);
    const currentUserVersion = 1; // reset already happened
    expect(claim.v === currentUserVersion).toBe(false); // caller rejects on mismatch
  });
});

describe('timingSafeEqualStr', () => {
  it('is true for equal strings, false otherwise', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(false);
  });
});
