import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Value-bound dropdown styled to match the admin UI (mirrors ActionMenu's
 * popover). Replaces native <select className="adm-select"> so filters look
 * consistent instead of rendering the OS-native control.
 *
 * options: [{ value, label }]
 * Keyboard: Enter/Space/↓ opens; ↑/↓ move; Enter selects; Escape closes.
 */
export default function AdminSelect({ value, onChange, options = [], ariaLabel, minWidth = 200, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const ref = useRef(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => {
    if (open) setActiveIdx(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (val) => { onChange?.(val); setOpen(false); };

  const onTriggerKey = (e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[activeIdx]; if (o) choose(o.value); }
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="adm-btn-ghost adm-btn--sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth, justifyContent: 'space-between' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.label ?? ''}</span>
        <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            [align]: 0,
            minWidth,
            maxHeight: 320,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            padding: 4,
            zIndex: 50,
          }}
        >
          {options.map((o, idx) => {
            const isSel = o.value === value;
            const isActive = idx === activeIdx;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => choose(o.value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  background: isActive ? '#f3f4f6' : 'transparent',
                  textAlign: 'left',
                  fontSize: 13,
                  fontWeight: isSel ? 700 : 600,
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: '#111827',
                }}
              >
                <Check size={14} style={{ flexShrink: 0, opacity: isSel ? 1 : 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
