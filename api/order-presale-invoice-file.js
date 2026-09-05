import { requireAdminKey } from './_admin-auth.js';
import { getPortalAdminClient, SITE_CONFIG_BUCKET } from './_site-config.js';

function metaPath(orderId) {
  return `orders/presale/${orderId}.json`;
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const orderId = String(req.query?.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const supabase = getPortalAdminClient();
  const { data: metaBlob, error: metaError } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(metaPath(orderId));
  if (metaError) return res.status(404).json({ error: 'No presale invoice uploaded' });

  const meta = JSON.parse(await metaBlob.text());
  const { data: fileBlob, error: fileError } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(meta.storagePath);
  if (fileError) return res.status(404).json({ error: 'Presale file missing' });

  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  return res.status(200).json({
    filename: meta.filename || `presale-invoice-${orderId}.pdf`,
    contentType: meta.contentType || 'application/pdf',
    base64: buffer.toString('base64'),
  });
}
