import { requireAdminKey } from './_admin-auth.js';
import { WatiNotConfiguredError, watiCrmConfig, watiListTemplates } from './_wati-client.js';

/**
 * Approved WhatsApp templates, for the broadcast composer.
 *
 * Only APPROVED templates can be used: a draft or rejected template is accepted
 * by the send call and then silently delivers nothing, which looks identical to
 * a successful broadcast until someone asks why nobody replied.
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const { configured } = watiCrmConfig();
  if (!configured) {
    return res.status(200).json({
      templates: [],
      configured: false,
      message: 'WATI is not connected. Set WATI_API_TOKEN in Vercel to load your approved templates.',
    });
  }

  try {
    const all = await watiListTemplates();
    const approved = all.filter((t) => t.status === 'APPROVED');
    return res.status(200).json({
      configured: true,
      templates: approved,
      // Surfaced so the composer can say "3 templates are still pending
      // approval" instead of showing an unexplained short list.
      unavailable: all.filter((t) => t.status !== 'APPROVED').map((t) => ({ name: t.name, status: t.status })),
    });
  } catch (err) {
    if (err instanceof WatiNotConfiguredError) {
      return res.status(200).json({ templates: [], configured: false, message: err.message });
    }
    console.error('whatsapp-templates:', err?.message || err);
    return res.status(502).json({ error: err.message || 'Could not load WATI templates' });
  }
}
