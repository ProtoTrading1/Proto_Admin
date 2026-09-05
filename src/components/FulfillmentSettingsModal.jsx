import { useEffect, useMemo, useState } from 'react';
import { Check, Crown, Loader2, Plus, Trash2, X } from 'lucide-react';
import { fetchFulfillmentUsers, saveFulfillmentUsers } from '../lib/fulfillmentUsers';
import { LEGACY_NAV_ALIASES } from '../lib/taxonomy';

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `user-${Date.now()}`;
}

function normalizeAssignedCategoryIds(categoryIds = []) {
  const out = new Set();
  for (const id of categoryIds) {
    if (!id) continue;
    out.add(id);
    const mapped = LEGACY_NAV_ALIASES[id];
    if (mapped) out.add(mapped);
  }
  return [...out];
}

function canonicalCategoryIdsForSave(categoryIds = [], taxonomyTree = []) {
  const validIds = new Set((taxonomyTree || []).map((c) => c.id));
  validIds.add('uncategorized');
  const out = new Set();
  for (const id of categoryIds) {
    if (!id) continue;
    const mapped = LEGACY_NAV_ALIASES[id] || id;
    if (validIds.has(mapped)) out.add(mapped);
    else if (validIds.has(id)) out.add(id);
  }
  return [...out];
}

function buildMainCategories(taxonomyTree) {
  const mains = (taxonomyTree || []).map((c) => ({ id: c.id, label: c.label }));
  if (!mains.some((c) => c.id === 'uncategorized')) {
    mains.push({ id: 'uncategorized', label: 'Other / Uncategorized' });
  }
  return mains;
}

/** Mirror of the server-side phone normalisation so the user sees the saved shape live. */
function toWatiPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+27${digits.slice(1)}`;
  return `+${digits}`;
}

function isValidWatiPhone(raw) {
  const digits = toWatiPhone(raw).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function emptyUser() {
  return {
    id: `user-${Date.now()}`,
    name: '',
    whatsapp: '',
    isAdmin: false,
    categoryIds: [],
  };
}

export default function FulfillmentSettingsModal({ open, onClose, taxonomyTree = [] }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const mainCategories = useMemo(() => buildMainCategories(taxonomyTree), [taxonomyTree]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchFulfillmentUsers()
      .then((rows) => {
        if (cancelled) return;
        setUsers(rows.map((u) => ({
          ...u,
          isAdmin: Boolean(u.isAdmin),
          categoryIds: normalizeAssignedCategoryIds(
            Array.isArray(u.categoryIds) ? u.categoryIds.filter(Boolean) : [],
          ),
        })));
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const updateUser = (idx, patch) => {
    setUsers((prev) => prev.map((u, i) => (i === idx ? { ...u, ...patch } : u)));
  };

  const toggleCategory = (idx, catId) => {
    setUsers((prev) => prev.map((u, i) => {
      if (i !== idx) return u;
      const has = (u.categoryIds || []).includes(catId);
      return {
        ...u,
        categoryIds: has
          ? u.categoryIds.filter((id) => id !== catId)
          : [...(u.categoryIds || []), catId],
      };
    }));
  };

  const addUser = () => setUsers((prev) => [...prev, emptyUser()]);

  const removeUser = (idx) => setUsers((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = users.map((u) => ({
        id: u.id || slugify(u.name),
        name: u.name.trim(),
        whatsapp: toWatiPhone(u.whatsapp),
        isAdmin: Boolean(u.isAdmin),
        categoryIds: canonicalCategoryIdsForSave(u.categoryIds, taxonomyTree),
      }));
      if (payload.some((u) => !u.name)) throw new Error('Every team member needs a name.');
      const badPhone = payload.find((u) => u.whatsapp && !isValidWatiPhone(u.whatsapp));
      if (badPhone) throw new Error(`"${badPhone.name}" needs a valid phone number (e.g. 071 729 2861 or +27717292861).`);
      const noCats = payload.find((u) => !u.isAdmin && u.categoryIds.length === 0);
      if (noCats) throw new Error(`"${noCats.name}" needs at least one category (or make them a team admin).`);
      const saved = await saveFulfillmentUsers(payload);
      setUsers(saved.map((u) => ({
        ...u,
        isAdmin: Boolean(u.isAdmin),
        categoryIds: Array.isArray(u.categoryIds) ? u.categoryIds.filter(Boolean) : [],
      })));
      onClose(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };


  if (!open) return null;

  return (
    <div className="adm-modal-backdrop" onClick={() => onClose(false)}>
      <div className="adm-modal adm-modal--form adm-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-header">
          <h3 className="adm-modal-title">Fulfillment team</h3>
          <button type="button" className="adm-modal-close" onClick={() => onClose(false)} aria-label="Close"><X size={18} /></button>
        </div>
        <p className="adm-modal-note">
          Tap categories to assign them. Team admins can tick items in <strong>every</strong> category on the fulfillment page.
        </p>

        <div className="adm-modal-body adm-ff-settings">
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Loader2 size={24} className="star-spinning" />
            </div>
          )}
          {!loading && users.map((user, idx) => {
            const normalized = toWatiPhone(user.whatsapp);
            const phoneOk = !user.whatsapp || isValidWatiPhone(user.whatsapp);
            return (
              <div key={user.id || idx} className={`adm-ff-card${user.isAdmin ? ' adm-ff-card--admin' : ''}`}>
                <div className="adm-ff-card__head">
                  <div className="adm-ff-card__identity">
                    <input
                      className="adm-ff-card__name"
                      value={user.name}
                      onChange={(e) => updateUser(idx, { name: e.target.value, id: user.id || slugify(e.target.value) })}
                      placeholder="Name"
                    />
                    {user.isAdmin && <span className="adm-ff-admin-badge"><Crown size={11} /> Team admin</span>}
                  </div>
                  <div className="adm-ff-card__head-actions">
                    <button
                      type="button"
                      className={`adm-ff-admin-toggle${user.isAdmin ? ' adm-ff-admin-toggle--on' : ''}`}
                      onClick={() => updateUser(idx, { isAdmin: !user.isAdmin })}
                      title="Team admins can tick items in any category"
                    >
                      <Crown size={13} />
                      {user.isAdmin ? 'Admin' : 'Make admin'}
                    </button>
                    <button type="button" className="adm-icon-btn" onClick={() => removeUser(idx)} title="Remove user" style={{ color: '#c40000' }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="adm-ff-card__phone">
                  <span className="adm-field-label">Phone</span>
                  <input
                    className={`adm-field-input${!phoneOk ? ' adm-field-input--error' : ''}`}
                    value={user.whatsapp}
                    onChange={(e) => updateUser(idx, { whatsapp: e.target.value })}
                    placeholder="071 729 2861 or +27717292861"
                    inputMode="tel"
                  />
                  {user.whatsapp && normalized && (
                    <span className={`adm-ff-phone-preview${phoneOk ? '' : ' adm-ff-phone-preview--bad'}`}>
                      {phoneOk ? <>Saved as <strong>{normalized}</strong></> : 'Number looks too short — include the area code'}
                    </span>
                  )}
                </div>

                <div className="adm-ff-card__cats">
                  <span className="adm-field-label">
                    Categories {user.isAdmin && <em className="adm-muted" style={{ fontWeight: 400 }}>(admins can tick all categories regardless)</em>}
                  </span>
                  <div className="adm-ff-chip-grid">
                    {mainCategories.map((cat) => {
                      const active = (user.categoryIds || []).includes(cat.id);
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          className={`adm-ff-chip${active ? ' adm-ff-chip--on' : ''}`}
                          onClick={() => toggleCategory(idx, cat.id)}
                        >
                          {active && <Check size={12} strokeWidth={3} />}
                          {cat.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          {!loading && (
            <button type="button" className="adm-btn-ghost adm-ff-add-user" onClick={addUser}>
              <Plus size={15} /> Add team member
            </button>
          )}
          {error && <p style={{ color: '#c40000', fontSize: 13, margin: '8px 0 0' }}>{error}</p>}
        </div>

        <div className="adm-modal-footer adm-modal-footer--end">
          <div className="adm-modal-footer__actions">
            <button type="button" className="adm-btn-ghost" onClick={() => onClose(false)}>Cancel</button>
            <button type="button" className="adm-btn-red" onClick={() => void handleSave()} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save team'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
