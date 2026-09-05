import { createClient } from '@supabase/supabase-js';
import { requireOwner } from './_admin-auth.js';
import { isSqlConfigured } from './_sql-provider.js';
import { nutstoreBasename, parseNutstoreFilename } from './_nutstore-filename.js';
import { isPathInLibrary } from './_nutstore-webdav.js';
import {
  classifyBatchItem,
  getCachedDormantSkuSet,
  resolveProductLoaderMatch,
} from './_product-loader-lookup.js';

const MAX_PATHS = 100;
const LOOKUP_CONCURRENCY = 8;

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function parseOnePath(rawPath) {
  const path = String(rawPath || '').trim();
  if (!isPathInLibrary(path)) {
    return { path, filename: nutstoreBasename(path), parseError: 'outside_library', parsed: null };
  }
  const filename = nutstoreBasename(path);
  const parsed = parseNutstoreFilename(filename);
  if (parsed.parseError || !parsed.code) {
    return { path, filename, parseError: parsed.parseError || 'no_code', parsed: null };
  }
  return { path, filename, parseError: null, parsed };
}

function invalidFilenameItem({ path, filename, parseError }) {
  return {
    path,
    filename,
    code: '',
    title: '',
    price: 0,
    imageSlot: 1,
    warnings: ['invalid_filename'],
    parseError: parseError || null,
    websiteStatus: 'not_found',
    group: 'not_found',
  };
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { paths, purpose } = req.body || {};
  const forImageProcessing = purpose === 'image_processing';
  if (!Array.isArray(paths) || !paths.length) {
    return res.status(400).json({ error: 'paths[] required (Nutstore file paths)' });
  }
  if (paths.length > MAX_PATHS) {
    return res.status(400).json({ error: `Maximum ${MAX_PATHS} paths per lookup (got ${paths.length})` });
  }

  const sb = getStockClient();
  const dormantSkus = await getCachedDormantSkuSet(sb).catch(() => new Set());

  // Pre-parse filenames so we can dedup lookups by SKU.
  const parsedRows = paths.map(parseOnePath);

  // Dedup lookups by filename stem so compound codes share one resolve pass.
  const codeGroups = new Map(); // upperStem → [{ idx, displayCode }]
  for (let i = 0; i < parsedRows.length; i += 1) {
    const { parsed } = parsedRows[i];
    if (!parsed?.code) continue;
    const stem = String(parsed.displayCode || parsed.code || '').trim();
    const lookupKey = stem.toUpperCase();
    if (!lookupKey) continue;
    if (!codeGroups.has(lookupKey)) codeGroups.set(lookupKey, []);
    codeGroups.get(lookupKey).push({ idx: i, displayCode: stem });
  }

  const uniqueStems = [...codeGroups.keys()];
  const matchByStem = new Map();
  await mapPool(uniqueStems, LOOKUP_CONCURRENCY, async (lookupKey) => {
    const group = codeGroups.get(lookupKey) || [];
    const displayCode = group[0]?.displayCode || lookupKey;
    const match = await resolveProductLoaderMatch(sb, {
      code: displayCode,
      fullCode: parsedRows[group[0]?.idx]?.parsed?.fullCode || null,
      displayCode,
      imageSlot: parsedRows[group[0]?.idx]?.parsed?.imageSlot || 1,
      dormantSkus,
      strictExact: forImageProcessing,
    });
    matchByStem.set(lookupKey, match);
  });

  const items = parsedRows.map((row) => {
    if (row.parseError || !row.parsed) return invalidFilenameItem(row);
    const stem = String(row.parsed.displayCode || row.parsed.code || '').trim().toUpperCase();
    const match = matchByStem.get(stem);
    if (!match) return invalidFilenameItem({ ...row, parseError: 'lookup_failed' });
    const group = classifyBatchItem(match);
    return {
      path: row.path,
      filename: row.filename,
      ...match,
      imageSlot: row.parsed.imageSlot || 1,
      group,
      // The Image Processing Centre must never queue an image against a
      // fuzzy title/barcode match or a non-existent website SKU. The original
      // Nutstore file stays in place; this only grants permission to queue it.
      canQueue: !forImageProcessing || Boolean(
        match.websiteRow
        && match.matchedBy === 'code'
        && String(match.websiteRow.sku || '').trim().toUpperCase() === String(match.code || '').trim().toUpperCase(),
      ),
      queueBlocker: forImageProcessing && !(match.websiteRow && match.matchedBy === 'code')
        ? 'An exact existing website SKU is required before this image can enter the processing queue.'
        : null,
    };
  });

  let matched = 0;
  const groups = { ready: 0, needs_review: 0, not_found: 0 };
  for (const item of items) {
    if (item.canPublish) matched += 1;
    groups[item.group] = (groups[item.group] || 0) + 1;
  }

  return res.status(200).json({
    items,
    summary: {
      total: items.length,
      matched,
      ready: groups.ready,
      needsReview: groups.needs_review,
      notFound: groups.not_found,
      sqlConfigured: isSqlConfigured(),
    },
  });
}
