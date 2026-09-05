import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { sendEmailTemplateTest } from '../lib/customers';

const TEMPLATES = [
  { key: 'welcome', label: 'Welcome / approval' },
  { key: 'order_confirmation', label: 'Order confirmation' },
  { key: 'trade_application', label: 'Trade application ack' },
];

/**
 * Send a test copy of each system (transactional) email template to yourself.
 * The campaign/broadcast test lives in the composer above; these cover the
 * automated emails that otherwise only fire on real events.
 */
export default function EmailTemplateTests({ adminEmail = '', onShowToast }) {
  const [to, setTo] = useState(adminEmail);
  const [sending, setSending] = useState('');

  const send = async (template) => {
    const recipient = (to || adminEmail || '').trim();
    if (!recipient || !recipient.includes('@')) { onShowToast?.('Enter an email to send the test to', 'error'); return; }
    setSending(template);
    try {
      await sendEmailTemplateTest({ template, to: recipient });
      onShowToast?.(`Test "${template.replace(/_/g, ' ')}" sent to ${recipient}`, 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Test send failed', 'error');
    } finally {
      setSending('');
    }
  };

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginTop: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>System email templates</div>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#6b7280' }}>
        Send a test of each automated email to yourself. Uses sample data.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>Send to</label>
        <input
          className="adm-input"
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="you@proto.co.za"
          style={{ maxWidth: 280 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            className="adm-btn-ghost adm-btn--sm"
            disabled={Boolean(sending)}
            onClick={() => void send(t.key)}
          >
            {sending === t.key ? <><Loader2 size={14} className="spin" /> Sending…</> : <><Send size={14} /> {t.label}</>}
          </button>
        ))}
      </div>
    </div>
  );
}
