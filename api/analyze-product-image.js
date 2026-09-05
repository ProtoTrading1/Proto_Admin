import { requireOwner } from './_admin-auth.js';
import {
  extractImageGenMeta,
  fetchUsdToZarRate,
  getStockClient,
  logImageGenCost,
  resolveImageGenCost,
} from './_image-gen-cost.js';
import { assertImageGenBudgetAllowsSpend } from './_image-gen-budget.js';
// Gemini Flash vision analysis — metadata only, no storage.
// Frontend calls upload-product-image separately for the actual image URL.

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

const MODEL = 'google/gemini-2.5-flash';
const IMAGE_TOKEN_ESTIMATE = 350;

const CATEGORIES = [
  'Arts Crafts & Stationery',
  'Beads Jewellery & Accessories',
  'Beauty & Personal Care',
  'Events & Parties',
  'Fashion & Accessories',
  'Food & Drinks',
  'Hardware',
  'Homeware & Kitchen',
  'Packaging',
  'Textiles',
  'Toys Games & Kids',
];

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { filename, contentType, base64 } = req.body || {};
  if (!filename || !contentType || !base64) {
    return res.status(400).json({ error: 'filename, contentType, and base64 are required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });

  const sb = getStockClient();
  try {
    await assertImageGenBudgetAllowsSpend(sb);
  } catch (err) {
    if (err.code === 'IMAGE_GEN_BUDGET_EXCEEDED') {
      return res.status(402).json({ error: err.message, budget: err.budgetStatus });
    }
    throw err;
  }

  const t0 = Date.now();

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://admin.proto.co.za',
      'X-Title': 'ProtoPortal Admin',
    },
    body: JSON.stringify({
      model: MODEL,
      usage: { include: true },
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } },
          {
            type: 'text',
            text: `You are a wholesale e-commerce product analyst. Analyze this product image and return ONLY valid JSON — no markdown, no extra text:
{
  "title": "concise product title, 3–6 words",
  "category": "pick exactly one: ${CATEGORIES.join(' | ')}",
  "description": "one sentence describing the product for a trade buyer"
}`,
          },
        ],
      }],
      max_tokens: 250,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    return res.status(502).json({ error: `Gemini error ${response.status}: ${txt.slice(0, 200)}` });
  }

  const json = await response.json();
  const usage = json.usage || {};
  const tokensIn = usage.prompt_tokens || IMAGE_TOKEN_ESTIMATE;
  const tokensOut = usage.completion_tokens || 80;
  const { costUsd, costSource } = resolveImageGenCost({
    model: MODEL,
    tokensIn,
    tokensOut,
    costUsd: usage.cost != null ? Number(usage.cost) : null,
    isImageOutput: false,
  });
  const usdToZar = await fetchUsdToZarRate();
  const costZar = parseFloat((costUsd * usdToZar).toFixed(4));
  const { operator, batchId } = extractImageGenMeta(req);
  const sku = String(filename || '').replace(/\.[^.]+$/, '').trim();

  await logImageGenCost(getStockClient(), {
    sku: sku || null,
    operation: 'analyze',
    model: MODEL,
    tokensIn,
    tokensOut,
    costUsd,
    costSource,
    costZar,
    usdToZar,
    processingMs: Date.now() - t0,
    operator,
    batchId,
    status: 'ok',
  });

  const raw = json.choices?.[0]?.message?.content ?? '';
  const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? (raw.find((c) => c.type === 'text')?.text ?? '') : '');

  let title = '';
  let category = '';
  let description = '';
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      title = String(parsed.title || '').trim();
      category = String(parsed.category || '').trim();
      description = String(parsed.description || '').trim();
    }
  } catch {
    // leave empty
  }

  return res.status(200).json({
    title,
    category,
    description,
    tokensIn,
    tokensOut,
    cost: costUsd,
    costUsd,
    costZar,
    usdToZar,
    model: MODEL,
    processingMs: Date.now() - t0,
  });
}
