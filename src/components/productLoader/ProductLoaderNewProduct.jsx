import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, PackagePlus, Trash2, UploadCloud } from 'lucide-react';
import CategoryPathSelect from './CategoryPathSelect';
import { publishNewProduct, uploadProductImageSlot } from '../../lib/productLoaderApi';
import SellingUnitField from '../SellingUnitField';

const SLOTS = [1, 2, 3, 4];
const emptyImages = () => SLOTS.map((slot) => ({ slot, url: '', name: '', uploading: false, error: '' }));

/**
 * Author a brand-new product — title, price, category and all four image slots
 * in one pass — with no ERP/catalogue match required. Publishes straight to
 * website_stock via /api/product-loader-publish (requireNew guards against
 * clobbering an existing SKU).
 */
export default function ProductLoaderNewProduct({ taxonomyTree = [], publishedBy = '', onShowToast, onPublished }) {
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [barcode, setBarcode] = useState('');
  const [description, setDescription] = useState('');
  const [unitsOfIssue, setUnitsOfIssue] = useState('EACH');
  const [packDescription, setPackDescription] = useState('');
  const [stockQty, setStockQty] = useState('');
  const [categoryPathIds, setCategoryPathIds] = useState([]);
  const [images, setImages] = useState(emptyImages);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const fileRefs = useRef({});

  // Match the storage-path sanitisation in upload-product-image + the publish
  // endpoint so the code the admin sees is exactly the SKU that gets stored.
  const sku = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

  // Images upload under the product code (`${SKU}/${slot}`), so if the code
  // changes any already-uploaded slot points at the wrong path — clear them.
  const lastSkuRef = useRef(sku);
  useEffect(() => {
    if (lastSkuRef.current !== sku) {
      lastSkuRef.current = sku;
      setImages(emptyImages());
    }
  }, [sku]);

  const setSlot = (slot, patch) => {
    setImages((prev) => prev.map((img) => (img.slot === slot ? { ...img, ...patch } : img)));
  };

  const handleFile = async (slot, file) => {
    if (!file || !file.type?.startsWith('image/')) return;
    if (!sku) { setError('Enter the product code before uploading images.'); return; }
    setError('');
    const uploadSku = sku;
    setSlot(slot, { uploading: true, error: '', name: file.name });
    try {
      const { url } = await uploadProductImageSlot({ file, sku: uploadSku, slot });
      // If the code changed while this upload was in flight, the image lives
      // under the old SKU's path — drop the result rather than attaching it.
      if (lastSkuRef.current !== uploadSku) return;
      setSlot(slot, { url, uploading: false });
    } catch (err) {
      if (lastSkuRef.current !== uploadSku) return;
      setSlot(slot, { uploading: false, error: err.message || 'Upload failed' });
    }
  };

  const clearSlot = (slot) => {
    setSlot(slot, { url: '', name: '', error: '' });
    if (fileRefs.current[slot]) fileRefs.current[slot].value = '';
  };

  const uploadedCount = images.filter((i) => i.url).length;
  const anyUploading = images.some((i) => i.uploading);
  const hasPrimary = Boolean(images.find((i) => i.slot === 1)?.url);

  const reset = () => {
    setCode(''); setTitle(''); setPrice(''); setBarcode(''); setDescription('');
    setUnitsOfIssue('EACH'); setPackDescription('');
    setStockQty(''); setCategoryPathIds([]); setImages(emptyImages()); setError('');
    Object.values(fileRefs.current).forEach((el) => { if (el) el.value = ''; });
  };

  const canPublish = Boolean(sku && title.trim() && Number(price) > 0 && categoryPathIds.length && hasPrimary && !anyUploading && !publishing);

  const handlePublish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    setError('');
    try {
      const result = await publishNewProduct({
        code: sku,
        title,
        price,
        barcode,
        description,
        unitsOfIssue,
        packDescription,
        stockQty,
        images: images.filter((i) => i.url).map((i) => ({ slot: i.slot, url: i.url })),
        categoryPathIds,
        taxonomyTree,
        publishedBy,
      });
      onShowToast?.(`Created ${result.sku} with ${uploadedCount} image${uploadedCount === 1 ? '' : 's'} — now live`, 'success');
      onPublished?.({ ...result, imageCount: uploadedCount });
      reset();
    } catch (err) {
      const msg = err.message || 'Publish failed';
      setError(msg);
      onShowToast?.(msg, 'error');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="pl-newproduct">
      <p className="adm-section-note" style={{ marginTop: 0 }}>
        Create a product that isn’t in Positill or the catalogue yet — enter its details, drop in up to four images, and
        publish it live in one step. Slot 1 is the main image.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        <label className="adm-field">
          <span className="adm-field-label">Product code (SKU) *</span>
          <input className="adm-field-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. TBAG91" autoCapitalize="characters" />
        </label>
        <label className="adm-field">
          <span className="adm-field-label">Barcode</span>
          <input className="adm-field-input" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder={sku ? `defaults to ${sku}` : 'defaults to the code'} />
        </label>
        <label className="adm-field">
          <span className="adm-field-label">Title *</span>
          <input className="adm-field-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Product name shown on the site" />
        </label>
        <label className="adm-field">
          <span className="adm-field-label">Website price incl. VAT (ZAR) *</span>
          <input className="adm-field-input" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
        </label>
        <label className="adm-field">
          <span className="adm-field-label">Opening stock qty</span>
          <input className="adm-field-input" type="number" min="0" step="1" value={stockQty} onChange={(e) => setStockQty(e.target.value)} placeholder="0" />
        </label>
        <SellingUnitField
          value={unitsOfIssue}
          onChange={setUnitsOfIssue}
          id="new-product-selling-unit-options"
        />
        <label className="adm-field">
          <span className="adm-field-label">Pack description</span>
          <input className="adm-field-input" value={packDescription} onChange={(e) => setPackDescription(e.target.value)} placeholder="Optional carton or packaging detail" />
        </label>
      </div>

      <div className="adm-field" style={{ marginBottom: 16 }}>
        <span className="adm-field-label">Category *</span>
        <div className="pl-category-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <CategoryPathSelect
            taxonomyTree={taxonomyTree}
            value={categoryPathIds}
            onChange={setCategoryPathIds}
            mainLabel="Category"
            mainPlaceholder="— Select category —"
          />
        </div>
      </div>

      <label className="adm-field" style={{ marginBottom: 16 }}>
        <span className="adm-field-label">Description</span>
        <textarea className="adm-field-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — shown on the product card" style={{ resize: 'vertical' }} />
      </label>

      <div className="adm-field-label" style={{ marginBottom: 8 }}>Images {sku ? '' : '(enter the code first)'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 }}>
        {images.map((img) => (
          <div
            key={img.slot}
            style={{
              border: `1.5px dashed ${img.error ? '#dc2626' : '#cbd5e1'}`, borderRadius: 12, padding: 10,
              background: '#f8fafc', minHeight: 150, display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: img.slot === 1 ? '#dc2626' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {img.slot === 1 ? 'Main image' : `Slot ${img.slot}`}
              </span>
              {img.url && (
                <button type="button" onClick={() => clearSlot(img.slot)} title="Remove" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 0 }}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {img.url ? (
              <img src={img.url} alt={`Slot ${img.slot}`} style={{ width: '100%', height: 96, objectFit: 'contain', borderRadius: 8, background: '#fff', border: '1px solid #e2e8f0' }} />
            ) : (
              <button
                type="button"
                onClick={() => fileRefs.current[img.slot]?.click()}
                disabled={!sku || img.uploading}
                style={{
                  flex: 1, border: 'none', background: '#fff', borderRadius: 8, cursor: sku ? 'pointer' : 'not-allowed',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                  color: '#94a3b8', fontSize: 12, minHeight: 96, opacity: sku ? 1 : 0.6,
                }}
              >
                {img.uploading ? <Loader2 size={20} className="spin" /> : <UploadCloud size={20} />}
                {img.uploading ? 'Uploading…' : 'Upload image'}
              </button>
            )}
            {img.error && <span style={{ fontSize: 11, color: '#dc2626' }}>{img.error}</span>}
            <input
              ref={(el) => { fileRefs.current[img.slot] = el; }}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(img.slot, e.target.files?.[0])}
            />
          </div>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" className="adm-btn-red" onClick={handlePublish} disabled={!canPublish} style={{ opacity: canPublish ? 1 : 0.55 }}>
          {publishing ? <><Loader2 size={15} className="spin" style={{ marginRight: 6, verticalAlign: -2 }} /> Publishing…</> : <><PackagePlus size={15} style={{ marginRight: 6, verticalAlign: -2 }} /> Create &amp; publish product</>}
        </button>
        <span className="adm-muted" style={{ fontSize: 12 }}>
          <ImagePlus size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          {uploadedCount}/4 images · {canPublish ? 'ready to publish' : 'code, title, price, category and the main image are required'}
        </span>
      </div>
    </div>
  );
}
