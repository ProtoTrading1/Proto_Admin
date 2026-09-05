import { requireAdminKey } from './_admin-auth.js';
import { getPortalAdminClient, SITE_CONFIG_BUCKET } from './_site-config.js';

/**
 * Issues a signed upload URL so the browser can PUT the generated order
 * confirmation PDF straight to storage. This bypasses Vercel's 4.5 MB request
 * body limit — large PDFs (many product images) used to 413 when the base64 was
 * inlined in the send-order-email request body. send-order-email then downloads
 * the PDF from `path` server-side and attaches it.
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const supabase = getPortalAdminClient();
  await supabase.storage.createBucket(SITE_CONFIG_BUCKET, { public: false }).catch(() => {});

  const path = `orders/confirmation-pdf/${orderId}.pdf`;
  const { data, error } = await supabase.storage
    .from(SITE_CONFIG_BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ path, token: data.token, signedUrl: data.signedUrl });
}
