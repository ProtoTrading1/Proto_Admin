import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Check } from 'lucide-react';

/**
 * Compact filter dropdown for a toolbar. Replaces a row of loose filter
 * checkboxes with a single "Filter" button that opens a panel of toggle
 * options. The panel stays open while you toggle multiple options; click
 * outside or Escape closes it. A badge shows how many filters are active.
 *
 * options: [{ key, label, checked, onChange, accentColor?, hint? }]
 */
export default function FilterMenu({ label = 'Filter', options = [], align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const visible = options.filter(Boolean);
  const activeCount = visible.filter((o) => o.checked).length;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!visible.length) return null;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className={`adm-btn-ghost adm-btn--sm${activeCount > 0 ? ' adm-tab--active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={14} /> {label}
        {activeCount > 0 && (
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 18, height: 18, padding: '0 5px', marginLeft: 2,
              borderRadius: 9, background: '#8B1A1A', color: '#fff',
              fontSize: 11, fontWeight: 700, lineHeight: 1,
            }}
          >
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            [align]: 0,
            minWidth: 230,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            padding: 6,
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={{ padding: '4px 8px 6px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#9ca3af' }}>
            Filter view
          </div>
          {visible.map((opt) => (
            <label
              key={opt.key}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '8px 8px', borderRadius: 7, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, marginTop: 1, borderRadius: 5, flexShrink: 0,
                  border: `1.5px solid ${opt.checked ? (opt.accentColor || '#8B1A1A') : '#cbd5e1'}`,
                  background: opt.checked ? (opt.accentColor || '#8B1A1A') : '#fff',
                  transition: 'background .12s, border-color .12s',
                }}
              >
                {opt.checked && <Check size={13} color="#fff" strokeWidth={3} />}
              </span>
              <input
                type="checkbox"
                checked={opt.checked}
                onChange={(e) => opt.onChange?.(e.target.checked)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{opt.label}</span>
                {opt.hint && <span style={{ fontSize: 11, color: '#6b7280' }}>{opt.hint}</span>}
              </span>
            </label>
          ))}
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => visible.forEach((o) => o.checked && o.onChange?.(false))}
              style={{
                marginTop: 4, padding: '7px 8px', border: 'none', borderTop: '1px solid #f1f5f9',
                background: 'transparent', textAlign: 'left', fontSize: 12, fontWeight: 600,
                color: '#6b7280', cursor: 'pointer', borderRadius: 6,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#111827'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#6b7280'; }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
