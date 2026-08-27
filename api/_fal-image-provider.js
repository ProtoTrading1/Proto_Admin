import { fal } from '@fal-ai/client';
import { Jimp, HorizontalAlign, VerticalAlign, cssColorToHex } from 'jimp';

export const FAL_BACKGROUND_MODEL = 'fal-ai/bria/background/remove';
export const FAL_TARGETED_REPAIR_MODEL = 'fal-ai/flux-pro/v1/fill';
export const FAL_BACKGROUND_COST_USD = 0.018;
export const FAL_USD_TO_ZAR = 18;
const MAX_FAL_OUTPUT_BYTES = 24 * 1024 * 1024;

export const IMAGE_TREATMENTS = Object.freeze({
  STANDARD_OPAQUE: 'standard_opaque',
  TRANSPARENT_CLEAR: 'transparent_clear',
  BEADS_FINE_DETAIL: 'beads_fine_detail',
  MULTI_PIECE: 'multi_piece',
  SHADOW: 'shadow',
  MEASUREMENTS: 'measurements',
  CUSTOM: 'custom',
  TARGETED_RECONSTRUCTION: 'targeted_reconstruction',
});

const TREATMENT_ALIASES = Object.freeze({
  standard: IMAGE_TREATMENTS.STANDARD_OPAQUE,
  opaque: IMAGE_TREATMENTS.STANDARD_OPAQUE,
  standard_opaque: IMAGE_TREATMENTS.STANDARD_OPAQUE,
  transparent: IMAGE_TREATMENTS.TRANSPARENT_CLEAR,
  clear: IMAGE_TREATMENTS.TRANSPARENT_CLEAR,
  clear_packaging: IMAGE_TREATMENTS.TRANSPARENT_CLEAR,
  transparent_clear: IMAGE_TREATMENTS.TRANSPARENT_CLEAR,
  beads: IMAGE_TREATMENTS.BEADS_FINE_DETAIL,
  fine_detail: IMAGE_TREATMENTS.BEADS_FINE_DETAIL,
  beads_fine_detail: IMAGE_TREATMENTS.BEADS_FINE_DETAIL,
  multi: IMAGE_TREATMENTS.MULTI_PIECE,
  multi_piece: IMAGE_TREATMENTS.MULTI_PIECE,
  shadow: IMAGE_TREATMENTS.SHADOW,
  measurements: IMAGE_TREATMENTS.MEASUREMENTS,
  measurement: IMAGE_TREATMENTS.MEASUREMENTS,
  generative: IMAGE_TREATMENTS.CUSTOM,
  custom: IMAGE_TREATMENTS.CUSTOM,
  targeted: IMAGE_TREATMENTS.TARGETED_RECONSTRUCTION,
  reconstruction: IMAGE_TREATMENTS.TARGETED_RECONSTRUCTION,
  targeted_reconstruction: IMAGE_TREATMENTS.TARGETED_RECONSTRUCTION,
});

// Printed stickers, labels and barcodes are product content, not disposable
// background. Treat explicit preservation instructions as a protected detail
// lane even when an older caller still sends the generic opaque treatment.
const PRESERVATION_CONTENT_HINT = /\b(stickers?|labels?|barcodes?|printed\s+(?:words?|numbers?|text)|hangtags?|hang\s+tags?)\b/i;

function boundedInstructions(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

/**
 * Map both the new treatment names and the older UI style names onto an honest
 * processing lane.  Keyword inference is deliberately conservative: it is
 * only used when the caller did not select a known treatment explicitly.
 */
export function normalizeImageTreatment(value, instructions = '') {
  const explicit = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliased = TREATMENT_ALIASES[explicit];
  if (aliased && aliased !== IMAGE_TREATMENTS.STANDARD_OPAQUE) return aliased;
  const hint = `${explicit} ${boundedInstructions(instructions)}`.toLowerCase();
  if (PRESERVATION_CONTENT_HINT.test(hint)) return IMAGE_TREATMENTS.BEADS_FINE_DETAIL;
  if (/\b(transparent|clear\s+pack|clear\s+plastic|cellophane|acrylic)\b/.test(hint)) return IMAGE_TREATMENTS.TRANSPARENT_CLEAR;
  if (/\b(beads?|chain|fine[ -]?detail|jewellery findings?|sequins?)\b/.test(hint)) return IMAGE_TREATMENTS.BEADS_FINE_DETAIL;
  if (/\b(multi[ -]?piece|set of|pack of|assortment|bundle|pieces)\b/.test(hint)) return IMAGE_TREATMENTS.MULTI_PIECE;
  if (/\b(measurements?|dimensions?|dimension lines?)\b/.test(hint)) return IMAGE_TREATMENTS.MEASUREMENTS;
  if (/\b(shadow|drop shadow)\b/.test(hint)) return IMAGE_TREATMENTS.SHADOW;
  if (/\b(red box|selected area|targeted|reconstruct|inpaint)\b/.test(hint)) return IMAGE_TREATMENTS.TARGETED_RECONSTRUCTION;
  return boundedInstructions(instructions) ? IMAGE_TREATMENTS.CUSTOM : IMAGE_TREATMENTS.STANDARD_OPAQUE;
}

/**
 * Resolve a processing policy before a provider is called.  Clear packaging,
 * beads and multi-piece products default to a non-destructive source-preserving
 * lane. Generic background removal is only enabled after an operator explicitly
 * marks the source as safe for that treatment.
 */
export function resolveImageTreatment(image = {}, { manualSafeCutout = image.manualSafeCutout === true } = {}) {
  const instructions = boundedInstructions(image.instructions || image.userInstructions);
  const id = normalizeImageTreatment(image.treatment || image.style || image.imageStyle, instructions);
  const detailSensitive = [
    IMAGE_TREATMENTS.TRANSPARENT_CLEAR,
    IMAGE_TREATMENTS.BEADS_FINE_DETAIL,
    IMAGE_TREATMENTS.MULTI_PIECE,
  ].includes(id);
  const preserveSource = detailSensitive && !manualSafeCutout;
  const warnings = [];
  if (preserveSource) warnings.push('manual_safe_cutout_required');
  if (id === IMAGE_TREATMENTS.TRANSPARENT_CLEAR) warnings.push('transparent_edges_and_print_must_be_visually_verified');
  if (id === IMAGE_TREATMENTS.BEADS_FINE_DETAIL) warnings.push('fine_details_labels_and_holes_must_be_visually_verified');
  if (id === IMAGE_TREATMENTS.MULTI_PIECE) warnings.push('piece_count_and_arrangement_must_be_visually_verified');
  if (id === IMAGE_TREATMENTS.MEASUREMENTS) warnings.push('verified_measurements_require_manual_overlay');
  if (id === IMAGE_TREATMENTS.CUSTOM) warnings.push('custom_instructions_require_manual_review');

  const mode = id === IMAGE_TREATMENTS.TARGETED_RECONSTRUCTION
    ? 'targeted_reconstruction'
    : (preserveSource || [IMAGE_TREATMENTS.MEASUREMENTS, IMAGE_TREATMENTS.CUSTOM].includes(id))
      ? 'preserve_source'
      : 'background_remove';
  const labels = {
    [IMAGE_TREATMENTS.STANDARD_OPAQUE]: 'Standard opaque product',
    [IMAGE_TREATMENTS.TRANSPARENT_CLEAR]: 'Transparent or clear packaging',
    [IMAGE_TREATMENTS.BEADS_FINE_DETAIL]: 'Beads or fine detail',
    [IMAGE_TREATMENTS.MULTI_PIECE]: 'Multi-piece product',
    [IMAGE_TREATMENTS.SHADOW]: 'Catalogue image with soft shadow',
    [IMAGE_TREATMENTS.MEASUREMENTS]: 'Verified measurement overlay',
    [IMAGE_TREATMENTS.CUSTOM]: 'Custom manual treatment',
    [IMAGE_TREATMENTS.TARGETED_RECONSTRUCTION]: 'Targeted background repair',
  };
  return {
    id,
    label: labels[id],
    mode,
    removeBackground: mode === 'background_remove',
    addShadow: id === IMAGE_TREATMENTS.SHADOW,
    allowAutomaticProcessing: mode === 'background_remove',
    requiresManualSafeCutout: detailSensitive && !manualSafeCutout,
    preserve: { labels: true, text: true, quantity: true, productParts: true },
    warnings,
    instructions,
    repair: image.repair || image.targetedRepair || null,
  };
}

function falKey() {
  const key = String(process.env.FAL_KEY || '').trim();
  if (!key) throw new Error('FAL_KEY is not configured for this preview environment');
  return key;
}

export function validateFalOutputUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('fal.ai returned an invalid output URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !(hostname === 'fal.media' || hostname.endsWith('.fal.media'))) {
    throw new Error('fal.ai returned an unexpected output host');
  }
  return parsed.toString();
}

export async function removeBackgroundWithFal(imageUrl, { client = fal, credentials } = {}) {
  const key = credentials || (client === fal ? falKey() : 'mock-client');
  if (typeof client.config === 'function') client.config({ credentials: key });
  const result = await client.subscribe(FAL_BACKGROUND_MODEL, {
    input: { image_url: imageUrl },
    logs: false,
    mode: 'polling',
    startTimeout: 90,
  });
  const outputUrl = result?.data?.image?.url || result?.image?.url;
  return {
    outputUrl: validateFalOutputUrl(outputUrl),
    requestId: result?.requestId || result?.request_id || null,
  };
}

function positiveFinite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

/**
 * Convert a red-box selection from the exact displayed image rectangle to the
 * exact source/processed asset pixels.  Callers must retain the returned
 * `assetId` and reject the repair if the displayed asset changes before submit.
 */
export function validateTargetedRepairMask({ assetId, assetWidth, assetHeight, displayRect, selection } = {}) {
  const cleanAssetId = String(assetId || '').trim().slice(0, 240);
  if (!cleanAssetId) throw new Error('Targeted repair requires the displayed asset id');
  const sourceWidth = positiveFinite(assetWidth, 'assetWidth');
  const sourceHeight = positiveFinite(assetHeight, 'assetHeight');
  if (sourceWidth > 4096 || sourceHeight > 4096 || (sourceWidth * sourceHeight) > 16_777_216) {
    throw new Error('Targeted repair asset exceeds the 4096px safety limit');
  }
  const displayX = Number(displayRect?.x) || 0;
  const displayY = Number(displayRect?.y) || 0;
  const displayWidth = positiveFinite(displayRect?.width, 'displayRect.width');
  const displayHeight = positiveFinite(displayRect?.height, 'displayRect.height');
  const selectX = Number(selection?.x);
  const selectY = Number(selection?.y);
  const selectWidth = positiveFinite(selection?.width, 'selection.width');
  const selectHeight = positiveFinite(selection?.height, 'selection.height');
  if (!Number.isFinite(selectX) || !Number.isFinite(selectY)) throw new Error('Targeted repair selection coordinates are invalid');

  const left = Math.max(displayX, selectX);
  const top = Math.max(displayY, selectY);
  const right = Math.min(displayX + displayWidth, selectX + selectWidth);
  const bottom = Math.min(displayY + displayHeight, selectY + selectHeight);
  if (right <= left || bottom <= top) throw new Error('Targeted repair selection is outside the displayed image');
  // A selection extending beyond the actual rendered image usually means the
  // UI measured its containing pane instead of the image. Fail instead of
  // applying the red box to different geometry.
  if (Math.abs(left - selectX) > 0.5 || Math.abs(top - selectY) > 0.5
    || Math.abs(right - (selectX + selectWidth)) > 0.5 || Math.abs(bottom - (selectY + selectHeight)) > 0.5) {
    throw new Error('Targeted repair selection must stay inside the displayed image');
  }

  const normalized = {
    x: (left - displayX) / displayWidth,
    y: (top - displayY) / displayHeight,
    width: (right - left) / displayWidth,
    height: (bottom - top) / displayHeight,
  };
  const pixels = {
    x: Math.max(0, Math.floor(normalized.x * sourceWidth)),
    y: Math.max(0, Math.floor(normalized.y * sourceHeight)),
    width: Math.max(1, Math.ceil(normalized.width * sourceWidth)),
    height: Math.max(1, Math.ceil(normalized.height * sourceHeight)),
  };
  pixels.width = Math.min(pixels.width, Math.round(sourceWidth) - pixels.x);
  pixels.height = Math.min(pixels.height, Math.round(sourceHeight) - pixels.y);
  if (pixels.width < 3 || pixels.height < 3) throw new Error('Targeted repair selection is too small');
  const areaRatio = normalized.width * normalized.height;
  if (areaRatio > 0.35) throw new Error('Targeted repair selection is too large; use a smaller background-only area');
  return {
    assetId: cleanAssetId,
    coordinateSpace: 'displayed_image',
    asset: { width: Math.round(sourceWidth), height: Math.round(sourceHeight) },
    displayRect: { x: displayX, y: displayY, width: displayWidth, height: displayHeight },
    normalized,
    pixels,
    areaRatio,
  };
}

export async function createTargetedRepairMask(geometry) {
  if (!geometry?.asset?.width || !geometry?.asset?.height || !geometry?.pixels) {
    throw new Error('Targeted repair geometry is required to create the mask');
  }
  const mask = new Jimp({ width: geometry.asset.width, height: geometry.asset.height, color: 0x000000ff });
  const { x, y, width, height } = geometry.pixels;
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) mask.setPixelColor(0xffffffff, column, row);
  }
  const buffer = await mask.getBuffer('image/png');
  return { buffer, width: geometry.asset.width, height: geometry.asset.height, pixels: { ...geometry.pixels } };
}

export async function validateTargetedRepairMaskImage(buffer, geometry) {
  const mask = await Jimp.read(buffer);
  if (mask.bitmap.width !== geometry?.asset?.width || mask.bitmap.height !== geometry?.asset?.height) {
    throw new Error('Targeted repair mask dimensions do not match the displayed asset');
  }
  const expected = geometry.pixels;
  let selected = 0;
  let outside = 0;
  const { width, height, data } = mask.bitmap;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = ((y * width) + x) * 4;
    const active = data[index + 3] > 16 && ((data[index] + data[index + 1] + data[index + 2]) / 3) >= 128;
    if (!active) continue;
    selected += 1;
    if (x < expected.x || y < expected.y || x >= expected.x + expected.width || y >= expected.y + expected.height) outside += 1;
  }
  const expectedPixels = expected.width * expected.height;
  if (!selected || selected < expectedPixels * 0.98 || selected > expectedPixels * 1.02 || outside > expectedPixels * 0.005) {
    throw new Error('Targeted repair mask does not match the confirmed red-box geometry');
  }
  return { width, height, selectedPixels: selected, expectedPixels };
}

function validateHttpsProviderInput(value, name) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw new Error(`${name} is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`${name} must be HTTPS without embedded credentials`);
  return parsed.toString();
}

/**
 * Provider adapter for the explicit targeted-repair lane.  The prompt permits
 * replacement of background pixels only: product parts, labels, text and pack
 * quantity are immutable ground truth and may never be generated or removed.
 */
export async function reconstructTargetedRegionWithFal(imageUrl, maskUrl, geometry, {
  client = fal,
  credentials,
  currentAssetId,
} = {}) {
  if (!geometry?.assetId || !currentAssetId || geometry.assetId !== String(currentAssetId)) {
    throw new Error('Targeted repair is stale because the displayed image changed');
  }
  if (!geometry?.pixels || geometry.areaRatio <= 0 || geometry.areaRatio > 0.35) {
    throw new Error('Targeted repair mask geometry is invalid');
  }
  const key = credentials || (client === fal ? falKey() : 'mock-client');
  if (typeof client.config === 'function') client.config({ credentials: key });
  const result = await client.subscribe(FAL_TARGETED_REPAIR_MODEL, {
    input: {
      image_url: validateHttpsProviderInput(imageUrl, 'imageUrl'),
      mask_url: validateHttpsProviderInput(maskUrl, 'maskUrl'),
      prompt: 'Replace only unwanted BACKGROUND pixels inside the supplied mask with a clean continuation of the nearby background. The source product is immutable ground truth: preserve every product part, edge, label, logo, word, number, colour, transparent area, and exact pack quantity. Never add, remove, redraw, guess, or reconstruct any product part. If the mask overlaps the product, leave those product pixels unchanged.',
      num_images: 1,
      output_format: 'png',
    },
    logs: false,
    mode: 'polling',
    startTimeout: 90,
  });
  const outputUrl = result?.data?.images?.[0]?.url || result?.data?.image?.url || result?.images?.[0]?.url || result?.image?.url;
  return {
    outputUrl: validateFalOutputUrl(outputUrl),
    requestId: result?.requestId || result?.request_id || null,
    assetId: geometry.assetId,
    geometry,
  };
}

export async function downloadFalOutput(outputUrl, { fetchImpl = fetch } = {}) {
  const url = validateFalOutputUrl(outputUrl);
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download fal.ai output (HTTP ${response.status})`);
  const declaredLength = Number(response.headers.get('content-length')) || 0;
  if (declaredLength > MAX_FAL_OUTPUT_BYTES) throw new Error('fal.ai output exceeds the 24 MB safety limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('fal.ai returned an empty image');
  if (buffer.length > MAX_FAL_OUTPUT_BYTES) throw new Error('fal.ai output exceeds the 24 MB safety limit');
  return buffer;
}

/**
 * Catch a common destructive cut-out failure before it can be approved: a
 * light label, number strip or pale product part inside a darker photograph
 * is mistaken for background and becomes transparent. Ordinary white
 * backgrounds are ignored because their light region reaches the image edge.
 */
export async function detectRemovedLightContent(sourceBuffer, cutoutBuffer, { sampleSize = 256 } = {}) {
  const cutout = await Jimp.read(cutoutBuffer);
  const source = await Jimp.read(sourceBuffer);
  const scale = Math.min(1, Math.max(64, Number(sampleSize) || 256) / Math.max(cutout.bitmap.width, cutout.bitmap.height));
  const width = Math.max(1, Math.round(cutout.bitmap.width * scale));
  const height = Math.max(1, Math.round(cutout.bitmap.height * scale));
  cutout.resize({ w: width, h: height });
  source.resize({ w: width, h: height });

  const total = width * height;
  const candidate = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const margin = Math.max(1, Math.round(Math.min(width, height) * 0.015));
  const minimumArea = Math.max(28, Math.round(total * 0.0015));

  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const outputAlpha = cutout.bitmap.data[offset + 3];
    const outputRed = cutout.bitmap.data[offset];
    const outputGreen = cutout.bitmap.data[offset + 1];
    const outputBlue = cutout.bitmap.data[offset + 2];
    const outputLuminance = (outputRed * 0.2126) + (outputGreen * 0.7152) + (outputBlue * 0.0722);
    const outputChroma = Math.max(outputRed, outputGreen, outputBlue) - Math.min(outputRed, outputGreen, outputBlue);
    const outputLooksLikeWhiteBackground = outputAlpha > 24 && outputLuminance >= 245 && outputChroma <= 20;
    // fal.ai may return an opaque white JPEG rather than a transparent PNG.
    // In that case a removed label is indistinguishable from the new canvas
    // unless we compare the source's interior light regions as well.
    if (outputAlpha > 24 && !outputLooksLikeWhiteBackground) continue;
    const red = source.bitmap.data[offset];
    const green = source.bitmap.data[offset + 1];
    const blue = source.bitmap.data[offset + 2];
    const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    // Preserve the original pale-label check, but also catch a dark or
    // coloured sticker/printed label that was erased into the new background.
    // Edge-connected regions are discarded below, so ordinary dark scenery
    // around a product does not become a warning while enclosed content does.
    const looksLikeLightProductContent = luminance >= 208 && chroma <= 48;
    const looksLikeDarkOrColouredContent = luminance <= 175 || chroma >= 48;
    if (looksLikeDarkOrColouredContent) candidate[index] = 2;
    else if (looksLikeLightProductContent) candidate[index] = 1;
  }

  const regions = [];
  for (let start = 0; start < total; start += 1) {
    if (!candidate[start] || visited[start]) continue;
    const regionKind = candidate[start];
    let head = 0;
    let tail = 0;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let touchesEdge = false;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (x <= margin || y <= margin || x >= width - margin - 1 || y >= height - margin - 1) touchesEdge = true;
      const neighbours = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || visited[next] || candidate[next] !== regionKind) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const boxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    if (!touchesEdge && area >= minimumArea && area / boxArea >= 0.32) {
      regions.push({ area, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }

  const removedLightPixels = regions.reduce((sum, region) => sum + region.area, 0);
  return {
    suspicious: regions.length > 0,
    removedLightAreaRatio: removedLightPixels / Math.max(1, total),
    regions: regions.sort((a, b) => b.area - a.area).slice(0, 12),
    sample: { width, height },
  };
}

function alphaBounds(image, threshold = 16) {
  const { width, height, data } = image.bitmap;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[((y * width) + x) * 4 + 3] < threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('fal.ai output did not contain a visible product');
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function hasDetachedForeground(image, threshold = 48) {
  const sample = image.clone();
  sample.contain({
    w: 192,
    h: 192,
    align: HorizontalAlign.CENTER | VerticalAlign.MIDDLE,
    background: cssColorToHex('#00000000'),
  });
  const { width, height, data } = sample.bitmap;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];

  for (let start = 0; start < visited.length; start += 1) {
    if (visited[start] || data[(start * 4) + 3] < threshold) continue;
    let head = 0;
    let tail = 0;
    let area = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const current = queue[head++];
      area += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbours = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || visited[next] || data[(next * 4) + 3] < threshold) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    if (area >= 8) components.push(area);
  }

  components.sort((a, b) => b - a);
  return components.length > 1 && components[1] >= Math.max(12, components[0] * 0.0025);
}

export async function standardizeFalOutput(buffer, { size = 1600, paddingRatio = 0.08, treatment = IMAGE_TREATMENTS.STANDARD_OPAQUE } = {}) {
  const plan = typeof treatment === 'string'
    ? resolveImageTreatment({ treatment })
    : resolveImageTreatment(treatment || {});
  const image = await Jimp.read(buffer);
  const detachedForeground = hasDetachedForeground(image);
  const bounds = alphaBounds(image);
  image.crop(bounds);

  const padding = Math.max(40, Math.round(size * Math.max(0.04, Math.min(0.2, paddingRatio))));
  const innerSize = size - (padding * 2);
  image.contain({
    w: innerSize,
    h: innerSize,
    align: HorizontalAlign.CENTER | VerticalAlign.MIDDLE,
    background: cssColorToHex('#00000000'),
  });
  const canvas = new Jimp({ width: size, height: size, color: cssColorToHex('#00000000') });
  canvas.composite(image, padding, padding);
  const transparentMasterBuffer = await canvas.getBuffer('image/png');
  // Keep the cleaned cut-out as the master.  The website derivative is a
  // separate, deliberately opaque asset so the catalogue has a consistent
  // white canvas without throwing away the transparent version.
  const websiteCanvas = new Jimp({ width: size, height: size, color: cssColorToHex('#FFFFFFFF') });
  if (plan.addShadow) {
    const shadow = canvas.clone();
    const { data } = shadow.bitmap;
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = Math.round(data[index + 3] * 0.16);
    }
    shadow.blur(Math.max(4, Math.round(size * 0.012)));
    websiteCanvas.composite(shadow, 0, Math.round(size * 0.012));
  }
  websiteCanvas.composite(canvas, 0, 0);
  const websiteReadyBuffer = await websiteCanvas.getBuffer('image/jpeg');
  return {
    // `buffer` remains for older callers; it is always the transparent master.
    buffer: transparentMasterBuffer,
    transparentMasterBuffer,
    transparentMaster: { width: size, height: size, format: 'image/png', background: 'transparent' },
    websiteReadyBuffer,
    websiteReady: { width: size, height: size, format: 'image/jpeg', background: '#FFFFFF' },
    warnings: [...new Set([
      ...plan.warnings,
      ...(detachedForeground
        ? ['possible_detached_label_or_barcode', 'manual_label_barcode_review_required']
        : []),
    ])],
    treatment: plan,
  };
}

