import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Inbox, Link2, Loader2, Send, Users } from 'lucide-react';
import AdminSelect from '../AdminSelect';
import { BUSINESS_TYPES } from '../../lib/businessTypes';
import { formatCount } from '../../lib/whatsappFormat';

/**
 * WhatsApp broadcast composer.
 *
 * A broadcast is always an APPROVED WATI template, not free text. Outside a
 * 24-hour customer-initiated window WhatsApp silently drops non-template
 * messages, so a free-text box would report a successful send of 1 500 messages
 * that nobody received.
 *
 * The audience is counted by asking the server to dry-run the real resolver
 * before anything is sent, so the number on the button is the number that will
 * be messaged — including who is being held back and why.
 */

const MERGE_FIELDS = [
  { token: '{{name}}', label: 'Contact name, falling back to the business' },
  { token: '{{first_name}}', label: 'First name only' },
  { token: '{{business_name}}', label: 'Business name' },
  { token: '{{link}}', label: 'This recipient’s tracked link' },
];

export default function WhatsappComposer({ onShowToast, initialPhones = [], onSent }) {
  const [templates, setTemplates] = useState([]);
  const [unavailable, setUnavailable] = useState([]);
  const [configured, setConfigured] = useState(true);
  const [templatesMessage, setTemplatesMessage] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  const [templateName, setTemplateName] = useState('');
  const [parameters, setParameters] = useState({});
  const [trackedUrl, setTrackedUrl] = useState('');
  const [broadcastName, setBroadcastName] = useState('');

  const [audience, setAudience] = useState(initialPhones.length ? 'selected' : 'all');
  const [businessType, setBusinessType] = useState('');
  const [phones] = useState(initialPhones);

  const [preview, setPreview] = useState(null);
  const [counting, setCounting] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/whatsapp-templates');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error || 'Could not load WATI templates');
        setTemplates(json.templates || []);
        setUnavailable(json.unavailable || []);
        setConfigured(json.configured !== false);
        setTemplatesMessage(json.message || '');
      } catch (err) {
        if (!cancelled) onShowToast?.(err.message || 'Could not load WATI templates', 'error');
      } finally {
        if (!cancelled) setLoadingTemplates(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onShowToast]);

  const template = useMemo(() => templates.find((t) => t.name === templateName) || null, [templates, templateName]);

  // Switching template invalidates the old positional parameters — {{2}} in one
  // template is not {{2}} in another, and keeping them would send the wrong
  // words under a template that happens to have the same arity.
  useEffect(() => { setParameters({}); }, [templateName]);

  const countAudience = useCallback(async () => {
    setCounting(true);
    try {
      const res = await fetch('/api/whatsapp-broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dryRun: true,
          audience,
          businessTypes: audience === 'business-type' && businessType ? [businessType] : [],
          phones: audience === 'selected' ? phones : [],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not count this audience');
      setPreview(json);
    } catch (err) {
      onShowToast?.(err.message || 'Could not count this audience', 'error');
      setPreview(null);
    } finally {
      setCounting(false);
    }
  }, [audience, businessType, phones, onShowToast]);

  useEffect(() => { void countAudience(); }, [countAudience]);

  const missingParams = (template?.placeholders || [])
    .filter((index) => !String(parameters[String(index)] || '').trim());

  const usesLink = Object.values(parameters).some((value) => String(value || '').includes('{{link}}'));
  const trackedUrlMissing = usesLink && !/^https:\/\//i.test(trackedUrl.trim());

  const renderedBody = useMemo(() => String(template?.body || '')
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => parameters[index] || match), [template, parameters]);

  const canSend = configured
    && Boolean(templateName)
    && missingParams.length === 0
    && !trackedUrlMissing
    && Number(preview?.total || 0) > 0
    && !sending;

  const send = async () => {
    const count = Number(preview?.total || 0);
    if (!window.confirm(
      `Send the "${templateName}" WhatsApp template to ${formatCount(count)} customer${count === 1 ? '' : 's'}?\n\n`
      + 'This sends immediately and cannot be recalled.',
    )) return;

    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/whatsapp-broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audience,
          businessTypes: audience === 'business-type' && businessType ? [businessType] : [],
          phones: audience === 'selected' ? phones : [],
          templateName,
          templateLanguage: template?.language || null,
          templateBody: template?.body || '',
          broadcastName: broadcastName.trim(),
          parameters,
          trackedUrl: usesLink ? trackedUrl.trim() : '',
        }),
      });
      const json = await res.json();
      if (!res.ok && !json.total) throw new Error(json.error || 'Broadcast failed');
      setResult(json);
      onShowToast?.(
        `Broadcast sent to ${formatCount(json.sent)} of ${formatCount(json.total)} contacts${json.failed ? ` · ${formatCount(json.failed)} failed` : ''}`,
        json.failed ? 'error' : 'success',
      );
      onSent?.(json);
    } catch (err) {
      onShowToast?.(err.message || 'Broadcast failed', 'error');
    } finally {
      setSending(false);
    }
  };

  if (loadingTemplates) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 4px', color: '#6b7280', fontSize: 13 }}>
        <Loader2 size={16} className="spin" /> Loading your approved WhatsApp templates…
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, alignItems: 'start' }}>
      <div>
        {!configured && (
          <Notice tone="warn">
            <strong>WATI is not connected.</strong> {templatesMessage || 'Set WATI_API_TOKEN in Vercel to load your approved templates.'}
          </Notice>
        )}
        {configured && templates.length === 0 && (
          <Notice tone="warn">
            <strong>No approved templates in WATI.</strong> WhatsApp only delivers pre-approved
            templates to a customer outside a live conversation, so a broadcast needs at least one
            approved template. Create one in WATI and submit it for approval.
            {unavailable.length > 0 && (
              <div style={{ marginTop: 6 }}>
                Waiting on approval: {unavailable.map((t) => `${t.name} (${t.status.toLowerCase()})`).join(', ')}
              </div>
            )}
          </Notice>
        )}

        <Field label="Template">
          <AdminSelect
            ariaLabel="WhatsApp template"
            value={templateName}
            onChange={setTemplateName}
            minWidth={280}
            options={[
              { value: '', label: templates.length ? 'Choose an approved template…' : 'No approved templates' },
              ...templates.map((t) => ({ value: t.name, label: `${t.name}${t.category ? ` · ${t.category.toLowerCase()}` : ''}` })),
            ]}
          />
          {template && (
            <p className="adm-muted" style={{ fontSize: 12, margin: '8px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {template.body}
            </p>
          )}
        </Field>

        {template && template.placeholders.length > 0 && (
          <Field label={`Template values (${template.placeholders.length})`}>
            {template.placeholders.map((index) => (
              <div key={index} style={{ marginBottom: 8 }}>
                <label className="adm-muted" style={{ fontSize: 11, display: 'block', marginBottom: 3 }}>
                  {`{{${index}}}`}
                </label>
                <input
                 
                  value={parameters[String(index)] || ''}
                  onChange={(e) => setParameters((prev) => ({ ...prev, [String(index)]: e.target.value }))}
                  placeholder={index === 1 ? 'e.g. {{name}} or October specials' : 'Value for this placeholder'}
                  style={inputStyle}
                />
              </div>
            ))}
            <details style={{ fontSize: 12, marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', color: '#475569' }}>Merge fields you can type into a value</summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#64748b', lineHeight: 1.7 }}>
                {MERGE_FIELDS.map((field) => (
                  <li key={field.token}><code>{field.token}</code> — {field.label}</li>
                ))}
              </ul>
            </details>
          </Field>
        )}

        {usesLink && (
          <Field label="Tracked link destination">
            <input
             
              value={trackedUrl}
              onChange={(e) => setTrackedUrl(e.target.value)}
              placeholder="https://proto.co.za/specials"
              style={inputStyle}
            />
            <p className="adm-muted" style={{ fontSize: 12, margin: '6px 0 0', lineHeight: 1.5 }}>
              <Link2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              Each customer gets their own short link that redirects here, so Analytics can show
              exactly who clicked. WhatsApp itself does not report clicks.
            </p>
            {trackedUrlMissing && (
              <p style={{ fontSize: 12, color: '#991b1b', margin: '6px 0 0' }}>
                A full <code>https://</code> URL is needed because a value uses <code>{'{{link}}'}</code>.
              </p>
            )}
          </Field>
        )}

        <Field label="Broadcast name (for your own records)">
          <input
           
            value={broadcastName}
            onChange={(e) => setBroadcastName(e.target.value)}
            placeholder={templateName ? `${templateName} — ${new Date().toLocaleDateString('en-ZA')}` : 'October specials'}
            style={inputStyle}
          />
        </Field>
      </div>

      <div>
        <Field label="Audience">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Radio name="wa-audience" checked={audience === 'all'} onChange={() => setAudience('all')} label="Everyone who opted in to WhatsApp" />
            <Radio name="wa-audience" checked={audience === 'business-type'} onChange={() => setAudience('business-type')} label="One business type" />
            {audience === 'business-type' && (
              <div style={{ paddingLeft: 24 }}>
                <AdminSelect
                  ariaLabel="Business type"
                  value={businessType}
                  onChange={setBusinessType}
                  options={[{ value: '', label: 'Choose a business type…' }, ...BUSINESS_TYPES.map((t) => ({ value: t, label: t }))]}
                />
              </div>
            )}
            <Radio
              name="wa-audience"
              checked={audience === 'selected'}
              onChange={() => setAudience('selected')}
              disabled={!phones.length}
              label={phones.length ? `The ${phones.length} contact${phones.length === 1 ? '' : 's'} you ticked` : 'Selected contacts (tick some in Contacts first)'}
            />
          </div>
        </Field>

        <div style={{ padding: '14px 16px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 14 }}>
          {counting ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#64748b' }}>
              <Loader2 size={14} className="spin" /> Counting this audience…
            </div>
          ) : (
            <>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'Outfit', sans-serif", color: '#111827' }}>
                {formatCount(preview?.total || 0)}
              </div>
              <div className="adm-muted" style={{ fontSize: 12 }}>
                <Users size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                consented, reachable WhatsApp numbers
              </div>
              {preview?.skipped?.length > 0 && <SkippedBreakdown skipped={preview.skipped} />}
            </>
          )}
        </div>

        {renderedBody && (
          <Field label="Preview">
            <div style={{
              background: '#dcf8c6', border: '1px solid #b7e0a0', borderRadius: '12px 12px 12px 2px',
              padding: '10px 13px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: '#1f2937',
            }}
            >
              {renderedBody}
            </div>
            <p className="adm-muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
              Merge fields are filled per recipient when the message is sent.
            </p>
          </Field>
        )}

        {missingParams.length > 0 && (
          <Notice tone="warn">
            Fill in {missingParams.map((index) => `{{${index}}}`).join(', ')} before sending — WhatsApp
            rejects a template with an empty variable.
          </Notice>
        )}

        <button
          type="button"
          className="adm-btn-red"
          style={{ fontSize: 14, padding: '11px 20px', width: '100%', opacity: canSend ? 1 : 0.5 }}
          disabled={!canSend}
          onClick={() => void send()}
        >
          {sending ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
          <span style={{ marginLeft: 8 }}>
            {sending ? 'Sending…' : `Send to ${formatCount(preview?.total || 0)} contact${Number(preview?.total) === 1 ? '' : 's'}`}
          </span>
        </button>

        {result && (
          <div style={{ marginTop: 14, padding: '12px 14px', background: result.failed ? '#fef2f2' : '#f0fdf4', border: `1px solid ${result.failed ? '#fecaca' : '#bbf7d0'}`, borderRadius: 10, fontSize: 13, lineHeight: 1.6 }}>
            <strong>{formatCount(result.sent)}</strong> sent
            {result.failed > 0 && <> · <strong>{formatCount(result.failed)}</strong> failed</>}
            {result.skipped?.length > 0 && <> · {formatCount(result.skipped.length)} held back</>}
            {result.errors?.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#991b1b', fontSize: 12 }}>
                {result.errors.slice(0, 5).map((e) => <li key={e.phone}>{e.phone}: {e.error}</li>)}
              </ul>
            )}
            <p className="adm-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
              Delivered, read and click figures arrive over the next few minutes — see Analytics.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8,
  fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
};

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Radio({ name, checked, onChange, label, disabled }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: disabled ? '#94a3b8' : '#334155', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} style={{ accentColor: '#dc2626' }} />
      {label}
    </label>
  );
}

function Notice({ tone, children }) {
  const tones = {
    warn: { bg: '#fef3c7', border: '#f59e0b', fg: '#92400e' },
    info: { bg: '#eff6ff', border: '#bfdbfe', fg: '#1e40af' },
  };
  const style = tones[tone] || tones.info;
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px', marginBottom: 14, background: style.bg, border: `1px solid ${style.border}`, borderRadius: 10, color: style.fg, fontSize: 12.5, lineHeight: 1.55 }}>
      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

/**
 * Who is NOT getting this, grouped by reason. Shown before the send, because a
 * count that quietly shrank from 1 566 to 1 412 is the thing an admin most needs
 * explained.
 */
function SkippedBreakdown({ skipped }) {
  const byReason = skipped.reduce((acc, row) => {
    const reason = row.reason || 'Not reachable';
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
  return (
    <details style={{ marginTop: 10, fontSize: 12 }}>
      <summary style={{ cursor: 'pointer', color: '#475569' }}>
        <Inbox size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
        {formatCount(skipped.length)} opted-in contact{skipped.length === 1 ? '' : 's'} held back
      </summary>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#64748b', lineHeight: 1.7 }}>
        {Object.entries(byReason)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => <li key={reason}>{formatCount(count)} — {reason}</li>)}
      </ul>
    </details>
  );
}
