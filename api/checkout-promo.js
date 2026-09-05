import { requireAdminKey } from './_admin-auth.js';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';

const FILE = 'checkout-promo.json';
// The portal validates checkout codes against promo-codes.json
// (Proto-Website- api/_promo-codes.js: { codes: [{ code, discountPct,
// active, label }] }) — every save must mirror into that file or codes
// are rejected at checkout.
const PORTAL_PROMO_FILE = 'promo-codes.json';
const DEFAULTS = {
  active: true,
  code: 'PROTO75',
  percent: 7.5,
  label: '7.5% off your order',
  // The portal validator honours both of these; they were never sent, so a
  // minimum order or an end date could not be set from the admin at all.
  minOrder: 0,
  expiresAt: '',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const data = await readSiteConfigJson(FILE, DEFAULTS);
      return res.status(200).json({ ...DEFAULTS, ...data });
    } catch {
      return res.status(200).json(DEFAULTS);
    }
  }

  if (req.method === 'POST') {
    if (!(await requireAdminKey(req, res))) return;
    try {
      const body = req.body || {};
      // Use the supplied percent when it's a real number (including a
      // deliberate 0) — `Number(body.percent) || DEFAULTS.percent` turned 0
      // into 7.5%. Only fall back to the default when it's missing/invalid.
      const rawPercent = Number(body.percent);
      const percent = Number.isFinite(rawPercent) ? Math.min(50, Math.max(0, rawPercent)) : DEFAULTS.percent;
      const rawMin = Number(body.minOrder);
      const minOrder = Number.isFinite(rawMin) && rawMin > 0 ? Math.round(rawMin * 100) / 100 : 0;
      // Empty string = no expiry. An unparseable date is treated as no expiry
      // rather than silently expiring the code the moment it is saved.
      const rawExpiry = String(body.expiresAt || '').trim();
      const expiresAt = rawExpiry && !Number.isNaN(Date.parse(rawExpiry)) ? rawExpiry : '';
      const promo = {
        active: Boolean(body.active),
        code: String(body.code || DEFAULTS.code).trim().toUpperCase(),
        percent,
        label: String(body.label || DEFAULTS.label).trim(),
        minOrder,
        expiresAt,
        updatedAt: new Date().toISOString(),
      };
      const saved = await writeSiteConfigJson(FILE, promo);
      // Mirror into the portal's validator file so the code actually works
      // at checkout — checkout-promo.json alone is never read by the portal.
      await writeSiteConfigJson(PORTAL_PROMO_FILE, {
        codes: [{
          code: promo.code,
          discountPct: promo.percent,
          active: promo.active,
          label: promo.label,
          minOrder: promo.minOrder,
          ...(promo.expiresAt ? { expiresAt: promo.expiresAt } : {}),
        }],
      });
      return res.status(200).json({ ok: true, ...saved });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
