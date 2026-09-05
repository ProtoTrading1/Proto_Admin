import { requireCronOrAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';

const MAX_CONTACTS = 50000;
const PAGE_SIZE = 500;
const CAMPAIGN_META_FILE = 'crm/brevo-campaign-summary.json';

function getMainClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function brevoFetch(path, { params = {} } = {}) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY not configured');
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.brevo.com/v3${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { 'api-key': key, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Brevo ${res.status}`);
  return json;
}

function readEngagement(attrs = {}) {
  const open = attrs.LAST_OPEN || attrs.last_open || attrs.LAST_OPENED || null;
  const click = attrs.LAST_CLICK || attrs.last_click || attrs.LAST_CLICKED || null;
  const toIso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    lastOpenAt: toIso(open),
    lastClickAt: toIso(click),
  };
}

/** Background sync — curated Brevo subset into crm_contacts. Cron: every 15 min. */
export default async function handler(req, res) {
  if (!(await requireCronOrAdminKey(req, res))) return;
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'BREVO_API_KEY not configured' });

  try {
    const sb = getMainClient();
    const syncedAt = new Date().toISOString();

    let campaignSummary = {
      name: null,
      sentAt: null,
      uniqueOpens: null,
      uniqueClicks: null,
      syncedAt,
    };
    try {
      const campaigns = await brevoFetch('/emailCampaigns', { params: { limit: '5', sort: 'desc' } });
      const latest = campaigns?.campaigns?.[0];
      if (latest) {
        const stats = latest.statistics?.globalStats || {};
        campaignSummary = {
          name: latest.name || null,
          sentAt: latest.sentDate || latest.scheduledAt || null,
          uniqueOpens: stats.uniqueOpens ?? null,
          uniqueClicks: stats.uniqueClicks ?? null,
          syncedAt,
        };
      }
      await writeSiteConfigJson(CAMPAIGN_META_FILE, campaignSummary);
    } catch (err) {
      console.warn('brevo-sync campaigns:', err.message);
    }

    const listPayload = await brevoFetch('/contacts/lists', { params: { limit: '50' } });
    const listMap = new Map((listPayload?.lists || []).map((l) => [l.id, l.name]));

    let offset = 0;
    let upserted = 0;
    let failed = 0;
    const errors = [];
    let truncated = false;

    while (offset < MAX_CONTACTS) {
      const batch = await brevoFetch('/contacts', { params: { limit: String(PAGE_SIZE), offset: String(offset) } });
      const contacts = batch?.contacts || [];
      if (!contacts.length) break;

      const rows = contacts
        .map((c) => {
          const email = String(c.email || '').trim().toLowerCase();
          if (!email) return null;
          const listIds = c.listIds || [];
          const listNames = listIds.map((id) => listMap.get(id)).filter(Boolean);
          const attrs = c.attributes || {};
          const { lastOpenAt, lastClickAt } = readEngagement(attrs);
          const row = {
            brevo_id: c.id,
            email,
            name: [attrs.FIRSTNAME, attrs.LASTNAME].filter(Boolean).join(' ') || attrs.FNAME || null,
            list_ids: listIds,
            list_names: listNames,
            synced_at: syncedAt,
          };
          if (lastOpenAt) row.last_open_at = lastOpenAt;
          if (lastClickAt) row.last_click_at = lastClickAt;
          return row;
        })
        .filter(Boolean);

      if (rows.length) {
        try {
          const { error } = await sb.from('crm_contacts').upsert(rows, { onConflict: 'brevo_id' });
          if (error) throw error;
          upserted += rows.length;
        } catch (err) {
          failed += rows.length;
          errors.push({ offset, message: err.message || String(err), count: rows.length });
          console.error(`brevo-sync batch offset ${offset}:`, err.message || err);
        }
      }

      if (contacts.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      if (offset >= MAX_CONTACTS) {
        truncated = true;
        console.warn(`brevo-sync: truncated at ${MAX_CONTACTS} contacts`);
        break;
      }
    }

    return res.status(200).json({
      ok: true,
      upserted,
      succeeded: upserted,
      failed,
      errors: errors.slice(0, 20),
      truncated,
      maxContacts: MAX_CONTACTS,
      syncedAt,
      campaign: campaignSummary,
    });
  } catch (err) {
    console.error('brevo-sync:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Brevo sync failed' });
  }
}
