import { isNutstoreImageName } from './_nutstore-filename.js';
import {
  formatNutstoreError,
  getCachedDirectory,
  isNutstoreRateLimitError,
  pacedNutstoreFetch,
  setCachedDirectory,
} from './_nutstore-rate-limit.js';

const DEFAULT_WEBDAV_URL = 'https://dav.jianguoyun.com/dav/';
/** Only this Nutstore folder is exposed in Product Loader. */
export const DEFAULT_LIBRARY_ROOT = '/PTR-photos';

function decodeDisplayName(name) {
  return String(name || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

export function libraryRoot() {
  const raw = String(
    process.env.NUTSTORE_PHOTOS_ROOT || process.env.NUTSTORE_ROOT_PATH || DEFAULT_LIBRARY_ROOT,
  ).trim();
  return normalizeDavPath(raw || DEFAULT_LIBRARY_ROOT);
}

/** Keep browse/download inside the PTR Photos library tree. */
export function clampToLibrary(requestedPath) {
  const root = libraryRoot();
  const path = normalizeDavPath(requestedPath || root);
  if (path === root || path.startsWith(`${root}/`)) return path;
  return root;
}

export function isPathInLibrary(path) {
  const root = libraryRoot();
  const p = normalizeDavPath(path);
  return p === root || p.startsWith(`${root}/`);
}

function nutstoreConfig() {
  const baseUrl = String(process.env.NUTSTORE_WEBDAV_URL || DEFAULT_WEBDAV_URL).trim().replace(/\/+$/, '') + '/';
  const user = String(
    process.env.NUTSTORE_USER || process.env.NUTSTORE_WEBDAV_USER || '',
  ).trim();
  const password = String(
    process.env.NUTSTORE_APP_PASSWORD || process.env.NUTSTORE_WEBDAV_PASSWORD || '',
  ).trim();
  const rootPath = libraryRoot();
  return { baseUrl, user, password, rootPath };
}

export function isNutstoreConfigured() {
  const { user, password } = nutstoreConfig();
  return Boolean(user && password);
}

export function nutstoreSetupMessage() {
  if (isNutstoreConfigured()) return null;
  return 'Set NUTSTORE_USER + NUTSTORE_APP_PASSWORD (or NUTSTORE_WEBDAV_USER + NUTSTORE_WEBDAV_PASSWORD) on Vercel.';
}

function authHeader() {
  const { user, password } = nutstoreConfig();
  if (!user || !password) throw new Error(nutstoreSetupMessage());
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Normalize to /path/form without trailing slash (except root). */
export function normalizeDavPath(path) {
  let p = String(path || '/').trim();
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

function joinDavPath(...parts) {
  const joined = parts
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
  return normalizeDavPath(joined.startsWith('/') ? joined : `/${joined}`);
}

function davUrlForPath(path, { directory = false } = {}) {
  const { baseUrl } = nutstoreConfig();
  const normalized = normalizeDavPath(path);
  const encoded = normalized
    .split('/')
    .map((seg, i) => (i === 0 && !seg ? '' : encodeURIComponent(seg)))
    .join('/');
  let url = `${baseUrl}${encoded.startsWith('/') ? encoded.slice(1) : encoded}`;
  if (directory && !url.endsWith('/')) url += '/';
  return url;
}

function decodeHref(href) {
  try {
    return decodeURIComponent(String(href || '').trim());
  } catch {
    return String(href || '').trim();
  }
}

function hrefToDavPath(href) {
  const raw = decodeHref(href);
  const { baseUrl } = nutstoreConfig();
  let path = raw;
  if (path.startsWith(baseUrl)) path = path.slice(baseUrl.length);
  if (path.startsWith('/dav/')) path = path.slice(4);
  if (!path.startsWith('/')) path = `/${path}`;
  return normalizeDavPath(path);
}

function getTag(block, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function isCollection(block) {
  return /<(?:\w+:)?collection\b/i.test(block);
}

function parsePropfindResponse(xml) {
  const responses = [];
  const blocks = xml.match(/<(?:\w+:)?response[\s\S]*?<\/(?:\w+:)?response>/gi) || [];
  for (const block of blocks) {
    const href = getTag(block, 'href');
    if (!href) continue;
    const displayname = getTag(block, 'displayname') || '';
    const lastmod = getTag(block, 'getlastmodified') || '';
    const lenRaw = getTag(block, 'getcontentlength') || '0';
    const contentType = getTag(block, 'getcontenttype') || '';
    const size = Number.parseInt(lenRaw, 10) || 0;
    const path = hrefToDavPath(href);
    const name = decodeDisplayName(displayname) || path.split('/').pop() || '';
    const isDir = isCollection(block);
    responses.push({
      href,
      requestHref: href,
      path,
      name,
      type: isDir ? 'dir' : 'file',
      size,
      contentType,
      modified: lastmod,
      isImage: !isDir && isNutstoreImageName(name),
    });
  }
  return responses;
}

function extractNextLink(linkHeader) {
  const raw = String(linkHeader || '');
  const m = raw.match(/<([^>]+)>;\s*rel="next"/i);
  if (!m) return null;
  let url = m[1].trim();
  try {
    // Nutstore pagination URLs double-encode spaces (%2520). Decode once for fetch.
    url = decodeURIComponent(url);
  } catch {
    /* use raw url */
  }
  return url;
}

async function propfindOnce(url) {
  const res = await pacedNutstoreFetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:">
  <prop>
    <displayname/>
    <resourcetype/>
    <getlastmodified/>
    <getcontentlength/>
    <getcontenttype/>
  </prop>
</propfind>`,
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Nutstore PROPFIND failed (${res.status}): ${text.slice(0, 200)}`);
    if (res.status === 503) err.code = 'NUTSTORE_RATE_LIMIT';
    throw err;
  }
  return { entries: parsePropfindResponse(text), nextUrl: extractNextLink(res.headers.get('link') || res.headers.get('Link')) };
}

function davUrlForHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const { baseUrl } = nutstoreConfig();
  let path = raw;
  if (path.startsWith('/dav/')) path = path.slice(4);
  const encoded = path.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/');
  let url = `${baseUrl}${encoded.startsWith('/') ? encoded.slice(1) : encoded}`;
  if (!url.endsWith('/') && !/\.[a-z0-9]+$/i.test(url)) url += '/';
  return url;
}

export async function listNutstoreDirectory(requestPath = '/', { useCache = true, requestHref = null } = {}) {
  const path = clampToLibrary(requestPath);
  if (useCache) {
    const cached = getCachedDirectory(path);
    if (cached) return { path, entries: cached, cached: true };
  }

  const url = requestHref
    ? davUrlForHref(requestHref)
    : davUrlForPath(path, { directory: true });
  const all = [];
  let currentUrl = url;

  while (currentUrl) {
    const { entries, nextUrl } = await propfindOnce(currentUrl);
    for (const entry of entries) {
      if (entry.path === path) continue;
      all.push(entry);
    }
    currentUrl = nextUrl;
  }

  all.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  setCachedDirectory(path, all);
  return { path, entries: all, cached: false };
}

export async function listNutstoreImagesRecursive(requestPath = '/') {
  const path = clampToLibrary(requestPath);
  const images = [];
  const queue = [path];
  const seen = new Set();
  const MAX_DIRS = 80;

  while (queue.length && seen.size < MAX_DIRS) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);

    try {
      const { entries } = await listNutstoreDirectory(dir);
      for (const entry of entries) {
        if (entry.type === 'dir') {
          if (seen.size + queue.length < MAX_DIRS) queue.push(entry.path);
        } else if (entry.isImage) {
          images.push(entry);
        }
      }
    } catch (err) {
      if (isNutstoreRateLimitError(err)) throw err;
      // skip unreadable folders
    }
  }

  images.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return { path, images, count: images.length, truncated: queue.length > 0 || seen.size >= MAX_DIRS };
}

export async function downloadNutstoreFile(path) {
  const normalized = normalizeDavPath(path);
  if (!isPathInLibrary(normalized)) {
    throw new Error('Path is outside the PTR Photos library');
  }
  const url = davUrlForPath(normalized);
  const res = await pacedNutstoreFetch(url, {
    method: 'GET',
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Nutstore download failed (${res.status}): ${text.slice(0, 120)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || guessContentType(normalized);
  return { buffer, contentType, path: normalized, filename: normalized.split('/').pop() || 'image.jpg' };
}

function guessContentType(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export async function testNutstoreConnection() {
  const rootPath = libraryRoot();
  const cached = getCachedDirectory(rootPath);
  if (cached) {
    return { ok: true, rootPath, libraryRoot: rootPath, libraryLabel: 'PTR Photos', cached: true };
  }
  await listNutstoreDirectory(rootPath, { useCache: true });
  return { ok: true, rootPath, libraryRoot: rootPath, libraryLabel: 'PTR Photos', cached: false };
}

export { joinDavPath, nutstoreConfig, libraryRoot as nutstoreLibraryRoot, formatNutstoreError, isNutstoreRateLimitError };
