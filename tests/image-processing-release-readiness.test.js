import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptUrl = new URL('../scripts/check-image-processing-release-env.mjs', import.meta.url);
const legacyImageRouteSource = fs.readFileSync(
  new URL('../api/bulk-image-replace.js', import.meta.url),
  'utf8',
);
const vercelConfig = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

function runCheck(environment, overrides = {}) {
  return spawnSync(process.execPath, [fileURLToPath(scriptUrl), `--environment=${environment}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NUTSTORE_USER: '',
      NUTSTORE_APP_PASSWORD: '',
      NUTSTORE_WEBDAV_USER: '',
      NUTSTORE_WEBDAV_PASSWORD: '',
      ...overrides,
    },
  });
}

describe('Image Processing Centre release configuration', () => {
  it('runs the Nutstore environment check in the Vercel build gate', () => {
    expect(vercelConfig.buildCommand).toContain('node scripts/check-image-processing-release-env.mjs');
    expect(vercelConfig.buildCommand).toContain('npm run build');
  });

  it('retires the legacy direct image mutation API at the server boundary', () => {
    expect(legacyImageRouteSource).toContain("res.status(410).json");
    expect(legacyImageRouteSource).toContain("replacement: '/api/image-processing-jobs'");
    expect(legacyImageRouteSource).not.toContain('.storage');
    expect(legacyImageRouteSource).not.toContain('.update(');
    expect(legacyImageRouteSource).not.toContain('.upload(');
  });

  it('blocks a Preview release when the approved Nutstore variable names are absent', () => {
    const result = runCheck('preview');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('preview release blocked');
    expect(result.stderr).toContain('NUTSTORE_USER');
    expect(result.stderr).toContain('NUTSTORE_APP_PASSWORD');
  });

  it('accepts the preferred variables in Production without printing their values', () => {
    const user = 'release-check-user-value';
    const password = 'release-check-password-value';
    const result = runCheck('production', {
      NUTSTORE_USER: user,
      NUTSTORE_APP_PASSWORD: password,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('production Nutstore variable names are present');
    expect(`${result.stdout}${result.stderr}`).not.toContain(user);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
  });

  it('accepts the documented legacy aliases', () => {
    const result = runCheck('preview', {
      NUTSTORE_WEBDAV_USER: 'legacy-user',
      NUTSTORE_WEBDAV_PASSWORD: 'legacy-password',
    });
    expect(result.status).toBe(0);
  });
});
