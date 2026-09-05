import { useRef, useState } from 'react';
import {
  Archive,
  ExternalLink,
  ImagePlus,
  Loader2,
  PackagePlus,
  Upload,
  X,
} from 'lucide-react';
import { isImageFile, websiteStatusLabel } from '../../lib/parseIntakeFilename';
import { archiveLoaderImageItem, lookupFilenames, logPublishFailure, publishLoaderImageItem } from '../../lib/productLoaderApi';
import { catalogueDisplayTitle, loaderCodeLabel } from '../../lib/productLoaderDisplay.js';
import LoaderCodeEllipsis from './LoaderCodeEllipsis.jsx';
import CategoryPathSelect from './CategoryPathSelect';
import SellingUnitField from '../SellingUnitField';
import { loaderPriceSourceLabel, loaderPriceUsesCachedData } from '../../../lib/catalogue-price.mjs';

function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

export default function ProductLoaderSingleImage({
  taxonomyTree,
  batchDefaultPathIds,
  setBatchDefaultPathIds,
  batchOverwrite,
  setBatchOverwrite,
  onShowToast,
  onPublished,
  mainSiteUrl = 'https://site.proto.co.za',
}) {
  const inputRef = useRef(null);
  const [item, setItem] = useState(null);
  const [preview, setPreview] = useState('');
  const [scanning, setScanning] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [unitsOfIssueDraft, setUnitsOfIssueDraft] = useState('EACH');

  const clear = () => {
    if (preview) {
      try { URL.revokeObjectURL(preview); } catch { /* ignore */ }
    }
    setPreview('');
    setItem(null);
    setError('');
    setDescriptionDraft('');
    setUnitsOfIssueDraft('EACH');
  };

  const handleSelect = async (fileList) => {
    const file = [...(fileList || [])].filter(isImageFile)[0];
    if (!file) {
      setError('Please choose an image file (JPG, PNG, or WebP).');
      return;
    }
    setScanning(true);
    setError('');
    clear();
    try {
      const [row] = await lookupFilenames([file.name], [file]);
      if (!row) throw new Error('Lookup failed');
      setItem({ ...row, file });
      setPreview(URL.createObjectURL(file));
      setDescriptionDraft(catalogueDisplayTitle(row) || '');
      setUnitsOfIssueDraft(row.unitsOfIssue || 'EACH');
      if (row.canPublish) {
        onShowToast?.(`Matched ${row.code}`, 'success');
      } else {
        onShowToast?.('Could not match filename to catalogue — you can still send it to Archive', 'warning');
      }
    } catch (err) {
      setError(err.message || 'Lookup failed');
    } finally {
      setScanning(false);
    }
  };

  const handleArchive = async () => {
    if (!item?.code) return;
    setArchiving(true);
    setError('');
    try {
      await archiveLoaderImageItem({ ...item, descriptionOverride: descriptionDraft.trim() });
      onShowToast?.(`Archived ${item.code} — find it in Product Manager → Archive`, 'success');
      clear();
    } catch (err) {
      setError(err.message || 'Archive failed');
    } finally {
      setArchiving(false);
    }
  };

  const handlePublish = async () => {
    if (!item || item.group === 'not_found') return;
    setProcessing(true);
    setError('');
    try {
      await publishLoaderImageItem({
        ...item,
        descriptionOverride: descriptionDraft.trim(),
        unitsOfIssue: unitsOfIssueDraft,
      }, {
        taxonomyTree,
        findNode,
        defaultCategoryPathIds: batchDefaultPathIds,
        overwrite: batchOverwrite,
      });
      onPublished?.({ sku: item.code, filename: item.filename, action: item.websiteRow ? 'update' : 'create' });
      clear();
    } catch (err) {
      setError(err.message || 'Publish failed');
      await logPublishFailure({ sku: item.code, filename: item.filename, reason: err.message });
    } finally {
      setProcessing(false);
    }
  };

  const soh = item?.stockOnHand ?? item?.sqlRow?.available ?? item?.websiteRow?.available_stock ?? '—';
  const status = item?.websiteStatus || 'not_found';
  const isLive = status === 'live';

  return (
    <div className="pl-section">
      <p className="pl-section-note">
        Name the file with the product code — e.g. <code>ME039.2.jpg</code>, <code>ME039 (1).jpg</code>, or <code>ME039 FRONT.jpg</code>.
      </p>

      <div
        className="pl-dropzone"
        role="button"
        tabIndex={0}
        onClick={() => !scanning && !processing && inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => { void handleSelect(e.target.files); e.target.value = ''; }}
        />
        {scanning ? (
          <span><Loader2 size={16} className="spin" /> Looking up product…</span>
        ) : (
          <span><ImagePlus size={16} /> Choose image</span>
        )}
      </div>

      {error && <p className="pl-error">{error}</p>}

      {item && (
        <article className="pl-preview-card">
          <div className="pl-preview-card-body">
            {preview && (
              <div className="pl-preview-thumb">
                <img src={preview} alt="" />
              </div>
            )}
            <div className="pl-preview-meta">
              <span className={`pl-status-badge pl-status-badge--${status}`}>{websiteStatusLabel(status)}</span>
              <label style={{ display: 'block', margin: '6px 0 4px' }}>
                <span className="adm-muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Description (editable)</span>
                <input
                  type="text"
                  className="adm-input"
                  value={descriptionDraft}
                  placeholder={catalogueDisplayTitle(item) || 'Product description'}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  style={{ width: '100%', fontWeight: 700 }}
                />
              </label>
              <dl className="pl-meta-grid">
                <div><dt>SKU</dt><dd><LoaderCodeEllipsis value={loaderCodeLabel(item)} /></dd></div>
                <div><dt>Department</dt><dd>{item.department || item.sqlRow?.dept || '—'}</dd></div>
                <div><dt>Category</dt><dd>{item.category || item.websiteRow?.category || '—'}</dd></div>
                <div><dt>Website incl. VAT</dt><dd>R{Number(item.price ?? 0).toFixed(2)}</dd></div>
                <div><dt>Price source</dt><dd>{item.priceSourceLabel || loaderPriceSourceLabel(item.priceSource)}</dd></div>
                <div><dt>ERP ex VAT</dt><dd>{item.erpPriceExVat != null ? `R${Number(item.erpPriceExVat).toFixed(2)}` : '—'}</dd></div>
                <div><dt>SOH</dt><dd>{soh}</dd></div>
                <div><dt>Slot</dt><dd>{item.imageSlot}</dd></div>
              </dl>
              <div style={{ marginTop: 10 }}>
                <SellingUnitField
                  value={unitsOfIssueDraft}
                  onChange={setUnitsOfIssueDraft}
                  id="single-loader-selling-unit-options"
                />
              </div>
              {item.parseError && <p className="pl-error">Invalid filename — {item.parseError}</p>}
              {item.group === 'not_found' && !item.parseError && (
                <p className="pl-error">Product not found in Positill or website catalogue — you can still send it to Archive and fix the code later.</p>
              )}
              {loaderPriceUsesCachedData(item.priceSource) && (
                <p className="pl-error">Live Positill was unavailable. This cached price must be reviewed; publishing a new product will wait for the live connection.</p>
              )}
            </div>
          </div>

          {item.group !== 'not_found' && !item.websiteRow?.category && (
            <div className="pl-inline-fields">
              <CategoryPathSelect
                taxonomyTree={taxonomyTree}
                value={batchDefaultPathIds}
                onChange={setBatchDefaultPathIds}
                mainLabel="Category (required for new products)"
                mainPlaceholder="— Select —"
              />
              <label className="pl-check">
                <input type="checkbox" checked={batchOverwrite} onChange={(e) => setBatchOverwrite(e.target.checked)} />
                Replace image if slot already filled
              </label>
            </div>
          )}

          <div className="pl-action-row">
            {item.group !== 'not_found' && (
              <button type="button" className="adm-btn-red" disabled={processing || archiving} onClick={() => void handlePublish()}>
                {processing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                Publish Live
              </button>
            )}
            {item.code && !item.parseError && (
              <button type="button" className="adm-btn-ghost" disabled={processing || archiving} onClick={() => void handleArchive()}>
                {archiving ? <Loader2 size={14} className="spin" /> : <Archive size={14} />}
                Send to Archive
              </button>
            )}
            {isLive && (
              <a className="adm-btn-ghost" href={`${mainSiteUrl.replace(/\/$/, '')}/products?search=${encodeURIComponent(item.code)}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} /> View Website
              </a>
            )}
            <button type="button" className="adm-btn-ghost" onClick={clear}>
              <X size={14} /> Cancel
            </button>
          </div>
        </article>
      )}
    </div>
  );
}
