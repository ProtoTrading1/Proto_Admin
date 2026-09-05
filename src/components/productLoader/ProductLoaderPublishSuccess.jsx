import { CheckCircle, ExternalLink, Upload } from 'lucide-react';

export default function ProductLoaderPublishSuccess({
  result,
  mainSiteUrl = 'https://site.proto.co.za',
  onOpenProduct,
  onUploadNext,
  onDone,
}) {
  if (!result?.sku) return null;

  const site = mainSiteUrl.replace(/\/$/, '');
  const productUrl = `${site}/products?search=${encodeURIComponent(result.sku)}`;

  return (
    <div className="pl-success-overlay" role="dialog" aria-modal="true">
      <div className="pl-success-card">
        <CheckCircle size={48} color="#16a34a" />
        <h2>Product Published Successfully</h2>
        <p><strong>{result.sku}</strong> is now live on the website.</p>
        <div className="pl-action-row pl-action-row--center">
          <a className="adm-btn-ghost" href={productUrl} target="_blank" rel="noopener noreferrer" onClick={onOpenProduct}>
            <ExternalLink size={14} /> Open Product
          </a>
          <button type="button" className="adm-btn-ghost" onClick={onUploadNext}>
            <Upload size={14} /> Upload Next
          </button>
          <button type="button" className="adm-btn-ghost" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
