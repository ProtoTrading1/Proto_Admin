import { Jimp, HorizontalAlign, VerticalAlign, cssColorToHex } from 'jimp';
import { buildStagingObjectPath } from './_staging-storage.js';
import { getStockClient } from './_stock-client.js';

const BUCKET = 'product-images';

/** Strongest OpenRouter image model — override with OPENROUTER_IMAGE_MODEL env. */
export const DEFAULT_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3-pro-image-preview';
export const FAST_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL_FAST || 'google/gemini-2.5-flash-image';

export const IMAGE_STYLES = {
  standard: 'standard',
  shadow: 'shadow',
  generative: 'generative',
  measurements: 'measurements',
};

/** Pull dimension hints from product description for measurement overlay style. */
export function extractMeasurementsFromDescription(text = '') {
  const src = String(text || '');
  const hits = [];
  const patterns = [
    /\b(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*(cm|mm|m|in|inch|inches|"|')\b/gi,
    /\b(L|W|H|D|length|width|height|depth)[:\s]+(\d+(?:\.\d+)?)\s*(cm|mm|m|in|inch|inches)?\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(cm|mm|m|in|inch|inches)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*["']\s*(?:L|W|H|long|wide|high|tall|dia|diameter)\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      hits.push(m[0].trim());
      if (hits.length >= 8) break;
    }
    if (hits.length >= 8) break;
  }
  return hits.length ? [...new Set(hits)].join('; ') : null;
}

const FIX_PROMPT = `Transform this into a professional wholesale e-commerce product photo.
Remove the background and place the product on a pure white (#FFFFFF) background.
Center the product with even padding. Preserve the exact product, colours, and shape.
No text, watermarks, or extra props. Clean catalogue-style square product shot.`;

export function resolveImageModel(imageStyle = 'standard', targetSlot = 1) {
  const style = imageStyle || IMAGE_STYLES.standard;
  const slot = Math.min(4, Math.max(1, Number(targetSlot) || 1));
  if (style === IMAGE_STYLES.generative || style === IMAGE_STYLES.measurements) {
    return DEFAULT_IMAGE_MODEL;
  }
  if (slot === 1) {
    return DEFAULT_IMAGE_MODEL;
  }
  if (style === IMAGE_STYLES.standard || style === IMAGE_STYLES.shadow) {
    return FAST_IMAGE_MODEL;
  }
  return DEFAULT_IMAGE_MODEL;
}

export function describeImageModel(imageStyle = 'standard', targetSlot = 1) {
  const model = resolveImageModel(imageStyle, targetSlot);
  return model.includes('flash') ? 'Gemini Flash Image' : 'Gemini 3 Pro Image';
}

export function inferImageStyle(userInstructions = '', userQuery = '') {
  const text = `${userQuery} ${userInstructions}`.toLowerCase();
  if (/generative|painting on|kids?['']?s?\s+painting|kid painting|artwork on|art on the canvas|on the canvas|lifestyle scene|show.*canvas|canvas.*paint|styled scene|creative|painting displayed/i.test(text)) {
    return IMAGE_STYLES.generative;
  }
  if (/\bshadow\b|drop shadow|soft shadow|with shadows/i.test(text)) {
    return IMAGE_STYLES.shadow;
  }
  return IMAGE_STYLES.standard;
}

function wantsShadow(text) {
  return /\bshadow/i.test(String(text || '').toLowerCase());
}

const SLOT_ANGLE_HINTS = {
  1: 'Front-facing hero shot — product centred, straight-on primary catalogue view.',
  2: 'Three-quarter (45°) angle — rotate the product to show depth and one side clearly.',
  3: 'Side profile (90°) — product viewed from the left or right, full silhouette visible.',
  4: 'Alternate view — back, top-down, or detail/feature angle; pick what best shows this product.',
};

function slotAngleNote(targetSlot) {
  const slot = Math.min(4, Math.max(1, Number(targetSlot) || 1));
  const hint = SLOT_ANGLE_HINTS[slot] || SLOT_ANGLE_HINTS[1];
  if (slot === 1) {
    return `\nCamera angle (required): ${hint}`;
  }
  return `\n*** MULTI-ANGLE SET — IMAGE ${slot} OF 4 ***
Camera angle (required): ${hint}
You MUST render a visibly different viewpoint from the source photo — rotate the product in 3D space. Same product identity (shape, branding, colours), different camera angle. Do NOT copy the source photo's framing.`;
}

/** Build prompt for OpenRouter image model from style + admin instructions. */
export function buildImagePrompt({
  style = IMAGE_STYLES.standard,
  userInstructions = '',
  productTitle = '',
  productDescription = '',
  targetSlot = 1,
  hasReferenceImage = false,
} = {}) {
  const custom = String(userInstructions || '').trim();
  const productCtx = productTitle
    ? `\nProduct name: "${productTitle}". Keep this exact product — same shape, branding, colours, and proportions as the source photo.`
    : '';
  const slotNote = slotAngleNote(targetSlot);

  if (style === IMAGE_STYLES.measurements) {
    const dims = extractMeasurementsFromDescription(productDescription);
    const dimBlock = dims
      ? `Render clean, professional measurement/dimension lines and labels on the image using these dimensions from the product description: ${dims}. Use thin grey or black lines with clear numeric labels — catalogue technical style.`
      : 'If no explicit dimensions are available, add subtle generic size reference lines only where clearly inferable from the product — otherwise focus on a clean white-background product shot with soft shadow.';
    const base = custom || 'Remove the background and isolate the product.';
    return `${base}${productCtx}${slotNote}

Place the product on a pure white (#FFFFFF) background with a soft, realistic drop shadow beneath it.
${dimBlock}

Preserve exact product colours and shape. Measurement annotations must be legible and not obscure the product. No watermarks. Square 1:1 composition.`;
  }

  if (style === IMAGE_STYLES.generative) {
    const direction = custom || 'Place the product on a pure white background, clearly in view, professional catalogue quality.';
    const shadowNote = wantsShadow(`${custom} ${productTitle}`)
      ? '- Include a soft, realistic studio drop shadow beneath the product on the white background (subtle contact shadow + gentle ambient shadow).\n'
      : '';
    const refNote = hasReferenceImage
      ? '- A **reference image** is provided as the second image — match its style, composition, lighting, and creative treatment while preserving the real product from the first (source) image.\n'
      : '';
    return `You are an expert product photographer and generative image editor for wholesale e-commerce.${productCtx}${slotNote}

CREATIVE DIRECTION — follow precisely:
${direction}

RULES:
${refNote}
- The source photo is the ground truth for the product itself — preserve identity, branding, colours, and proportions.
- You MAY synthesize scene elements when the direction asks (e.g. a colourful kids painting displayed on a canvas, props, lighting) as long as the product remains accurate.
- Professional catalogue hero shot; product must be clearly visible and the hero of the frame.
- Clean pure white (#FFFFFF) studio background unless the direction explicitly asks for something else.
${shadowNote}- Square 1:1 composition. No watermarks, no garbled text, no distorted logos.`;
  }

  if (style === IMAGE_STYLES.shadow) {
    const base = custom || 'Remove the background and isolate the product.';
    return `${base}${productCtx}${slotNote}

Place the product on a pure white (#FFFFFF) background with a soft, realistic drop shadow beneath it — subtle contact shadow plus gentle ambient shadow, as in a professional studio shot. Shadow must look natural (not harsh, oversized, or floating). Centre the product with even padding. Preserve exact product colours and shape. No text or watermarks.`;
  }

  if (custom) {
    return `${custom}${productCtx}${slotNote}

Additional requirements: remove distracting backgrounds, preserve exact product shape and colours, no text or watermarks. Pure white (#FFFFFF) background, product centred with even padding.`;
  }

  return `${FIX_PROMPT}${productCtx}${slotNote}`;
}

function getStockAdminClient() {
  // Keep the image processor on the same server-side stock client as the
  // review-job API. That permits the private STOCK_SUPABASE_* variables and
  // avoids a queue that works while processing fails due to a VITE_* mismatch.
  return getStockClient();
}

function getOpenRouterKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
  return key;
}

function guessContentType(url, buffer) {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  return 'image/jpeg';
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Model returned an invalid image data URL');
  return { buffer: Buffer.from(m[2], 'base64'), contentType: m[1] || 'image/png' };
}

function extractGeneratedImage(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) throw new Error('No model response');

  for (const image of message.images || []) {
    const url = image?.image_url?.url || image?.imageUrl?.url;
    if (url) return parseDataUrl(url);
  }

  const parts = Array.isArray(message.content) ? message.content : [];
  for (const part of parts) {
    if (part?.type === 'image_url' && part.image_url?.url) {
      return parseDataUrl(part.image_url.url);
    }
  }

  if (typeof message.content === 'string' && message.content.includes('data:image')) {
    const m = message.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return parseDataUrl(m[0]);
  }

  throw new Error('Model did not return an image — try again or check OPENROUTER_IMAGE_MODEL');
}

function resolveTemperature(imageStyle, targetSlot = 1) {
  const slot = Math.min(4, Math.max(1, Number(targetSlot) || 1));
  const angleBoost = slot > 1 ? 0.12 : 0;
  if (imageStyle === IMAGE_STYLES.generative) return 0.45 + angleBoost;
  if (imageStyle === IMAGE_STYLES.shadow) return 0.35 + angleBoost;
  if (imageStyle === IMAGE_STYLES.measurements) return 0.25 + angleBoost;
  return 0.2 + angleBoost;
}

/** Fit on 800×800 white canvas — matches New Products client compress. */
export async function resizeTo800White(buffer) {
  const image = await Jimp.read(buffer);
  image.contain({
    w: 800,
    h: 800,
    align: HorizontalAlign.CENTER | VerticalAlign.MIDDLE,
    background: cssColorToHex('#ffffffff'),
  });
  return image.getBuffer('image/jpeg');
}

export async function fetchImageBuffer(imageUrl) {
  const raw = String(imageUrl || '').split(',')[0].trim();
  if (!raw) throw new Error('No image URL');

  let lastErr = null;
  for (const url of [raw, encodeURI(raw)]) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('Empty image');
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || guessContentType(url, buf);
      return { buffer: buf, contentType, filename: url.split('/').pop() || 'product.jpg', base64: buf.toString('base64') };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr?.message || 'Could not download image');
}

export async function transformWithOpenRouter(base64, contentType, {
  prompt = FIX_PROMPT,
  model = DEFAULT_IMAGE_MODEL,
  imageStyle = IMAGE_STYLES.standard,
  referenceBase64 = null,
  referenceContentType = 'image/jpeg',
  targetSlot = 1,
} = {}) {
  const apiKey = getOpenRouterKey();
  const safeType = contentType || 'image/jpeg';
  const usePro = String(model).includes('gemini-3-pro');

  const content = [
    { type: 'image_url', image_url: { url: `data:${safeType};base64,${base64}` } },
  ];
  if (referenceBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${referenceContentType || 'image/jpeg'};base64,${referenceBase64}` },
    });
  }
  content.push({ type: 'text', text: prompt });

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://admin.proto.co.za',
      'X-Title': 'Proto Image Gen',
    },
    body: JSON.stringify({
      model,
      modalities: ['image', 'text'],
      usage: { include: true },
      messages: [{
        role: 'user',
        content,
      }],
      image_config: {
        aspect_ratio: '1:1',
        ...(usePro ? { image_size: '2K' } : {}),
      },
      max_tokens: 2048,
      temperature: resolveTemperature(imageStyle, targetSlot),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenRouter ${response.status}`);
  }

  const generated = extractGeneratedImage(payload);
  const usage = payload.usage || {};
  const costUsd = usage.cost != null && Number.isFinite(Number(usage.cost))
    ? Number(usage.cost)
    : null;
  return {
    ...generated,
    model,
    tokensIn: usage.prompt_tokens || 0,
    tokensOut: usage.completion_tokens || 0,
    costUsd,
  };
}

export async function uploadTransformedImage(buffer, filename, contentType = 'image/png', {
  staging = false,
  stagingPath = '',
  sku,
  slot,
} = {}) {
  const supabase = getStockAdminClient();
  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  const requestedStagingPath = String(stagingPath || '').trim();
  if (requestedStagingPath && !requestedStagingPath.startsWith('staging/')) {
    throw new Error('stagingPath must remain inside staging storage');
  }
  const safeName = staging
    ? (requestedStagingPath || buildStagingObjectPath(sku, slot))
    : `gen-${Date.now()}-${String(filename || 'product').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '')}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(safeName, buffer, { contentType, upsert: false });
  if (error) throw new Error(error.message);

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(safeName);
  if (staging) return { url: publicUrl, storagePath: safeName };
  return publicUrl;
}

/**
 * Full pipeline: download → Gemini image gen → 800×800 white canvas → upload.
 */
export async function fixImageFromUrl(imageUrl, {
  sku = 'product',
  prompt,
  imageStyle = IMAGE_STYLES.standard,
  userInstructions = '',
  productTitle = '',
  productDescription = '',
  referenceImageUrl = null,
  targetSlot = 1,
  staging = false,
  stagingPath = '',
} = {}) {
  const style = imageStyle || IMAGE_STYLES.standard;
  let refBase64 = null;
  let refType = 'image/jpeg';
  if (referenceImageUrl && style === IMAGE_STYLES.generative) {
    const ref = await fetchImageBuffer(referenceImageUrl);
    refBase64 = ref.base64;
    refType = ref.contentType;
  }
  const finalPrompt = prompt || buildImagePrompt({
    style,
    userInstructions,
    productTitle,
    productDescription,
    targetSlot,
    hasReferenceImage: !!refBase64,
  });
  const model = resolveImageModel(style, targetSlot);

  const { base64, contentType } = await fetchImageBuffer(imageUrl);
  const transformed = await transformWithOpenRouter(base64, contentType, {
    prompt: finalPrompt,
    model,
    imageStyle: style,
    referenceBase64: refBase64,
    referenceContentType: refType,
    targetSlot,
  });
  const resized = await resizeTo800White(transformed.buffer);
  const uploadResult = await uploadTransformedImage(
    resized,
    `${sku}-s${targetSlot}.jpg`,
    'image/jpeg',
    { staging, stagingPath, sku, slot: targetSlot },
  );
  const url = typeof uploadResult === 'string' ? uploadResult : uploadResult.url;
  return {
    url,
    storagePath: typeof uploadResult === 'object' ? uploadResult.storagePath : null,
    model: transformed.model,
    tokensIn: transformed.tokensIn,
    tokensOut: transformed.tokensOut,
    costUsd: transformed.costUsd,
    imageStyle: style,
  };
}

/** Preview-only sibling of fixImageFromUrl for authenticated Nutstore files.
 * The source buffer is never written back to a product; only the generated
 * result is saved to a dated staging object. */
export async function fixImageFromBuffer(buffer, contentType, filename = 'product.jpg', {
  sku = 'product',
  prompt,
  imageStyle = IMAGE_STYLES.standard,
  targetSlot = 1,
  staging = false,
  stagingPath = '',
} = {}) {
  if (!buffer?.length) throw new Error('No source image data');
  const style = imageStyle || IMAGE_STYLES.standard;
  const finalPrompt = prompt || buildImagePrompt({ style, targetSlot });
  const transformed = await transformWithOpenRouter(Buffer.from(buffer).toString('base64'), contentType || 'image/jpeg', {
    prompt: finalPrompt,
    model: resolveImageModel(style, targetSlot),
    imageStyle: style,
    targetSlot,
  });
  const resized = await resizeTo800White(transformed.buffer);
  const uploadResult = await uploadTransformedImage(resized, filename, 'image/jpeg', {
    staging,
    stagingPath,
    sku,
    slot: targetSlot,
  });
  return {
    url: typeof uploadResult === 'string' ? uploadResult : uploadResult.url,
    storagePath: typeof uploadResult === 'object' ? uploadResult.storagePath : null,
    model: transformed.model,
    tokensIn: transformed.tokensIn,
    tokensOut: transformed.tokensOut,
    costUsd: transformed.costUsd,
    imageStyle: style,
  };
}

/** New Products upload — accepts raw base64 from browser compression. */
export async function fixImageFromBase64(base64, contentType, filename = 'product.jpg', {
  imageStyle = IMAGE_STYLES.standard,
  userInstructions = '',
  productTitle = '',
} = {}) {
  const style = imageStyle || IMAGE_STYLES.standard;
  const finalPrompt = buildImagePrompt({ style, userInstructions, productTitle });
  const model = resolveImageModel(style, 1);

  const transformed = await transformWithOpenRouter(base64, contentType, {
    prompt: finalPrompt,
    model,
    imageStyle: style,
  });
  const resized = await resizeTo800White(transformed.buffer);
  const uploadResult = await uploadTransformedImage(resized, filename.replace(/\.[^.]+$/, '') + '.jpg', 'image/jpeg');
  const url = typeof uploadResult === 'string' ? uploadResult : uploadResult.url;
  return {
    url,
    base64: resized.toString('base64'),
    model: transformed.model,
    tokensIn: transformed.tokensIn,
    tokensOut: transformed.tokensOut,
    costUsd: transformed.costUsd,
    imageStyle: style,
  };
}
