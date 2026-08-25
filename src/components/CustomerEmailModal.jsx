import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart2, Code2, Eye, ImagePlus, Loader2, Mail, Send, X } from 'lucide-react';
import EmailTemplateTests from './EmailTemplateTests';
import { PROTO_URLS } from '../lib/protoUrls';
import { BUSINESS_TYPES } from '../lib/businessTypes';
import {
  MERGE_TAGS,
  PREVIEW_MERGE_VARS,
  applyMergeTags,
  buildEmailBodyHtml,
  wrapBroadcastHtml,
} from '../lib/emailMergeTags';

/**
 * Two audiences, deliberately. Approved trade customers are the real customer
 * base; a group is an uploaded list that is not customers at all. The old
 * middle ground (trade requests, pre-registration, "approved + pre-reg") made
 * it far too easy to mail the wrong people.
 *
 * 'selected' is not offered here — it exists only for the "Email selected"
 * action on the contacts list, which supplies the addresses itself.
 */
const AUDIENCE_OPTIONS = [
  {
    value: 'all-approved',
    label: 'Approved trade customers',
    hint: 'Everyone with trade portal access',
  },
];

/** Split a pasted/typed blob into unique lowercase email addresses. */
export function parseEmailList(raw) {
  return [...new Set(
    String(raw || '')
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
  )];
}

/**
 * Only two audiences exist now, so the customer tab no longer preselects a
 * third. Opening the composer from the trade-requests tab used to default to
 * a "requests" audience that the dropdown can no longer even show — which
 * would have left an unsendable value selected.
 */
function defaultAudienceForTab() {
  return 'all-approved';
}

function insertAtCursor(textarea, insertValue) {
  if (!textarea) return insertValue;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const next = `${textarea.value.slice(0, start)}${insertValue}${textarea.value.slice(end)}`;
  const pos = start + insertValue.length;
  textarea.value = next;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  return next;
}

function MergeTagBar({ onInsert }) {
  return (
    <div className="adm-email-merge-bar">
      <span className="adm-email-merge-bar__label">Insert field</span>
      <div className="adm-email-merge-bar__chips">
        {MERGE_TAGS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="adm-email-merge-chip"
            onClick={() => onInsert(`{{${key}}}`)}
            title={`Insert {{${key}}}`}
          >
            {label}
          </button>
        ))}
        {/* Not a personalization field: it renders a link, not a value. Kept
            alongside the others because this bar is where you reach for
            "something the send fills in for me". */}
        <button
          type="button"
          className="adm-email-merge-chip"
          onClick={() => onInsert('{{unsubscribe}}')}
          title="Insert an unsubscribe link. Use {{unsubscribe_url}} for the bare URL in your own markup."
        >
          Unsubscribe
        </button>
      </div>
    </div>
  );
}

export default function CustomerEmailModal({
  open,
  onClose,
  customerTab,
  onSend,
  onShowToast,
  adminEmail = '',
  initialAudience = null,
  initialBusinessTypes = null,
  initialRecipients = null,
  initialGroupId = null,
}) {
  const [subject, setSubject] = useState('');
  const [introBody, setIntroBody] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [htmlPane, setHtmlPane] = useState('split');
  const [showHtml, setShowHtml] = useState(false);
  const [audience, setAudience] = useState('all-approved');
  const [groupsError, setGroupsError] = useState('');
  const [businessTypes, setBusinessTypes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [sending, setSending] = useState(false);
  const [testSending, setTestSending] = useState(false);
  // Explicit "send a test first?" step — a browser prompt() was easy to miss
  // and impossible to correct, so the address is a real field.
  const [showPreview, setShowPreview] = useState(false);
  const [wantTest, setWantTest] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [recipientsText, setRecipientsText] = useState('');
  const selectedEmails = useMemo(() => parseEmailList(recipientsText), [recipientsText]);

  const subjectRef = useRef(null);
  const introRef = useRef(null);
  const htmlRef = useRef(null);
  const imageRef = useRef(null);
  const activeFieldRef = useRef('intro');

  // Seed targeting ONCE when the modal opens. Depending on the initial* props
  // (fresh array refs each parent render) would re-run this on every render and
  // wipe the form mid-edit, so it keys only on `open` and reads the rest via
  // closure at open time.
  useEffect(() => {
    if (!open) return;
    setHtmlPane('split');
    setShowHtml(false);
    setWantTest(false);
    setShowPreview(false);
    setTestEmail(adminEmail || '');
    const recips = Array.isArray(initialRecipients) ? initialRecipients.filter(Boolean) : [];
    if (recips.length) {
      setAudience('selected');
      setRecipientsText(recips.join('\n'));
      setBusinessTypes([]);
    } else {
      setAudience(initialAudience || defaultAudienceForTab());
      setGroupId(initialGroupId || '');
      setRecipientsText('');
      const types = Array.isArray(initialBusinessTypes) ? initialBusinessTypes.filter(Boolean) : [];
      setBusinessTypes(types);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Delivery analytics for recent campaigns, shown inside the compose modal.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/email-campaigns')
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setCampaigns(json.campaigns || []); })
      .catch(() => { if (!cancelled) setCampaigns([]); });
    return () => { cancelled = true; };
  }, [open]);

  const recentCampaigns = useMemo(() => (campaigns || []).slice(0, 3), [campaigns]);

  const handleAttachImage = async (file) => {
    if (!file) return;
    setUploadingImage(true);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/upload-reference-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, contentType: file.type || 'image/jpeg' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Image upload failed');
      const imgTag = `<p style="margin:16px 0;"><img src="${json.url}" alt="" style="max-width:100%;border-radius:8px;" /></p>`;
      setHtmlBody((prev) => (prev ? `${prev}\n${imgTag}` : imgTag));
      setShowHtml(true);
      if (htmlPane === 'preview') setHtmlPane('split');
      onShowToast?.('Image attached to the email body', 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Image upload failed', 'error');
    } finally {
      setUploadingImage(false);
    }
  };

  // Paste or drag an image straight into the body — uploads and embeds it.
  const handleBodyPaste = (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type?.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void handleAttachImage(file);
          return;
        }
      }
    }
  };

  const handleBodyDrop = (e) => {
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type?.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void handleAttachImage(file);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/email-groups');
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(json.error || 'Groups could not be loaded');
        setGroups(json.groups || []);
        setGroupsError('');
      } catch (err) {
        // Never swallowed: without this the group list silently stays empty
        // with nothing on screen to say why.
        if (alive) setGroupsError(err?.message || 'Groups could not be loaded');
      }
    })();
    return () => { alive = false; };
  }, [open]);

  // Groups appear directly in the Audience list. A separate "which upload?"
  // field only showed up once Pre-registration was already selected, so it was
  // invisible to anyone who did not already know to go looking for it.
  const audienceOptions = useMemo(() => {
    const base = AUDIENCE_OPTIONS.map((o) => ({ ...o }));
    const groupOptions = groups
      .filter((g) => g.memberCount > 0)
      .map((g) => ({
        value: `group::${g.id}`,
        label: `Group — ${g.name} (${g.memberCount})`,
        hint: g.description || `The ${g.memberCount} contacts uploaded to ${g.name}. Not customers.`,
      }));
    return [...base, ...groupOptions];
  }, [groups]);

  const audienceValue = audience === 'group' && groupId ? `group::${groupId}` : audience;

  const onAudienceChange = (raw) => {
    const [aud, id = ''] = String(raw).split('::');
    setAudience(aud);
    setGroupId(aud === 'group' ? id : '');
    // A group has no business_type to filter on, so any selection would only
    // ever empty the send. Clear it rather than silently ignore it.
    if (aud === 'group') setBusinessTypes([]);
  };

  const selectedAudience = useMemo(
    () => audienceOptions.find((opt) => opt.value === audienceValue) || audienceOptions[0],
    [audienceOptions, audienceValue],
  );


  const previewSubject = useMemo(
    () => applyMergeTags(subject.trim() || 'Subject line', PREVIEW_MERGE_VARS),
    [subject],
  );

  const previewBodyHtml = useMemo(
    () => buildEmailBodyHtml(
      { introText: introBody, htmlBlock: htmlBody },
      PREVIEW_MERGE_VARS,
      { unsubscribeUrl: PROTO_URLS.unsubscribe },
    )
      || '<p style="color:#9ca3af;margin:0;">Write a message body and/or HTML block to preview.</p>',
    [introBody, htmlBody],
  );

  const fullPreviewDoc = useMemo(
    () => wrapBroadcastHtml({
      subject: previewSubject,
      bodyHtml: previewBodyHtml,
      siteUrl: PROTO_URLS.publicSite,
      registerUrl: PROTO_URLS.register,
    }),
    [previewSubject, previewBodyHtml],
  );

  if (!open) return null;

  const insertMergeTag = (token) => {
    const field = activeFieldRef.current;
    if (field === 'subject' && subjectRef.current) {
      setSubject(insertAtCursor(subjectRef.current, token));
      return;
    }
    if (field === 'html' && htmlRef.current) {
      setHtmlBody(insertAtCursor(htmlRef.current, token));
      return;
    }
    if (introRef.current) {
      activeFieldRef.current = 'intro';
      setIntroBody(insertAtCursor(introRef.current, token));
    }
  };


  const handleSend = async (test = false) => {
    if (!subject.trim()) {
      onShowToast?.('Subject is required', 'error');
      return;
    }
    if (!introBody.trim() && !htmlBody.trim()) {
      onShowToast?.('Write a message body and/or HTML block', 'error');
      return;
    }

    const isSelected = audience === 'selected';
    if (!test && isSelected && !selectedEmails.length) {
      onShowToast?.('Enter at least one valid email address', 'error');
      return;
    }

    // Name the group in the confirm dialog — sending to 246 contacts instead
    // of all 593 should not be a silent difference.
    const audienceLabel = isSelected
      ? `${selectedEmails.length} specific ${selectedEmails.length === 1 ? 'person' : 'people'}`
      : audience === 'group'
        ? selectedAudience.label
        : `${selectedAudience.label}${businessTypes.length ? ` · ${businessTypes.join(', ')} only` : ' · all business types'}`;
    if (!test && !window.confirm(`Send this email to: ${audienceLabel}?`)) return;

    if (test) {
      // A test is a self-preview with sample merge data + a [TEST] subject, so
      // it goes to the ONE address typed below — never to a real customer.
      if (!testEmail.trim() || !parseEmailList(testEmail).length) {
        onShowToast?.('Enter a valid email address to send the test to', 'error');
        return;
      }
      setTestSending(true);
      try {
        await onSend({
          audience,
          subject: subject.trim(),
          introText: introBody.trim(),
          htmlBlock: htmlBody.trim(),
          testEmail: testEmail.trim(),
          businessTypes: isSelected || audience === 'group' ? [] : businessTypes,
          groupId: audience === 'group' ? groupId : '',
        });
        onShowToast?.(`Test email sent to ${testEmail.trim()}`, 'success');
      } catch (err) {
        onShowToast?.(err.message || 'Test send failed', 'error');
      } finally {
        setTestSending(false);
      }
      return;
    }

    setSending(true);
    try {
      const result = await onSend({
        audience,
        subject: subject.trim(),
        introText: introBody.trim(),
        htmlBlock: htmlBody.trim(),
        businessTypes: isSelected || audience === 'group' ? [] : businessTypes,
        groupId: audience === 'group' ? groupId : '',
        ...(isSelected ? { recipients: selectedEmails } : {}),
      });
      onShowToast?.(
        `Sent to ${result.sent} ${isSelected ? 'recipient' : 'customer'}(s)${result.failed ? ` — ${result.failed} failed` : ''}`,
        result.failed ? 'error' : 'success',
      );
      onClose?.();
    } catch (err) {
      onShowToast?.(err.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const showHtmlEditor = htmlPane !== 'preview';
  const showHtmlPreview = htmlPane !== 'code';

  return (
    <div className="adm-modal-backdrop" onClick={onClose}>
      <div
        className="adm-modal adm-modal--form adm-email-modal adm-email-modal--html"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="customer-email-title"
      >
        <div className="adm-modal-header">
          <div>
            <h3 id="customer-email-title" className="adm-modal-title">
              <Mail size={18} /> Send email via Brevo
            </h3>
            <p className="adm-email-modal__lead">
              Write the message, then Send. Fields like {'{{name}}'} are filled in per customer.
            </p>
          </div>
          <button type="button" className="adm-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="adm-modal-body adm-email-modal__body">
          {recentCampaigns.length > 0 && (
            <div className="adm-email-field" style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' }}>
              <span className="adm-email-field__label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <BarChart2 size={14} /> Recent delivery analytics
              </span>
              {recentCampaigns.map((c, idx) => {
                const ev = c.events || {};
                const sent = c.sent || c.recipientCount || 0;
                const pct = (part) => (sent ? `${Math.round(((part || 0) / sent) * 100)}%` : '0%');
                return (
                  <div key={c.id || idx} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, padding: '4px 0', borderTop: idx ? '1px solid #eef2f7' : 'none' }}>
                    <strong style={{ minWidth: 140, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject || c.audience || 'Campaign'}</strong>
                    <span>{sent} sent</span>
                    <span style={{ color: '#15803d' }}>{ev.delivered || 0} delivered ({pct(ev.delivered)})</span>
                    <span>{ev.opened || 0} opened ({pct(ev.opened)})</span>
                    <span>{ev.clicked || 0} clicked</span>
                    <span style={{ color: (ev.bounced || 0) ? '#b91c1c' : '#6b7280' }}>{ev.bounced || 0} bounced</span>
                  </div>
                );
              })}
            </div>
          )}

          <label className="adm-email-field">
            <span className="adm-email-field__label">Audience</span>
            <select
              className="adm-field-input adm-select--enhanced"
              value={audienceValue}
              onChange={(e) => onAudienceChange(e.target.value)}
            >
              {audienceOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <span className="adm-email-field__hint">
              {selectedAudience.hint}
              {groupsError ? ` — groups unavailable: ${groupsError}` : ''}
            </span>
          </label>

          {audience === 'selected' && (
            <label className="adm-email-field">
              <span className="adm-email-field__label">
                Recipients{selectedEmails.length ? ` — ${selectedEmails.length} valid` : ''}
              </span>
              <textarea
                className="adm-field-input"
                rows={3}
                value={recipientsText}
                onChange={(e) => setRecipientsText(e.target.value)}
                placeholder="Enter email addresses, separated by commas, spaces or new lines"
                style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                {adminEmail && (
                  <button
                    type="button"
                    className="adm-btn-ghost adm-btn--sm"
                    onClick={() => setRecipientsText((prev) => (
                      parseEmailList(prev).includes(adminEmail.toLowerCase())
                        ? prev
                        : `${prev ? `${prev.trim()}\n` : ''}${adminEmail}`
                    ))}
                  >
                    + Add my email ({adminEmail})
                  </button>
                )}
                <span className="adm-email-field__hint" style={{ margin: 0 }}>
                  Known customers get their {'{{name}}'} filled in; unknown addresses still send.
                </span>
              </div>
            </label>
          )}

          {audience !== 'selected' && audience !== 'group' && (
          <div className="adm-email-field">
            <span className="adm-email-field__label">
              Business type
              {businessTypes.length > 0 && (
                <button type="button" className="ce-types__clear" onClick={() => setBusinessTypes([])}>
                  Clear ({businessTypes.length})
                </button>
              )}
            </span>
            {/* Checkboxes rather than a single select: segments overlap in
                practice — a campaign for retail usually wants gift and craft
                shops too. An empty list still means everyone. */}
            <div className="ce-types">
              {BUSINESS_TYPES.map((type) => {
                const on = businessTypes.includes(type);
                return (
                  <label key={type} className={`ce-type${on ? ' ce-type--on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setBusinessTypes((prev) => (
                        prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
                      ))}
                    />
                    {type}
                  </label>
                );
              })}
            </div>
            <span className="adm-email-field__hint">
              {businessTypes.length
                ? `Only ${businessTypes.join(', ')} customers will receive it.`
                : 'Nothing ticked — sends to every customer in this audience.'}
            </span>
          </div>
          )}

          <div className="adm-email-field">
            <span className="adm-email-field__label">Subject</span>
            <input
              ref={subjectRef}
              className="adm-field-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onFocus={() => { activeFieldRef.current = 'subject'; }}
              placeholder="Proto Trading update for {{business_name}}"
            />
          </div>

          <div className="adm-email-field adm-email-field--intro">
            <span className="adm-email-field__label">Message</span>
            <textarea
              ref={introRef}
              className="adm-field-input adm-email-modal__textarea"
              rows={6}
              value={introBody}
              onChange={(e) => setIntroBody(e.target.value)}
              onFocus={() => { activeFieldRef.current = 'intro'; }}
              onPaste={handleBodyPaste}
              onDrop={handleBodyDrop}
              onDragOver={(e) => e.preventDefault()}
              placeholder={'Hi {{name}},\n\nWe have an update for {{business_name}}…'}
              spellCheck
            />
            <div className="adm-email-field__row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <MergeTagBar onInsert={insertMergeTag} />
              <input
                ref={imageRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => { void handleAttachImage(e.target.files?.[0]); e.target.value = ''; }}
              />
              <button
                type="button"
                className="adm-btn-ghost"
                style={{ fontSize: 12, padding: '4px 10px' }}
                disabled={uploadingImage}
                onClick={() => imageRef.current?.click()}
                title="Upload an image and embed it in the email"
              >
                {uploadingImage ? <Loader2 size={13} className="spin" /> : <ImagePlus size={13} />}
                Attach image
              </button>
            </div>
            <span className="adm-email-field__hint">Fields like {'{{name}}'} are filled per customer. Blank lines start new paragraphs.</span>
          </div>

          {!showHtml && (
            <button
              type="button"
              className="adm-btn-ghost"
              style={{ alignSelf: 'flex-start', fontSize: 12 }}
              onClick={() => setShowHtml(true)}
            >
              <Code2 size={13} style={{ marginRight: 4 }} /> Add HTML / banner (optional)
            </button>
          )}
          {showHtml && (
          <div className="adm-email-field">
            <div className="adm-email-field__row">
              <span className="adm-email-field__label">
                <Code2 size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
                HTML block (optional)
              </span>
              <button
                type="button"
                className="adm-btn-ghost"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => { setShowHtml(false); setHtmlBody(''); }}
              >
                Remove
              </button>
              <div className="adm-email-pane-toggle" role="tablist" aria-label="HTML editor view">
                <button
                  type="button"
                  className={`adm-email-pane-toggle__btn${htmlPane === 'code' ? ' adm-email-pane-toggle__btn--active' : ''}`}
                  onClick={() => setHtmlPane('code')}
                >
                  HTML code
                </button>
                <button
                  type="button"
                  className={`adm-email-pane-toggle__btn${htmlPane === 'split' ? ' adm-email-pane-toggle__btn--active' : ''}`}
                  onClick={() => setHtmlPane('split')}
                >
                  Split view
                </button>
                <button
                  type="button"
                  className={`adm-email-pane-toggle__btn${htmlPane === 'preview' ? ' adm-email-pane-toggle__btn--active' : ''}`}
                  onClick={() => setHtmlPane('preview')}
                >
                  Preview only
                </button>
              </div>
            </div>

            <div className={`adm-email-split${htmlPane === 'split' ? ' adm-email-split--split' : ''}`}>
              {showHtmlEditor && (
                <div className="adm-email-split__editor">
                  <textarea
                    ref={htmlRef}
                    className="adm-field-input adm-email-modal__textarea adm-email-modal__textarea--html"
                    rows={12}
                    value={htmlBody}
                    onChange={(e) => setHtmlBody(e.target.value)}
                    onFocus={() => { activeFieldRef.current = 'html'; }}
                    onPaste={handleBodyPaste}
                    onDrop={handleBodyDrop}
                    onDragOver={(e) => e.preventDefault()}
                    placeholder={'<table>...</table>\n<p>Optional rich HTML banner or template below your message body.</p>'}
                    spellCheck={false}
                  />
                  <MergeTagBar onInsert={insertMergeTag} />
                </div>
              )}
              {showHtmlPreview && (
                <div className="adm-email-split__preview">
                  <div className="adm-email-preview adm-email-preview--full">
                    <div className="adm-email-preview__chrome">
                      <div className="adm-email-preview__chrome-row">
                        <span className="adm-email-preview__chrome-label">To</span>
                        <span className="adm-email-preview__chrome-value">{PREVIEW_MERGE_VARS.email}</span>
                      </div>
                      <div className="adm-email-preview__chrome-row">
                        <span className="adm-email-preview__chrome-label">Subject</span>
                        <span className="adm-email-preview__chrome-value adm-email-preview__chrome-value--subject">
                          {previewSubject}
                        </span>
                      </div>
                    </div>
                    <iframe
                      title="HTML email preview"
                      className="adm-email-preview__iframe"
                      srcDoc={fullPreviewDoc}
                      sandbox="allow-same-origin"
                    />
                  </div>
                  <span className="adm-email-field__hint">Preview uses sample data for merge fields. Each customer gets their own values on send.</span>
                </div>
              )}
            </div>
          </div>
          )}

          <EmailTemplateTests adminEmail={adminEmail} onShowToast={onShowToast} />
        </div>

        {showPreview && (
          <div className="adm-email-preview-overlay" onClick={() => setShowPreview(false)}>
            <div className="adm-email-preview-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="adm-email-preview-sheet__head">
                <div>
                  <div className="adm-email-preview-sheet__eyebrow">Subject</div>
                  <div className="adm-email-preview-sheet__subject">{previewSubject}</div>
                </div>
                <button type="button" className="adm-modal-close" onClick={() => setShowPreview(false)} aria-label="Close preview">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-email-preview-sheet__note">
                Exactly what a customer receives — merge fields filled with sample data.
              </p>
              <iframe
                title="Email preview"
                className="adm-email-preview-sheet__frame"
                srcDoc={fullPreviewDoc}
                sandbox=""
              />
            </div>
          </div>
        )}

        <div className="adm-email-testbar">
          <button
            type="button"
            className="adm-btn-ghost adm-btn--sm"
            onClick={() => setShowPreview(true)}
            title="See the email exactly as a customer receives it"
          >
            <Eye size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
            Preview email
          </button>
          <span className="adm-email-testbar__spacer" />
          <span className="adm-email-testbar__label">Send yourself a test first?</span>
          <label className="adm-email-testbar__opt">
            <input type="radio" name="wantTest" checked={wantTest} onChange={() => setWantTest(true)} />
            Yes
          </label>
          <label className="adm-email-testbar__opt">
            <input type="radio" name="wantTest" checked={!wantTest} onChange={() => setWantTest(false)} />
            No
          </label>
          {wantTest && (
            <>
              <input
                type="email"
                className="adm-field-input adm-email-testbar__input"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="you@proto.co.za"
                aria-label="Send the test to this address"
              />
              <button
                type="button"
                className="adm-btn-ghost adm-btn--sm"
                disabled={sending || testSending}
                onClick={() => void handleSend(true)}
              >
                {testSending ? <><Loader2 size={13} className="spin" /> Sending…</> : <><Send size={13} /> Send test</>}
              </button>
            </>
          )}
        </div>

        <div className="adm-modal-footer adm-modal-footer--end adm-email-modal__footer">
          <button type="button" className="adm-btn-ghost" onClick={onClose} disabled={sending || testSending}>
            Cancel
          </button>
          <div className="adm-email-modal__footer-actions" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="adm-btn-red"
              disabled={sending || testSending || (audience === 'selected' && !selectedEmails.length)}
              onClick={() => void handleSend(false)}
            >
              {sending ? <><Loader2 size={14} className="spin" /> Sending…</> : <><Send size={14} /> Send now{audience === 'selected' && selectedEmails.length ? ` (${selectedEmails.length})` : ''}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
