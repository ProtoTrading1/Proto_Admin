import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * Small overflow menu for secondary/infrequent toolbar actions, so a header
 * shows one or two primary buttons instead of a cluttered row. Click-outside
 * and Escape close it.
 *
 * items: [{ label, icon?, onClick, danger?, disabled?, hidden? }]
 */
export default function ActionMenu({ label = 'More', items = [], align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const visible = items.filter((i) => i && !i.hidden);

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
        className="adm-btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={14} /> {label}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            [align]: 0,
            minWidth: 200,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            padding: 4,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {visible.map((item, idx) => (
            <button
              key={item.label || idx}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onClick?.(); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 6,
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                opacity: item.disabled ? 0.5 : 1,
                color: item.danger ? '#c40000' : '#111827',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? '#fef2f2' : '#f3f4f6'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
