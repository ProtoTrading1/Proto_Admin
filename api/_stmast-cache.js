import { getStockClient } from './_stock-client.js';

function normalizeTitle(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function searchCacheByTitle(title, { limit = 8 } = {}) {
  const sb = getStockClient();
  const term = String(title || '').trim();
  if (!sb || !term) return [];

  const safe = term.replace(/[%_]/g, '').slice(0, 80);
  const { data } = await sb
    .from('stmast_cache')
    .select('code, descr')
    .ilike('descr', `%${safe}%`)
    .limit(limit);

  return (data || []).map((row) => ({
    code: String(row.code || '').trim().toUpperCase(),
    title: String(row.descr || '').trim(),
  })).filter((row) => row.code);
}

export function scoreTitleMatch(query, title) {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1000;
  const tokens = q.split(' ').filter((w) => w.length > 2);
  let score = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) score += tok.length;
  }
  return score;
}

export async function fetchFromCache(code) {
  const sb = getStockClient();
  const { data } = await sb
    .from('stmast_cache')
    .select('code, descr, price_a, onhand, booked, dept')
    .eq('code', code)
    .maybeSingle();
  if (!data) return null;
  const onhand = Number(data.onhand) || 0;
  const booked = Number(data.booked) || 0;
  return {
    code: String(data.code || '').trim(),
    title: String(data.descr ?? '').trim(),
    price: Number(data.price_a) || 0,
    onhand,
    booked,
    available: onhand - booked,
    dept: data.dept || '',
  };
}
