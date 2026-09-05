import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY;
const adminKey = process.env.ADMIN_DASH_KEY;

if (!url || !key) {
  console.log('FAIL: stock Supabase env not injected');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

for (const t of ['image_gen_cost_logs', 'image_gen_batches', 'image_gen_locks']) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
  console.log(`${t}:`, error ? `FAIL — ${error.message}` : `OK (rows: ${count ?? 0})`);
}

if (adminKey) {
  const res = await fetch('https://protoportal-admin.vercel.app/api/image-gen-costs?days=7', {
    headers: { 'x-admin-key': adminKey },
  });
  const json = await res.json();
  if (res.status === 503) console.log('API: FAIL —', json.error);
  else if (!res.ok) console.log('API: FAIL —', json.error);
  else console.log('API: OK —', json.logs?.length ?? 0, 'logs,', json.active?.batches?.length ?? 0, 'batches,', json.active?.locks?.length ?? 0, 'locks');
}
