import React, { useId, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { buildDeliveryLabel, copyDeliveryLabel } from '../lib/deliveryLabel.js';

export default function DeliveryLabelCopy({ customer }) {
  const label = buildDeliveryLabel(customer || {});
  const textArea = useRef(null);
  const id = useId();
  const [result, setResult] = useState(null);
  const [copying, setCopying] = useState(false);
  const status = result?.text === label.text ? result.message : '';

  async function copy() {
    setCopying(true);
    try {
      const format = await copyDeliveryLabel(label);
      setResult({ text: label.text, message: format === 'excel'
        ? `Copied. Click the first label cell in Excel, then press Ctrl+V.${label.warnings.length ? ' Check the address warnings before printing.' : ''}`
        : 'Copied as plain text. Set Excel destination cells to Text to keep phone and postal-code leading zeroes, then paste.' });
    } catch {
      textArea.current?.focus();
      textArea.current?.select();
      setResult({ text: label.text, message: 'Automatic copying was blocked. The label is selected: press Ctrl+C, then paste into Excel cells formatted as Text.' });
    } finally {
      setCopying(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} style={{ padding: 14, marginBottom: 14, background: 'white', border: '1px solid #d1d5db', borderRadius: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <h3 id={`${id}-heading`} style={{ margin: 0, fontSize: 15 }}>Delivery sticker</h3>
        <button type="button" className="adm-btn-ghost" onClick={copy} disabled={!label.canCopy || copying}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '8px 14px' }}>
          <Copy size={16} aria-hidden="true" />{copying ? 'Copying…' : 'Copy delivery label'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#475569', margin: '8px 0' }}>Values only, in sticker order. No TO, ATT, TEL or carton labels. {label.international ? 'Keep the destination country for international deliveries.' : 'Seven rows: company, street/building, town, province, postal code, contact and phone. Missing details stay blank so the rows do not shift.'}</p>
      <label htmlFor={`${id}-text`} style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Label text</label>
      <textarea id={`${id}-text`} ref={textArea} readOnly value={label.text} rows={Math.max(7, label.lines.length)}
        spellCheck={false} style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: 14, lineHeight: 1.5, padding: 10, border: '1px solid #cbd5e1', borderRadius: 6 }} />
      {label.warnings.length > 0 && <div role="alert" style={{ color: '#92400e', background: '#fffbeb', padding: 10, border: '1px solid #fcd34d', borderRadius: 6, fontSize: 12 }}><strong>Check before printing</strong><ul style={{ margin: '6px 0', paddingLeft: 18 }}>{label.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
      <p role="status" aria-live="polite" style={{ margin: '6px 0 0', fontSize: 13, color: '#334155' }}>{status}</p>
    </section>
  );
}
