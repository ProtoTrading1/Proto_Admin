/** Shared pacing + cache for Nutstore WebDAV (rate limit: ~600 req / 30 min). */

const MIN_GAP_MS = 350;
const CACHE_TTL_MS = 120_000;
const MAX_RETRIES = 3;

let lastRequestAt = 0;
const directoryCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNutstoreRateLimitError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('503')
    || /BlockedTemporarily/i.test(msg)
    || /Too many requests/i.test(msg);
}

export function formatNutstoreError(err) {
  if (isNutstoreRateLimitError(err)) {
    return 'Nutstore is temporarily blocking requests (too many in a short period). Wait 2–5 minutes, then click Retry. Avoid opening multiple admin tabs on this page.';
  }
  const msg = String(err?.message || err || 'Nutstore request failed');
  if (msg.includes('ObjectNotFound') || msg.includes('404')) {
    return 'Nutstore could not list that folder (pagination or path error). Click PTR Photos home and try again, or pick a different subfolder.';
  }
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}

export function getCachedDirectory(path) {
  const hit = directoryCache.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    directoryCache.delete(path);
    return null;
  }
  return hit.data;
}

export function setCachedDirectory(path, data) {
  directoryCache.set(path, { at: Date.now(), data });
}

export async function pacedNutstoreFetch(url, init) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const now = Date.now();
    const wait = Math.max(0, MIN_GAP_MS - (now - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await fetch(url, init);

    if (res.status === 503) {
      const peek = await res.clone().text().catch(() => '');
      if (/BlockedTemporarily|Too many requests/i.test(peek)) {
        if (attempt < MAX_RETRIES) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        const err = new Error(`Nutstore rate limit (503): ${peek.slice(0, 120)}`);
        err.code = 'NUTSTORE_RATE_LIMIT';
        throw err;
      }
    }

    return res;
  }
  throw new Error('Nutstore request failed after retries');
}
