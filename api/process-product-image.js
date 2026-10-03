import { createClient } from '@supabase/supabase-js';
import { Jimp, HorizontalAlign, VerticalAlign, rgbaToInt, intToRGBA } from 'jimp';
import { requireOwner } from './_admin-auth.js';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const MAX_INPUT_DIMENSION = 1600;
const PREVIEW_DIMENSION = 760;
const OUTPUT_DIMENSION = 1600;

function getStockAdminClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
}

function sampleBackground(data, width, height) {
  const samples = [];
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));

  const samplePixel = (x, y) => {
    const index = (y * width + x) * 4;
    if (data[index + 3] < 12) return;
    samples.push({ r: data[index], g: data[index + 1], b: data[index + 2] });
  };

  for (let x = 0; x < width; x += stepX) {
    samplePixel(x, 0);
    samplePixel(x, Math.max(0, height - 1));
  }
  for (let y = 0; y < height; y += stepY) {
    samplePixel(0, y);
    samplePixel(Math.max(0, width - 1), y);
  }

  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 24))) {
    for (let y = 0; y < Math.min(8, height); y += 1) samplePixel(x, y);
    for (let y = Math.max(0, height - 8); y < height; y += 1) samplePixel(x, y);
  }

  if (!samples.length) return { r: 255, g: 255, b: 255 };
  const total = samples.reduce((acc, sample) => {
    acc.r += sample.r;
    acc.g += sample.g;
    acc.b += sample.b;
    return acc;
  }, { r: 0, g: 0, b: 0 });
  return {
    r: Math.round(total.r / samples.length),
    g: Math.round(total.g / samples.length),
    b: Math.round(total.b / samples.length),
  };
}

function fileToBase64(buffer) {
  return buffer.toString('base64');
}

async function processImageBuffer(buffer, contentType = 'image/jpeg') {
  const image = await Jimp.read(buffer);
  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;
  const totalPixels = Math.max(1, originalWidth * originalHeight);
  const data = image.bitmap.data;
  const bg = sampleBackground(data, originalWidth, originalHeight);
  const tolerance = bg.r + bg.g + bg.b > 650 ? 42 : bg.r + bg.g + bg.b > 520 ? 35 : 28;

  let minX = originalWidth;
  let minY = originalHeight;
  let maxX = -1;
  let maxY = -1;
  let foreground = 0;
  let backgroundPixels = 0;
  let touchesEdge = false;

  for (let y = 0; y < originalHeight; y += 1) {
    for (let x = 0; x < originalWidth; x += 1) {
      const index = (y * originalWidth + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 12) {
        backgroundPixels += 1;
        continue;
      }

      const pixel = { r: data[index], g: data[index + 1], b: data[index + 2] };
      if (colorDistance(pixel, bg) <= tolerance) {
        data[index + 3] = 0;
        backgroundPixels += 1;
        continue;
      }

      foreground += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (x === 0 || y === 0 || x === originalWidth - 1 || y === originalHeight - 1) {
        touchesEdge = true;
      }
    }
  }

  const bounds = minX <= maxX && minY <= maxY ? {
    minX,
    minY,
    maxX,
    maxY,
  } : null;
  const foregroundRatio = foreground / totalPixels;
  const backgroundRatio = backgroundPixels / totalPixels;
  const confidence = clamp(0.5 + (backgroundRatio * 0.28) - (touchesEdge ? 0.18 : 0), 0.12, 0.98);
  const needsReview = confidence < 0.58 || !bounds || touchesEdge || foregroundRatio < 0.03 || foregroundRatio > 0.95;

  const previewImage = image.clone();
  const outputImage = image.clone();
  const white = rgbaToInt(255, 255, 255, 255);

  previewImage.contain({
    w: PREVIEW_DIMENSION,
    h: PREVIEW_DIMENSION,
    align: HorizontalAlign.CENTER | VerticalAlign.MIDDLE,
    background: white,
  });
  outputImage.contain({
    w: OUTPUT_DIMENSION,
    h: OUTPUT_DIMENSION,
    align: HorizontalAlign.CENTER | VerticalAlign.MIDDLE,
    background: white,
  });

  const [previewBuffer, outputBuffer] = await Promise.all([
    previewImage.getBuffer('image/jpeg'),
    outputImage.getBuffer('image/jpeg'),
  ]);

  const notes = [];
  if (foreground > 0) notes.push('Background trimmed');
  if (bounds) notes.push('Cropped to subject bounds');
  notes.push('Centered on square ecommerce canvas');
  if (needsReview) notes.push('Needs human review');

  return {
    processedBase64: fileToBase64(outputBuffer),
    previewBase64: fileToBase64(previewBuffer),
    contentType: 'image/jpeg',
    metrics: {
      width: originalWidth,
      height: originalHeight,
      backgroundRatio,
      foregroundRatio,
      confidence,
      touchesEdge,
    },
    notes,
    needsReview,
  };
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { filename, contentType, base64 } = req.body || {};
  if (!filename || !contentType || !base64) {
    return res.status(400).json({ error: 'filename, contentType, and base64 are required' });
  }

  try {
    const cleanBase64 = String(base64).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Invalid image payload' });
    const result = await processImageBuffer(buffer, contentType);
    return res.status(200).json({
      ...result,
      filename,
    });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to process image' });
  }
}
