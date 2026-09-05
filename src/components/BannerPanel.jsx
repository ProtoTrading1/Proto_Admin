import { useCallback, useEffect, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { fetchBanner, saveBanner, uploadBannerImage } from '../lib/banner';
import { BANNER_LABEL } from '../lib/bannerSpec';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

// Banner Editor — extracted from AdminPage so section state, effects and
// handlers live with the panel that renders them. AdminPage now mounts this
// only when the admin selects the "banner" section (see lazy import).
export default function BannerPanel({ onShowToast }) {
  const [form, setForm] = useState({ imageUrl: '' });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const toast = useCallback((message, type = 'success') => {
    onShowToast?.(message, type);
  }, [onShowToast]);

  const load = useCallback(async () => {
    try {
      const data = await fetchBanner({ force: true });
      setForm({ imageUrl: data.imageUrl || '' });
    } catch (err) {
      toast(err.message || 'Failed to load banner', 'error');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'banner') void load();
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load]);

  const handleImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadBannerImage(file);
      const next = { ...form, imageUrl: url };
      setForm(next);
      setSaving(true);
      try {
        const saved = await saveBanner(next);
        setForm({ imageUrl: saved.imageUrl || url });
        toast('Banner uploaded and saved — refresh the trade portal to see it.');
      } catch (err) {
        toast(err.message || 'Uploaded but save failed — click Save banner', 'error');
      } finally {
        setSaving(false);
      }
    } catch (err) {
      toast(err.message || 'Failed to upload image', 'error');
    } finally {
      setUploading(false);
    }
  };

  const removeBanner = async () => {
    setForm({ imageUrl: '' });
    setSaving(true);
    try {
      await saveBanner({ imageUrl: '' });
      toast('Banner removed — trade portal will show empty space.');
    } catch (err) {
      toast(err.message || 'Failed to remove banner', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="adm-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title">Banner Editor</h2>
          <p className="adm-section-note">
            Products page banner — upload a <strong>{BANNER_LABEL}</strong> image. It fills the full banner area on the trade portal.
            With no image uploaded, the site shows an empty space until you add one.
          </p>
        </div>
      </div>
      <div className="adm-responsive-2col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label className="adm-muted" style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Banner image — {BANNER_LABEL}</label>
            <label className="adm-btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <ImagePlus size={15} /> {uploading ? 'Uploading…' : `Upload banner (${BANNER_LABEL})`}
              <input type="file" accept="image/*" hidden onChange={(e) => { void handleImage(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {form.imageUrl && (
            <button
              type="button"
              className="adm-btn-ghost"
              disabled={saving}
              onClick={() => void removeBanner()}
            >
              Remove banner
            </button>
          )}
        </div>
        <div>
          <span className="adm-muted" style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Trade portal preview</span>
          <div className="adm-banner-preview-wrap">
            <div className="adm-banner-preview-chrome">
              <span>site.proto.co.za — Products</span>
            </div>
            <div className="catalog-page adm-banner-preview-page">
              <div className="site-hero-banner adm-banner-preview-hero">
                {form.imageUrl
                  ? <img src={form.imageUrl} alt="Banner preview" />
                  : <div className="adm-banner-preview-empty">No banner — empty space on live site</div>}
              </div>
              <div className="adm-banner-preview-grid">
                <div /><div /><div /><div />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
