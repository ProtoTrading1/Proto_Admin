import { useState } from 'react';
import { ClipboardList, Info, Loader2, Star, UserCheck, UserPlus, X } from 'lucide-react';
import { addCustomerManually } from '../lib/customers';

const SECTIONS = [
  {
    value: 'approved',
    label: 'Approved trade customer',
    hint: 'Creates a login account, marked approved. A welcome email with a set-password link is sent. No code is assigned.',
    Icon: UserCheck,
  },
  {
    value: 'approved-10000',
    label: 'Approved + 10000 club',
    hint: 'Same as approved, plus the “10000 club” tag.',
    Icon: Star,
  },
  {
    value: 'pre-registration',
    label: 'Pre-registration (10000 club list)',
    hint: 'Adds them to the allowlist. When they sign up they auto-approve, get the “10000 club” tag and receive the welcome email.',
    Icon: ClipboardList,
  },
];

export default function AddCustomerModal({ open, onClose, onAdded, onShowToast }) {
  const [section, setSection] = useState('approved');
  const [form, setForm] = useState({
    email: '', name: '', business_name: '', contact_name: '', phone: '',
    monthly_spend: '', account_code: '',
  });
  const [saving, setSaving] = useState(false);
  if (!open) return null;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const isPreReg = section === 'pre-registration' || section === '10000-club';

  const submit = async () => {
    const email = form.email.trim().toLowerCase();
    if (!email || !email.includes('@')) { onShowToast?.('Enter a valid email', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        section,
        email,
        name: form.name.trim() || form.business_name.trim(),
        business_name: form.business_name.trim(),
        contact_name: form.contact_name.trim(),
        phone: form.phone.trim(),
      };
      if (form.monthly_spend.trim()) payload.monthly_spend = form.monthly_spend.trim();
      if (isPreReg && form.account_code.trim()) payload.account_code = form.account_code.trim();
      const res = await addCustomerManually(payload);
      const where = res.section === 'pre-registration' ? 'Pre-registration' : 'Approved customers';
      const mail = res.welcomeEmail === 'sent' ? ' Welcome email sent.' : '';
      onShowToast?.(`Added to ${where}.${mail}`, 'success');
      onAdded?.(res);
      onClose?.();
      setForm({ email: '', name: '', business_name: '', contact_name: '', phone: '', monthly_spend: '', account_code: '' });
    } catch (err) {
      onShowToast?.(err.message || 'Failed to add customer', 'error');
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel = { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 };

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose?.()}>
      <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2, paddingBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <h3 className="adm-modal-title"><UserPlus size={18} style={{ verticalAlign: '-3px', marginRight: 6 }} />Add customer</h3>
            <button type="button" className="adm-modal-close" onClick={() => onClose?.()} aria-label="Close"><X size={18} /></button>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Add someone manually and choose where they land.</p>
        </div>

        <div className="adm-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ ...fieldLabel, marginBottom: 8 }}>Where should they go?</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SECTIONS.map(({ value, label, hint, Icon }) => {
                const active = section === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSection(value)}
                    style={{
                      display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'left', width: '100%',
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                      border: `1.5px solid ${active ? '#8B1A1A' : '#e5e7eb'}`,
                      background: active ? '#fdf2f2' : '#fff',
                      boxShadow: active ? '0 1px 4px rgba(139,26,26,0.10)' : 'none',
                      transition: 'border-color .12s, background .12s, box-shadow .12s',
                    }}
                  >
                    <span style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                      background: active ? '#8B1A1A' : '#f3f4f6', color: active ? '#fff' : '#6b7280',
                    }}>
                      <Icon size={18} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#111827', fontSize: 14 }}>
                        {label}
                        {active && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#8B1A1A', flexShrink: 0 }} />}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginTop: 3, lineHeight: 1.45 }}>{hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={fieldLabel}>Email *</label>
              <input className="adm-field-input" type="email" value={form.email} onChange={set('email')} placeholder="customer@business.co.za" />
            </div>
            <div>
              <label style={fieldLabel}>Business name</label>
              <input className="adm-field-input" value={form.business_name} onChange={set('business_name')} />
            </div>
            <div>
              <label style={fieldLabel}>Contact name</label>
              <input className="adm-field-input" value={form.contact_name} onChange={set('contact_name')} />
            </div>
            {/* Phone + monthly spend only apply to a real approved account —
                the pre-registration allowlist ignores them. */}
            {!isPreReg && (
              <>
                <div>
                  <label style={fieldLabel}>Phone</label>
                  <input className="adm-field-input" value={form.phone} onChange={set('phone')} placeholder="+27…" />
                </div>
                <div>
                  <label style={fieldLabel}>Monthly spend</label>
                  <input className="adm-field-input" value={form.monthly_spend} onChange={set('monthly_spend')} />
                </div>
              </>
            )}
            {isPreReg && (
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={fieldLabel}>Account reference (optional)</label>
                <input className="adm-field-input" value={form.account_code} onChange={set('account_code')} placeholder="Positill account code — reference only, not a customer code" />
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 9, padding: '10px 12px' }}>
            <Info size={15} style={{ color: '#94a3b8', marginTop: 1, flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
              No customer code is set here — allocate it later from the customer’s profile. Saving the code is what sends the confirmation email.
            </p>
          </div>
        </div>

        <div className="adm-modal-footer adm-modal-footer--end">
          <div className="adm-modal-footer__actions">
            <button type="button" className="adm-btn-ghost" onClick={() => onClose?.()} disabled={saving}>Cancel</button>
            <button type="button" className="adm-btn-red" onClick={() => void submit()} disabled={saving}>
              {saving ? <><Loader2 size={14} className="spin" /> Adding…</> : <><UserPlus size={14} /> Add customer</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
