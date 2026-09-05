#!/usr/bin/env node
/**
 * Backfill orders.confirmation_sent_at from site-config orders/confirmation/*.json
 *
 * Usage:
 *   node scripts/backfill-confirmation-sent-at.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readSiteConfigJson } from '../api/_site-config.js';
import { getPortalAdminClient, SITE_CONFIG_BUCKET } from '../api/_site-config.js';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const storage = getPortalAdminClient().storage.from(SITE_CONFIG_BUCKET);

let offset = 0;
let updated = 0;
let skipped = 0;

while (true) {
  const { data, error } = await storage.list('orders/confirmation', { limit: 500, offset });
  if (error) {
    console.error('list error:', error.message);
    process.exit(1);
  }
  if (!data?.length) break;

  for (const file of data) {
    if (!file.name?.endsWith('.json')) continue;
    const orderId = file.name.replace(/\.json$/, '');
    const meta = await readSiteConfigJson(`orders/confirmation/${file.name}`, null);
    const sentAt = meta?.sentAt || meta?.updatedAt;
    if (!sentAt) {
      skipped += 1;
      continue;
    }
    const { error: upErr } = await supabase
      .from('orders')
      .update({ confirmation_sent_at: sentAt })
      .eq('id', orderId)
      .is('confirmation_sent_at', null);
    if (upErr) {
      console.warn(`skip ${orderId}:`, upErr.message);
      skipped += 1;
    } else {
      updated += 1;
    }
  }

  if (data.length < 500) break;
  offset += 500;
}

console.log(`Backfill complete: ${updated} updated, ${skipped} skipped`);
