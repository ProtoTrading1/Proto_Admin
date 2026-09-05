import { requireAdminKey } from './_admin-auth.js';
import { getPortalAdminClient, SITE_CONFIG_BUCKET } from './_site-config.js';

function metaPath(orderId) {
  return `orders/presale/${orderId}.json`;
}

function filePath(orderId, ext) {
  return `orders/presale/${orderId}${ext}`;
}

async function readMeta(supabase, orderId) {
  const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(metaPath(orderId));
  if (error) return null;
  const text = await data.text();
  return JSON.parse(text);
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
    return res.status(200).json({ invoices: out });
  }

  if (req.method === 'POST') {
    const { orderId, fileBase64, filename = 'presale-invoice.pdf', contentType = 'application/pdf' } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 required' });

    const ext = filename.includes('.') ? `.${filename.split('.').pop()}` : '.pdf';
    const buffer = Buffer.from(String(fileBase64), 'base64');
    const storagePath = filePath(orderId, ext);

    const { error: uploadError } = await supabase.storage
      .from(SITE_CONFIG_BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: true });
    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const meta = {
      orderId,
      filename,
      storagePath,
      contentType,
      uploadedAt: new Date().toISOString(),
    };
    const { error: metaError } = await supabase.storage
      .from(SITE_CONFIG_BUCKET)
      .upload(metaPath(orderId), JSON.stringify(meta), { contentType: 'application/json', upsert: true });
    if (metaError) return res.status(500).json({ error: metaError.message });

    return res.status(200).json({ ok: true, ...meta });
  }

  if (req.method === 'DELETE') {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    const meta = await readMeta(supabase, orderId);
    if (meta?.storagePath) {
      await supabase.storage.from(SITE_CONFIG_BUCKET).remove([meta.storagePath]);
    }
    await supabase.storage.from(SITE_CONFIG_BUCKET).remove([metaPath(orderId)]);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
