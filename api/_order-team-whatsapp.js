import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';

/**
 * "Team notified on WhatsApp" state for an order.
 *
 * Stored in site-config rather than component state so the green tag survives
 * a refresh and is visible to every admin — not just whoever clicked send.
 */

export function teamWhatsappPath(orderId) {
  return `orders/team-whatsapp/${orderId}.json`;
}

export async function readTeamWhatsappSent(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return null;
  const data = await readSiteConfigJson(teamWhatsappPath(id), null);
  if (!data || typeof data !== 'object') return null;
  return data.sentAt ? data : null;
}

export async function writeTeamWhatsappSent(orderId, payload) {
  const id = String(orderId || '').trim();
  if (!id) return null;
  const record = { orderId: id, ...payload };
  await writeSiteConfigJson(teamWhatsappPath(id), record);
  return record;
}

/** Status for many orders at once — the list renders a tag per row. */
export async function readTeamWhatsappSentMany(orderIds = []) {
  const ids = [...new Set(orderIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const entries = await Promise.all(ids.map(async (id) => {
    try {
      return [id, await readTeamWhatsappSent(id)];
    } catch {
      // One unreadable record must not blank the tag on every other row.
      return [id, null];
    }
  }));
  const out = {};
  for (const [id, value] of entries) if (value) out[id] = value;
  return out;
}
