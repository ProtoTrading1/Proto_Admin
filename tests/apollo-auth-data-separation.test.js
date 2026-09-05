import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const authClient = readFileSync(new URL('../src/lib/supabaseAuth.js', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/lib/auth.js', import.meta.url), 'utf8');
const adminKey = readFileSync(new URL('../src/lib/adminKey.js', import.meta.url), 'utf8');
const serverAuth = readFileSync(new URL('../api/_admin-auth.js', import.meta.url), 'utf8');

describe('Apollo preview auth/data separation', () => {
  it('supports auth-only Supabase variables with a safe fallback', () => {
    expect(authClient).toContain('VITE_ADMIN_AUTH_SUPABASE_URL');
    expect(authClient).toContain('VITE_ADMIN_AUTH_SUPABASE_ANON_KEY');
    expect(authClient).toContain('|| import.meta.env.VITE_SUPABASE_URL');
  });

  it('uses the auth client for browser sessions and bearer headers', () => {
    expect(auth).toContain("from './supabaseAuth'");
    expect(auth).not.toContain("from './supabase'");
    expect(adminKey).toContain("from './supabaseAuth'");
    expect(adminKey).not.toContain("from './supabase'");
  });

  it('allows server JWT verification to use auth-only variables', () => {
    expect(serverAuth).toContain('process.env.ADMIN_AUTH_SUPABASE_URL || process.env.VITE_SUPABASE_URL');
    expect(serverAuth).toContain('process.env.ADMIN_AUTH_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY');
  });
});
