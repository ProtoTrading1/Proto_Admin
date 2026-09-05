import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const adminPage = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');

function headerValue(name, source = '/(.*)') {
  const rule = vercel.headers.find((item) => item.source === source);
  return rule?.headers.find((header) => header.key.toLowerCase() === name.toLowerCase())?.value || '';
}

describe('admin response hardening', () => {
  it('sets a deny-by-default CSP with explicit anti-framing', () => {
    const csp = headerValue('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headerValue('X-Frame-Options')).toBe('DENY');
  });

  it('sets browser security and privacy headers', () => {
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerValue('Permissions-Policy')).toContain('camera=()');
    expect(headerValue('Strict-Transport-Security')).toContain('max-age=63072000');
  });

  it('does not publish wildcard CORS on the admin document', () => {
    expect(headerValue('Access-Control-Allow-Origin', '/((?!api/|assets/).*)')).toBe('https://admin.proto.co.za');
    expect(JSON.stringify(vercel.headers)).not.toContain('"value":"*"');
  });
});

describe('admin keyboard and motion safety', () => {
  it('provides a skip link and keyboard-focus target', () => {
    expect(adminPage).toContain('href="#admin-main"');
    expect(adminPage).toContain('id="admin-main"');
    expect(css).toContain(':focus-visible');
  });

  it('honours reduced-motion preferences', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: 0.01ms !important');
  });
});
