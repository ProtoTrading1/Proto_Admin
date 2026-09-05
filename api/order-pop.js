import { requireAdminKey } from './_admin-auth.js';
import { readSiteConfigJson, writeSiteConfigJson, getPortalAdminClient, SITE_CONFIG_BUCKET } from './_site-config.js';

function metaPath(orderId) {
  return `orders/pop/${orderId}.json`;
}

function filePath(orderId, ext) {
  return `orders/pop/${orderId}${ext}`;
}

async function readMeta(supabase, orderId) {
  const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(metaPath(orderId));
  if (error) return null;
  return JSON.parse(await data.text());
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  const supabase = getPortalAdminClient();
  await supabase.storage.createBucket(SITE_CONFIG_BUCKET, { public: false }).catch(() => {});

  if (req.method === 'GET') {
    const ids = String(req.query?.ids || req.query?.id || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'id or ids required' });

    const out = {};
    await Promise.all(ids.map(async (orderId) => {
      const meta = await readMeta(supabase, orderId);
      if (meta) out[orderId] = meta;
    }));
    return res.status(200).json({ pops: out });
  }

  if (req.method === 'POST') {
    const {
      orderId,
      fileBase64,
      filename = 'proof-of-payment.pdf',
      contentType = 'application/pdf',
      paid = true,
    } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const ext = filename.includes('.') ? `.${filename.split('.').pop()}` : '.pdf';
    const meta = {
      orderId,
      filename,
      contentType,
      paid: Boolean(paid),
      uploadedAt: new Date().toISOString(),
      storagePath: filePath(orderId, ext),
    };

    if (fileBase64) {
      const buffer = Buffer.from(String(fileBase64), 'base64');
      const { error: uploadError } = await supabase.storage
        .from(SITE_CONFIG_BUCKET)
        .upload(meta.storagePath, buffer, { contentType, upsert: true });
      if (uploadError) return res.status(500).json({ error: uploadError.message });
    }

    const { error: metaError } = await supabase.storage
      .from(SITE_CONFIG_BUCKET)
      .upload(metaPath(orderId), JSON.stringify(meta), { contentType: 'application/json', upsert: true });
    if (metaError) return res.status(500).json({ error: metaError.message });

    return res.status(200).json({ ok: true, ...meta });
  }

  if (req.method === 'PATCH') {
    const { orderId, paid } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    const existing = await readMeta(supabase, orderId) || { orderId };
    const meta = { ...existing, paid: Boolean(paid), updatedAt: new Date().toISOString() };
    await supabase.storage.from(SITE_CONFIG_BUCKET).upload(
      metaPath(orderId),
      JSON.stringify(meta),
      { contentType: 'application/json', upsert: true },
    );
    return res.status(200).json({ ok: true, ...meta });
  }

  return res.status(405).end();
}
