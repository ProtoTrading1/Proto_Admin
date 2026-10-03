import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  FolderOpen,
  ImagePlus,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { fetchAllProductsAdmin, updateProduct } from '../lib/products';
import { isImageFile, parseIntakeFilename } from '../lib/parseIntakeFilename';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSku(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^A-Z0-9]+/g, '');
}

function fileId(file) {
  return [file?.name, file?.size, file?.lastModified].filter(Boolean).join('|');
}

function scoreMatch(candidate, variant) {
  if (!candidate || !variant) return 0;
  if (candidate === variant) return 1000 + variant.length;
  if (candidate.includes(variant)) return 800 + variant.length;
  if (variant.includes(candidate) && candidate.length >= 4) return 650 + candidate.length;
  return 0;
}

function extractSkuCandidates(file) {
  const parsed = parseIntakeFilename(file?.name || '');
  const candidates = new Set([
    parsed.sourceSku,
    parsed.fullCode,
    parsed.primarySku,
    parsed.displayCode,
    ...(parsed.skuCandidates || []),
  ].filter(Boolean));

  const path = String(file?.webkitRelativePath || '').trim();
  if (path) {
    for (const segment of path.split(/[\\/]/)) {
      const cleaned = normalizeSku(segment);
      if (cleaned) candidates.add(cleaned);
    }
  }

  return [...candidates];
}

function buildProductVariants(product) {
  return [...new Set([
    product?.sku,
    product?.code,
    product?.barcode,
    product?.name,
    product?.title,
  ].map(normalizeSku).filter(Boolean))];
}

function matchProductForAsset(file, products = []) {
  const candidates = extractSkuCandidates(file);
  const scored = [];

  for (const product of products) {
    const variants = buildProductVariants(product);
    let bestScore = 0;
    let bestReason = '';

    for (const candidate of candidates) {
      for (const variant of variants) {
        const score = scoreMatch(candidate, variant);
        if (score > bestScore) {
          bestScore = score;
          bestReason = candidate === variant
            ? 'Exact SKU match'
            : candidate.includes(variant)
              ? 'Filename contains SKU'
              : 'Loose SKU match';
        }
      }
    }

    if (bestScore > 0) {
      scored.push({ product, score: bestScore, reason: bestReason });
    }
  }

  scored.sort((a, b) => b.score - a.score || String(a.product?.sku || '').localeCompare(String(b.product?.sku || '')));
  const bestMatch = scored[0] || null;
  const confidence = bestMatch
    ? Math.min(0.98, Math.max(0.34, bestMatch.score / 1100))
    : 0;

  return {
    bestMatch,
    confidence,
    candidates,
    suggestions: scored.slice(0, 5),
  };
}

function averageColor(samples) {
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

function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Unable to load ${file.name}`));
    };
    image.src = objectUrl;
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function nextFrame() {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}

function fitWithinBounds(width, height, maxSize) {
  const longest = Math.max(width, height);
  if (!longest || longest <= maxSize) {
    return { width, height, scale: 1 };
  }

  const scale = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function sampleBackground(imageData, width, height) {
  const samples = [];
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));
  const samplePixel = (x, y) => {
    const index = (y * width + x) * 4;
    const alpha = imageData.data[index + 3];
    if (alpha < 12) return;
    samples.push({
      r: imageData.data[index],
      g: imageData.data[index + 1],
      b: imageData.data[index + 2],
    });
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

  return averageColor(samples);
}

function analyzeCoarseSubject(imageData, width, height) {
  const bg = sampleBackground(imageData, width, height);
  const tolerance = bg.r + bg.g + bg.b > 650 ? 40 : bg.r + bg.g + bg.b > 520 ? 34 : 28;
  const step = Math.max(6, Math.floor(Math.max(width, height) / 180));

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foreground = 0;
  let backgroundSamples = 0;
  let touchesEdge = false;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const alpha = imageData.data[offset + 3];
      if (alpha < 10) {
        backgroundSamples += 1;
        continue;
      }

      const pixel = {
        r: imageData.data[offset],
        g: imageData.data[offset + 1],
        b: imageData.data[offset + 2],
      };
      if (colorDistance(pixel, bg) <= tolerance) {
        backgroundSamples += 1;
        continue;
      }

      foreground += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (x <= step || y <= step || x >= width - step || y >= height - step) touchesEdge = true;
    }
  }

  const sampleCount = Math.max(1, Math.ceil(width / step) * Math.ceil(height / step));
  const backgroundRatio = backgroundSamples / sampleCount;
  const coarseBounds = minX <= maxX && minY <= maxY
    ? {
      minX: Math.max(0, minX - step * 2),
      minY: Math.max(0, minY - step * 2),
      maxX: Math.min(width - 1, maxX + step * 2),
      maxY: Math.min(height - 1, maxY + step * 2),
    }
    : null;

  return {
    bg,
    bounds: coarseBounds,
    foreground,
    backgroundPixels: Math.round(backgroundRatio * width * height),
    touchesEdge,
    confidence: clamp(0.5 + backgroundRatio * 0.28 - (touchesEdge ? 0.18 : 0), 0.12, 0.98),
  };
}

function toDataUrl(canvas, quality = 0.88) {
  try {
    return canvas.toDataURL('image/webp', quality);
  } catch {
    return canvas.toDataURL('image/png');
  }
}

function renderSquareOutput(foregroundCanvas, bounds, size, paddingRatio = 0.1) {
  const output = document.createElement('canvas');
  output.width = size;
  output.height = size;
  const ctx = output.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (!bounds) {
    const fit = size * (1 - paddingRatio * 2);
    const scale = Math.min(fit / foregroundCanvas.width, fit / foregroundCanvas.height);
    const drawW = foregroundCanvas.width * scale;
    const drawH = foregroundCanvas.height * scale;
    const offsetX = Math.round((size - drawW) / 2);
    const offsetY = Math.round((size - drawH) / 2);
    ctx.drawImage(foregroundCanvas, offsetX, offsetY, drawW, drawH);
    return toDataUrl(output);
  }

  const cropWidth = bounds.maxX - bounds.minX + 1;
  const cropHeight = bounds.maxY - bounds.minY + 1;
  const pad = Math.max(12, Math.round(Math.min(cropWidth, cropHeight) * 0.12));
  const cropX = Math.max(0, bounds.minX - pad);
  const cropY = Math.max(0, bounds.minY - pad);
  const cropW = Math.min(foregroundCanvas.width - cropX, cropWidth + pad * 2);
  const cropH = Math.min(foregroundCanvas.height - cropY, cropHeight + pad * 2);
  const scale = Math.min((size * (1 - paddingRatio * 2)) / cropW, (size * (1 - paddingRatio * 2)) / cropH);
  const drawW = cropW * scale;
  const drawH = cropH * scale;
  const offsetX = Math.round((size - drawW) / 2);
  const offsetY = Math.round((size - drawH) / 2);

  ctx.drawImage(foregroundCanvas, cropX, cropY, cropW, cropH, offsetX, offsetY, drawW, drawH);
  return toDataUrl(output);
}

async function processAsset(file) {
  const base64 = await fileToBase64(file);
  const response = await fetch('/api/process-product-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'image/jpeg',
      base64,
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || 'Processing failed');
  }

  const outputType = json.contentType || 'image/jpeg';
  return {
    processedSrc: `data:${outputType};base64,${json.processedBase64 || ''}`,
    previewSrc: `data:${outputType};base64,${json.previewBase64 || json.processedBase64 || ''}`,
    metrics: json.metrics || {},
    notes: Array.isArray(json.notes) ? json.notes : [],
    needsReview: Boolean(json.needsReview),
  };
}

function statusLabel(status) {
  switch (status) {
    case 'queued': return 'Queued';
    case 'processing': return 'Processing';
    case 'ready-review': return 'Ready to review';
    case 'needs-review': return 'Needs review';
    case 'approved': return 'Approved';
    case 'failed': return 'Failed';
    default: return status || 'Idle';
  }
}

function statusTone(status) {
  switch (status) {
    case 'approved': return { bg: '#ecfdf3', fg: '#15803d', border: '#bbf7d0' };
    case 'ready-review': return { bg: '#eff6ff', fg: '#2563eb', border: '#bfdbfe' };
    case 'needs-review': return { bg: '#fffbeb', fg: '#a16207', border: '#fde68a' };
    case 'failed': return { bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca' };
    case 'processing': return { bg: '#ecfeff', fg: '#0e7490', border: '#a5f3fc' };
    default: return { bg: '#f8fafc', fg: '#475467', border: '#e2e8f0' };
  }
}

function buildSlotPayload(product, slotIndex, uploadedUrl) {
  const current = [
    product?.images?.[0] || product?.image || '',
    product?.images?.[1] || product?.secondaryImage || '',
    product?.images?.[2] || product?.imageThree || '',
    product?.images?.[3] || product?.imageFour || '',
  ];
  const next = [...current];
  next[slotIndex] = uploadedUrl;
  return {
    image: next[0],
    secondaryImage: next[1],
    imageThree: next[2],
    imageFour: next[3],
    images: next,
  };
}

async function uploadProcessedImage({ sku, fileName, dataUrl }) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  const res = await fetch('/api/upload-product-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: fileName,
      contentType: 'image/webp',
      base64,
      sku,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Upload failed');
  return json.url;
}

export default function ImageProcessingCentrePanel({ onShowToast }) {
  const [products, setProducts] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualMessage, setManualMessage] = useState('');
  const [paused, setPaused] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const fileRef = useRef(null);
  const folderRef = useRef(null);
  const batchRef = useRef(null);
  const objectUrlsRef = useRef(new Set());
  const runLockRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAllProductsAdmin()
      .then((rows) => {
        if (cancelled) return;
        setProducts((rows || []).map((product) => ({
          ...product,
          images: [
            product.images?.[0] || product.image || '',
            product.images?.[1] || product.secondaryImage || '',
            product.images?.[2] || product.imageThree || '',
            product.images?.[3] || product.imageFour || '',
          ],
        })));
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (selectedId) return;
    const next = jobs.find((job) => ['ready-review', 'needs-review', 'failed'].includes(job.status))
      || jobs.find((job) => job.status === 'processing')
      || jobs[0];
    if (next) setSelectedId(next.id);
  }, [jobs, selectedId]);

  useEffect(() => {
    if (!jobs.length || paused || runLockRef.current) return;
    const next = jobs.find((job) => job.status === 'queued');
    if (!next) return;

    runLockRef.current = true;
    let cancelled = false;

    const run = async () => {
      setJobs((current) => current.map((job) => (
        job.id === next.id
          ? { ...job, status: 'processing', startedAt: new Date().toISOString() }
          : job
      )));
      try {
        const result = await processAsset(next.file);
        if (cancelled) return;
        setJobs((current) => current.map((job) => (
          job.id === next.id
            ? {
              ...job,
              status: result.needsReview ? 'needs-review' : 'ready-review',
              processedSrc: result.processedSrc,
              previewSrc: result.previewSrc,
              metrics: result.metrics,
              notes: result.notes,
              needsReview: result.needsReview,
              sourceUrl: result.sourceUrl,
              finishedAt: new Date().toISOString(),
            }
            : job
        )));
      } catch (error) {
        if (cancelled) return;
        setJobs((current) => current.map((job) => (
          job.id === next.id
            ? {
              ...job,
              status: 'failed',
              error: error instanceof Error ? error.message : 'Processing failed',
              finishedAt: new Date().toISOString(),
            }
            : job
        )));
      } finally {
        runLockRef.current = false;
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [jobs, paused]);

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedId) || null, [jobs, selectedId]);
  const queueItems = useMemo(() => {
    const order = { failed: 0, 'needs-review': 1, 'ready-review': 2, processing: 3, queued: 4, approved: 5 };
    return [...jobs].sort((a, b) => (order[a.status] || 99) - (order[b.status] || 99) || a.fileName.localeCompare(b.fileName));
  }, [jobs]);
  const catalogMatches = useMemo(() => {
    const q = normalizeSku(search);
    if (!q) return products.slice(0, 10);
    return products.filter((product) => {
      const text = normalizeSku([product.sku, product.code, product.name, product.title].join(' '));
      return text.includes(q);
    }).slice(0, 12);
  }, [products, search]);

  const addJobs = (fileList, sourceType) => {
    const files = [...(fileList || [])].filter(isImageFile);
    if (!files.length) return;

    const nextJobs = files.map((file) => {
      const match = matchProductForAsset(file, products);
      const folder = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : '';
      const originalUrl = URL.createObjectURL(file);
      objectUrlsRef.current.add(originalUrl);
      const parsed = parseIntakeFilename(file.name);
      return {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        fileId: fileId(file),
        sourceType,
        folder,
        originalUrl,
        fileName: file.name,
        parsed,
        imageSlot: parsed.imageNumber || 1,
        matchedProduct: match.bestMatch?.product ? {
          id: match.bestMatch.product.id,
          sku: match.bestMatch.product.sku,
          code: match.bestMatch.product.code,
          name: match.bestMatch.product.name,
          product: match.bestMatch.product,
        } : null,
        candidateCodes: match.candidates,
        matchScore: match.bestMatch?.score || 0,
        matchReason: match.bestMatch?.reason || 'No automatic match',
        suggestions: match.suggestions.map((item) => ({
          id: item.product.id,
          sku: item.product.sku,
          code: item.product.code,
          name: item.product.name,
          score: item.score,
        })),
        status: 'queued',
        createdAt: new Date().toISOString(),
        originalLabel: sourceType === 'folder' && folder ? `${folder}/${file.name}` : file.name,
        note: match.bestMatch ? `Best match: ${match.bestMatch.product.sku || match.bestMatch.product.code}` : 'Awaiting SKU match',
      };
    });

    setJobs((current) => [...current, ...nextJobs]);
    setSelectedId(nextJobs[0]?.id || selectedId);
  };

  const importBatch = (event) => {
    addJobs(event.target.files, event.target.dataset.source || 'files');
    event.target.value = '';
  };

  const selectedProductCount = jobs.filter((job) => job.status === 'approved').length;
  const reviewCount = jobs.filter((job) => job.status === 'needs-review' || job.status === 'ready-review').length;
  const failedCount = jobs.filter((job) => job.status === 'failed').length;

  const resolveManualProduct = () => {
    const target = normalizeSku(manualCode);
    if (!target) return null;
    return products.find((product) => {
      const text = normalizeSku([product.sku, product.code, product.barcode, product.name, product.title].join(' '));
      return text === target || text.includes(target) || target.includes(text);
    }) || null;
  };

  const assignManualMatch = () => {
    if (!selectedJob) return;
    const product = resolveManualProduct();
    if (!product) {
      setManualMessage(`No product found for ${manualCode}.`);
      return;
    }
    setJobs((current) => current.map((job) => (
      job.id === selectedJob.id
        ? {
          ...job,
          matchedProduct: {
            id: product.id,
            sku: product.sku,
            code: product.code,
            name: product.name,
            product,
          },
          matchReason: 'Manually assigned',
          status: job.status === 'failed' ? 'needs-review' : job.status,
        }
        : job
    )));
    setManualMessage(`Matched to ${product.sku || product.code} - ${product.name}`);
    setManualCode('');
  };

  const retryJob = (job) => {
    setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, status: 'queued', error: null, note: 'Requeued for processing' } : item)));
  };

  const rejectJob = (job) => {
    setJobs((current) => current.filter((item) => item.id !== job.id));
    if (job.originalUrl) {
      objectUrlsRef.current.delete(job.originalUrl);
      URL.revokeObjectURL(job.originalUrl);
    }
    if (selectedId === job.id) setSelectedId(null);
  };

  const downloadProcessed = (job) => {
    if (!job?.processedSrc) return;
    const link = document.createElement('a');
    link.href = job.processedSrc;
    link.download = `${normalizeSku(job.matchedProduct?.sku || job.matchedProduct?.code || job.file.name)}-processed.webp`;
    link.click();
  };

  const approveJob = async (job) => {
    if (!job?.processedSrc) return;
    if (!job?.matchedProduct?.product) {
      setManualMessage('Assign a SKU before approving.');
      return;
    }

    const product = job.matchedProduct.product;
    const sku = String(product.sku || product.code || product.id || job.matchedProduct.sku || '').trim();
    if (!sku) {
      setManualMessage('The matched product is missing a SKU.');
      return;
    }

    setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, status: 'processing', note: 'Uploading approved image' } : item)));
    try {
      const uploadedUrl = await uploadProcessedImage({
        sku,
        fileName: `${normalizeSku(sku || job.file.name)}-processed.webp`,
        dataUrl: job.processedSrc,
      });
      const slotIndex = clamp((job.imageSlot || 1) - 1, 0, 3);
      const payload = buildSlotPayload(product, slotIndex, uploadedUrl);
      await updateProduct(product.id, {
        image: payload.image,
        secondaryImage: payload.secondaryImage,
        imageThree: payload.imageThree,
        imageFour: payload.imageFour,
      });

      setProducts((current) => current.map((row) => (row.id === product.id ? { ...row, ...payload } : row)));
      setJobs((current) => current.map((item) => (item.id === job.id ? {
        ...item,
        status: 'approved',
        approvedAt: new Date().toISOString(),
        publishedUrl: uploadedUrl,
        note: 'Approved and published through product update flow',
      } : item)));
      setManualMessage(`Published to ${sku} through the existing product image flow.`);
      onShowToast?.(`Approved ${sku}`, 'success');
    } catch (error) {
      setJobs((current) => current.map((item) => (item.id === job.id ? {
        ...item,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Publish failed',
        note: 'Approval upload failed',
      } : item)));
      onShowToast?.(error instanceof Error ? error.message : 'Publish failed', 'error');
    }
  };

  const originalPreview = selectedJob?.originalUrl || '';
  const processedPreview = selectedJob?.previewSrc || selectedJob?.processedSrc || '';
  const previewTone = statusTone(selectedJob?.status || 'idle');

  return (
    <div className="adm-panel" style={{ display: 'grid', gap: 16 }}>
      <div className="adm-section-head" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2 className="adm-section-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ScanSearch size={20} /> Image Processing Centre
          </h2>
          <p className="adm-section-note">
            Process product images, queue them for review, and only publish after a staff member approves the cleaned result.
          </p>
          <p className="adm-muted" style={{ fontSize: 12, marginTop: 6 }}>
            Approved images are published through the same product update flow used by the existing admin tools.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="adm-btn-ghost" onClick={() => setPaused((p) => !p)}>
            {paused ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
            {paused ? 'Resume queue' : 'Pause queue'}
          </button>
          <button type="button" className="adm-btn-red" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Upload images
          </button>
        </div>
      </div>

      <div className="adm-toolbar" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="adm-btn-ghost" onClick={() => fileRef.current?.click()}>
          <ImagePlus size={14} /> Individual images
        </button>
        <button type="button" className="adm-btn-ghost" onClick={() => folderRef.current?.click()}>
          <FolderOpen size={14} /> Folder upload
        </button>
        <button type="button" className="adm-btn-ghost" onClick={() => batchRef.current?.click()}>
          <ArrowRight size={14} /> Batch upload
        </button>
        <span className="adm-pill" style={{ fontSize: 12 }}>
          {jobs.length} in queue · {reviewCount} review · {selectedProductCount} approved · {failedCount} failed
        </span>
        {loadingProducts && (
          <span className="adm-muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Loader2 size={14} className="spin" /> Loading product catalogue…
          </span>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={importBatch} data-source="files" />
        <input ref={folderRef} type="file" accept="image/*" multiple webkitdirectory="" directory="" hidden onChange={importBatch} data-source="folder" />
        <input ref={batchRef} type="file" accept="image/*" multiple hidden onChange={importBatch} data-source="batch" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 0.85fr) minmax(0, 1.25fr) minmax(280px, 0.95fr)', gap: 16, alignItems: 'start' }}>
        <section className="adm-panel" style={{ margin: 0, display: 'grid', gap: 12 }}>
          <div className="adm-section-head" style={{ marginBottom: 0 }}>
            <div>
              <h3 className="adm-subtitle">Processing queue</h3>
              <p className="adm-muted" style={{ fontSize: 12 }}>Original files stay visible while the cleaned result moves through review.</p>
            </div>
            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => setJobs([])}>
              <RefreshCw size={14} /> Clear
            </button>
          </div>

          <div style={{ display: 'grid', gap: 10, maxHeight: 760, overflow: 'auto', paddingRight: 4 }}>
            {queueItems.length === 0 ? (
              <div style={{ padding: 24, borderRadius: 16, border: '1px dashed #dbe4f0', background: '#fbfdff', color: '#64748b', textAlign: 'center' }}>
                <ShieldCheck size={22} style={{ margin: '0 auto 8px' }} />
                <strong style={{ display: 'block', color: '#0f172a', marginBottom: 6 }}>Waiting for images</strong>
                <span>Upload one file, a folder, or a full batch to start processing.</span>
              </div>
            ) : queueItems.map((job) => {
              const tone = statusTone(job.status);
              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => setSelectedId(job.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px minmax(0, 1fr) auto',
                    gap: 12,
                    alignItems: 'center',
                    width: '100%',
                    padding: 12,
                    borderRadius: 16,
                    border: selectedId === job.id ? `1px solid ${tone.fg}` : `1px solid ${tone.border}`,
                    background: selectedId === job.id ? '#fff7f8' : '#fff',
                    textAlign: 'left',
                    color: '#0f172a',
                    boxShadow: selectedId === job.id ? '0 10px 24px rgba(225, 29, 72, 0.08)' : 'none',
                  }}
                >
                  <img
                    src={job.previewSrc || job.originalUrl}
                    alt=""
                    style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 12, background: '#fff', border: '1px solid #e2e8f0' }}
                  />
                  <div>
                    <strong style={{ display: 'block', fontSize: 13, lineHeight: 1.35 }}>{job.fileName}</strong>
                    <span style={{ display: 'block', color: '#667085', fontSize: 12, lineHeight: 1.45 }}>
                      {job.matchedProduct ? `${job.matchedProduct.sku || job.matchedProduct.code} - ${job.matchedProduct.name}` : 'No SKU match yet'}
                    </span>
                    <small style={{ display: 'block', marginTop: 6, color: '#94a3b8', fontSize: 11 }}>
                      {statusLabel(job.status)} {job.matchReason ? `- ${job.matchReason}` : ''}
                    </small>
                  </div>
                  <span style={{ padding: '6px 9px', borderRadius: 999, fontSize: 11, fontWeight: 800, background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                    {statusLabel(job.status)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="adm-panel" style={{ margin: 0, display: 'grid', gap: 12 }}>
          <div className="adm-section-head" style={{ marginBottom: 0 }}>
            <div>
              <h3 className="adm-subtitle">Review screen</h3>
              <p className="adm-muted" style={{ fontSize: 12 }}>Compare original vs processed, then approve only when it is ready.</p>
            </div>
            <span style={{ padding: '6px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, background: previewTone.bg, color: previewTone.fg, border: `1px solid ${previewTone.border}` }}>
              {statusLabel(selectedJob?.status)}
            </span>
          </div>

          {!selectedJob ? (
            <div style={{ minHeight: 390, display: 'grid', placeItems: 'center', borderRadius: 16, border: '1px dashed #dbe4f0', background: '#fbfdff', color: '#64748b', textAlign: 'center', padding: 24 }}>
              <ScanSearch size={24} />
              <div>
                <strong style={{ display: 'block', color: '#0f172a', marginBottom: 6 }}>Select a job to inspect it</strong>
                <span>The original stays visible next to the cleaned ecommerce output.</span>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                <figure style={{ margin: 0, padding: 12, borderRadius: 16, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                  <figcaption style={{ marginBottom: 10, color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Original</figcaption>
                  <img
                    src={originalPreview}
                    alt={selectedJob.fileName}
                    style={{ width: '100%', minHeight: 280, objectFit: 'contain', borderRadius: 12, background: '#fff', border: '1px solid #e2e8f0' }}
                  />
                </figure>
                <figure style={{ margin: 0, padding: 12, borderRadius: 16, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                  <figcaption style={{ marginBottom: 10, color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Processed</figcaption>
                  {processedPreview ? (
                    <img
                      src={processedPreview}
                      alt={`${selectedJob.fileName} processed`}
                      style={{ width: '100%', minHeight: 280, objectFit: 'contain', borderRadius: 12, background: '#fff', border: '1px solid #e2e8f0' }}
                    />
                  ) : (
                    <div style={{ display: 'grid', placeItems: 'center', minHeight: 280, borderRadius: 12, background: '#fff', border: '1px solid #e2e8f0', color: '#94a3b8' }}>
                      Waiting for processing
                    </div>
                  )}
                </figure>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                <div style={{ padding: 14, borderRadius: 14, border: '1px solid #e2e8f0', background: '#fff' }}>
                  <span style={{ display: 'block', color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Matched SKU</span>
                  <strong style={{ display: 'block', marginTop: 6, fontSize: 20 }}>{selectedJob.matchedProduct?.sku || 'Unmatched'}</strong>
                </div>
                <div style={{ padding: 14, borderRadius: 14, border: '1px solid #e2e8f0', background: '#fff' }}>
                  <span style={{ display: 'block', color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Confidence</span>
                  <strong style={{ display: 'block', marginTop: 6, fontSize: 20 }}>
                    {selectedJob.metrics ? `${Math.round(selectedJob.metrics.confidence * 100)}%` : 'n/a'}
                  </strong>
                </div>
                <div style={{ padding: 14, borderRadius: 14, border: '1px solid #e2e8f0', background: '#fff' }}>
                  <span style={{ display: 'block', color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Foreground</span>
                  <strong style={{ display: 'block', marginTop: 6, fontSize: 20 }}>
                    {selectedJob.metrics ? `${Math.round(selectedJob.metrics.foregroundRatio * 100)}%` : 'n/a'}
                  </strong>
                </div>
                <div style={{ padding: 14, borderRadius: 14, border: '1px solid #e2e8f0', background: '#fff' }}>
                  <span style={{ display: 'block', color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Background</span>
                  <strong style={{ display: 'block', marginTop: 6, fontSize: 20 }}>
                    {selectedJob.metrics ? `${Math.round(selectedJob.metrics.backgroundRatio * 100)}%` : 'n/a'}
                  </strong>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(selectedJob.notes || []).map((note) => (
                  <span key={note} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 999, background: '#f8fafc', color: '#475467', border: '1px solid #e2e8f0' }}>
                    <ShieldCheck size={13} />
                    {note}
                  </span>
                ))}
              </div>

              {selectedJob.status === 'failed' && (
                <div style={{ padding: 14, borderRadius: 14, background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412' }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>Processing failed</strong>
                  <p style={{ margin: 0 }}>{selectedJob.error || 'This file did not process cleanly.'}</p>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'end' }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Manual SKU override</span>
                  <input
                    value={manualCode}
                    onChange={(event) => setManualCode(event.target.value)}
                    placeholder="Enter exact product code"
                    className="adm-field-input"
                  />
                </label>
                <button type="button" className="adm-btn-ghost" onClick={assignManualMatch}>
                  Apply match
                </button>
              </div>
              {manualMessage && <p className="adm-muted" style={{ fontSize: 13, margin: 0 }}>{manualMessage}</p>}

              <div>
                <span style={{ display: 'block', marginBottom: 8, color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Suggested matches</span>
                <div style={{ display: 'grid', gap: 8 }}>
                  {selectedJob.suggestions?.length ? selectedJob.suggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      onClick={() => {
                        setJobs((current) => current.map((job) => (
                          job.id === selectedJob.id
                            ? {
                              ...job,
                              matchedProduct: suggestion,
                              matchReason: 'Suggestion selected',
                            }
                            : job
                        )));
                        setManualMessage(`Matched to ${suggestion.sku || suggestion.code} - ${suggestion.name}`);
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 4,
                        padding: 12,
                        borderRadius: 14,
                        background: '#f8fafc',
                        border: '1px solid #e2e8f0',
                        textAlign: 'left',
                      }}
                    >
                      <strong style={{ fontSize: 13 }}>{suggestion.sku || suggestion.code}</strong>
                      <small style={{ color: '#64748b', fontSize: 11, lineHeight: 1.35 }}>{suggestion.name}</small>
                    </button>
                  )) : <p className="adm-muted" style={{ margin: 0 }}>No strong SKU suggestions yet.</p>}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                <button type="button" className="adm-btn-ghost" onClick={() => retryJob(selectedJob)}>
                  <RefreshCw size={14} /> Retry
                </button>
                <button type="button" className="adm-btn-ghost" onClick={() => downloadProcessed(selectedJob)} disabled={!selectedJob.processedSrc}>
                  <Download size={14} /> Download
                </button>
                <button type="button" className="adm-btn-ghost" onClick={() => rejectJob(selectedJob)}>
                  <X size={14} /> Remove
                </button>
                <button type="button" className="adm-btn-red" onClick={() => void approveJob(selectedJob)} disabled={!selectedJob.processedSrc || !selectedJob.matchedProduct?.product}>
                  <Check size={14} /> Approve and publish
                </button>
              </div>
            </>
          )}
        </section>

        <section className="adm-panel" style={{ margin: 0, display: 'grid', gap: 12 }}>
          <div className="adm-section-head" style={{ marginBottom: 0 }}>
            <div>
              <h3 className="adm-subtitle">Product catalog check</h3>
              <p className="adm-muted" style={{ fontSize: 12 }}>Search the live catalogue and confirm the product still has the original image until approval.</p>
            </div>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Search code or name</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Search size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search catalogue"
                className="adm-field-input"
              />
            </div>
          </label>

          <div style={{ display: 'grid', gap: 10, maxHeight: 760, overflow: 'auto', paddingRight: 4 }}>
            {catalogMatches.length === 0 ? (
              <p className="adm-muted">No catalogue matches found.</p>
            ) : catalogMatches.map((product) => {
              const currentJob = jobs.find((job) => job.matchedProduct?.product?.id === product.id);
              return (
                <div key={product.id || product.sku} style={{ padding: 14, borderRadius: 14, border: '1px solid #e2e8f0', background: '#fff', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: 'block', fontSize: 13 }}>{product.sku || product.code}</strong>
                    <span style={{ display: 'block', color: '#667085', fontSize: 12, lineHeight: 1.45 }}>{product.name}</span>
                  </div>
                  <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                    <b style={{ color: currentJob?.status === 'approved' ? '#15803d' : '#475467', fontSize: 12 }}>
                      {currentJob?.status === 'approved' ? 'Updated' : 'Original'}
                    </b>
                    <span className="adm-muted" style={{ fontSize: 11 }}>
                      {product.image || product.images?.[0] ? 'Image present' : 'No image yet'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
