import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart2, Download, Loader2, X } from 'lucide-react';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

/**
 * Email analytics as a SPREADSHEET, not a wall of text.
 *
 * The previous version printed every campaign as a card with hundreds of
 * comma-separated addresses inline, which was unreadable. Now: headline totals
 * across all campaigns, one sortable row per campaign with its rates, and the
 * recipient detail moved behind a per-campaign drawer (plus CSV export).
 */

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function rateClass(value, { good, warn }) {
  if (value >= good) return 'adm-rate adm-rate--good';
  if (value >= warn) return 'adm-rate adm-rate--warn';
  return 'adm-rate adm-rate--bad';
}

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCsv(filename, rows) {
  const blob = new Blob([rows.map((r) => r.map(csvEscape).join(',')).join('\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function recipientStatusRows(campaign) {
  const data = campaignRecipientData(campaign);
  return data.emails.map((email) => [
    email,
    data.status.get(email),
    data.failed.has(email) ? 'No' : 'Yes',
    data.delivered.has(email) ? 'Yes' : 'No',
    data.opened.has(email) ? 'Yes' : 'No',
    data.clicked.has(email) ? 'Yes' : 'No',
    data.bounced.has(email) ? 'Yes' : 'No',
    data.unsubscribed.has(email) ? 'Yes' : 'No',
    data.complained.has(email) ? 'Yes' : 'No',
  ]);
}

const SORTS = {
  date: (a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0),
  sent: (a, b) => b.sent - a.sent,
  opened: (a, b) => b.openRate - a.openRate,
  clicked: (a, b) => b.clickRate - a.clickRate,
};

export default function EmailAnalyticsPanel({ onShowToast, onCompose }) {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState('date');
  const [windowKey, setWindowKey] = useState('all');
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/email-campaigns');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load email campaigns');
      setCampaigns(json.campaigns || []);
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load email analytics', 'error');
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'customers' || event.detail === 'comms') void load();
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load]);

  const rows = useMemo(() => {
    const mapped = (campaigns || []).map((c) => {
      const e = c.events || {};
      // Brevo accepts each send synchronously, but its optional `delivered`
      // webhook is not emitted consistently for this transactional send path.
      // Using that event made a campaign with hundreds of opens/clicks appear
      // to have delivered only a handful of emails. A send accepted by Brevo
      // is treated as delivered unless a subsequent bounce says otherwise.
      const sent = Number.isFinite(c.sent) ? c.sent : (c.recipientCount || 0);
      const opened = e.opened || 0;
      const clicked = e.clicked || 0;
      const bounced = e.bounced || 0;
      const unsubscribed = e.unsubscribed || 0;
      const complained = e.complained || 0;
      const delivered = Math.max(0, sent - bounced);
      // Opens/clicks are counted per EVENT (one person opening 3 times is 3),
      // so rates are measured against unique recipients where we have them and
      // capped at 100% — a "300% open rate" is meaningless to read.
      const openedUnique = (c.eventEmails?.opened || []).length || opened;
      const clickedUnique = (c.eventEmails?.clicked || []).length || clicked;
      return {
        ...c,
        sent,
        delivered,
        opened,
        clicked,
        bounced,
        unsubscribed,
        complained,
        openedUnique,
        clickedUnique,
        hasRecipientSnapshot: Array.isArray(c.recipientEmails) && c.recipientEmails.length > 0,
        isDraft: sent === 0 && !c.sentAt,
        deliveryRate: Math.min(100, pct(delivered, sent)),
        openRate: Math.min(100, pct(openedUnique, sent)),
        clickRate: Math.min(100, pct(clickedUnique, sent)),
        bounceRate: Math.min(100, pct(bounced, sent)),
      };
    });
    const since = windowKey === 'all'
      ? null
      : Date.now() - Number(windowKey.replace('d', '')) * 24 * 60 * 60 * 1000;
    return mapped
      .filter((row) => !since || (row.sentAt && new Date(row.sentAt).getTime() >= since))
      .sort(SORTS[sort] || SORTS.date);
  }, [campaigns, sort, windowKey]);

  const totals = useMemo(() => rows.reduce((acc, r) => ({
    campaigns: acc.campaigns + 1,
    sent: acc.sent + r.sent,
    delivered: acc.delivered + r.delivered,
    openedUnique: acc.openedUnique + r.openedUnique,
    clickedUnique: acc.clickedUnique + r.clickedUnique,
    bounced: acc.bounced + r.bounced,
    unsubscribed: acc.unsubscribed + r.unsubscribed,
    complained: acc.complained + r.complained,
    drafts: acc.drafts + (r.isDraft ? 1 : 0),
    snapshots: acc.snapshots + (r.hasRecipientSnapshot ? 1 : 0),
  }), {
    campaigns: 0, sent: 0, delivered: 0, openedUnique: 0, clickedUnique: 0, bounced: 0,
    unsubscribed: 0, complained: 0, drafts: 0, snapshots: 0,
  }), [rows]);

  const sentRows = rows.filter((row) => !row.isDraft && row.sent > 0);
  const legacyRows = sentRows.filter((row) => !row.hasRecipientSnapshot).length;
  const lastSentAt = sentRows.reduce((latest, row) => (
    !latest || new Date(row.sentAt || 0) > new Date(latest) ? row.sentAt : latest
  ), null);

  const exportCsv = () => {
    downloadCsv('proto-email-campaigns.csv', [
      ['Sent at', 'Subject', 'Audience', 'Business types', 'Recipients', 'Send accepted', 'Delivery estimate', 'Delivery %', 'Opened (people)', 'Open %', 'Clicked (people)', 'Click %', 'Bounced', 'Bounce %', 'Opt-outs'],
      ...rows.map((r) => [
        r.sentAt ? new Date(r.sentAt).toISOString() : '',
        r.subject || '(no subject)',
        r.audience || '',
        (r.businessTypes || []).join(' / '),
        r.sent, r.delivered, 'Accepted less bounces', `${r.deliveryRate}%`,
        r.openedUnique, `${r.openRate}%`,
        r.clickedUnique, `${r.clickRate}%`,
        r.bounced, `${r.bounceRate}%`, r.unsubscribed,
      ]),
    ]);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div className="adm-email-stats">
        <Headline label="Sent campaigns" value={sentRows.length} sub={totals.drafts ? `${totals.drafts} draft${totals.drafts === 1 ? '' : 's'} excluded` : undefined} />
        <Headline label="Accepted by Brevo" value={totals.sent.toLocaleString('en-ZA')} />
        <Headline label="Delivered" value={`${pct(totals.delivered, totals.sent)}%`} sub={`${totals.delivered.toLocaleString('en-ZA')} of ${totals.sent.toLocaleString('en-ZA')}`} />
        <Headline label="Opened" value={`${pct(totals.openedUnique, totals.sent)}%`} sub={`${totals.openedUnique.toLocaleString('en-ZA')} people`} />
        <Headline label="Clicked" value={`${pct(totals.clickedUnique, totals.sent)}%`} sub={`${totals.clickedUnique.toLocaleString('en-ZA')} people`} />
        <Headline label="Opt-outs" value={totals.unsubscribed.toLocaleString('en-ZA')} sub={totals.complained ? `${totals.complained} spam complaint${totals.complained === 1 ? '' : 's'}` : undefined} tone={totals.unsubscribed > 0 || totals.complained > 0 ? 'bad' : undefined} />
      </div>

      <div className="crm-campaign-summary" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Tracking confidence</strong>
        <span>{legacyRows ? `${legacyRows} older campaign${legacyRows === 1 ? '' : 's'} without recipient snapshots` : 'Recipient snapshots available for every sent campaign'}</span>
        <span className="adm-muted">Last send: {fmtDate(lastSentAt)}</span>
      </div>

      <div className="adm-email-analytics-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="adm-muted" style={{ fontSize: 12, fontWeight: 700 }}>Period</span>
          {[['all', 'All time'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`adm-tab${windowKey === key ? ' adm-tab--active' : ''}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => setWindowKey(key)}
            >
              {label}
            </button>
          ))}
          <span className="adm-muted" style={{ fontSize: 12, fontWeight: 700 }}>Sort</span>
          {[['date', 'Newest'], ['sent', 'Most sent'], ['opened', 'Best open rate'], ['clicked', 'Best click rate']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`adm-tab${sort === key ? ' adm-tab--active' : ''}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => setSort(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading && <Loader2 size={15} className="spin" aria-label="Loading" />}
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={exportCsv} disabled={!rows.length}>
            <Download size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
            Export CSV
          </button>
        </div>
      </div>

      {rows.length === 0 && !loading ? (
        <div className="adm-empty" style={{ padding: '32px 0' }}>
          <BarChart2 size={28} style={{ color: '#9ca3af', marginBottom: 8 }} />
          <div>No email campaigns logged yet. Use <strong>Send email</strong> to start tracking.</div>
        </div>
      ) : (
        <div className="adm-table-scroll">
          <table className="adm-sheet">
            <thead>
              <tr>
                <th style={{ minWidth: 150 }}>Sent</th>
                <th style={{ minWidth: 220 }}>Subject</th>
                <th style={{ minWidth: 130 }}>Audience</th>
                <th className="adm-sheet__num">Send accepted</th>
                <th className="adm-sheet__num">Delivery estimate</th>
                <th className="adm-sheet__num">Opened</th>
                <th className="adm-sheet__num">Clicked</th>
                <th className="adm-sheet__num">Bounced</th>
                <th className="adm-sheet__num">Opt-outs</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="adm-muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.sentAt)}</td>
                  <td style={{ fontWeight: 700 }}>{r.subject || '(no subject)'}</td>
                  <td className="adm-muted">
                    {r.audience || '—'}
                    {r.businessTypes?.length ? <div style={{ fontSize: 11 }}>{r.businessTypes.join(', ')}</div> : null}
                  </td>
                  <td className="adm-sheet__num">{r.sent.toLocaleString('en-ZA')}</td>
                  <td className="adm-sheet__num">
                    {r.delivered.toLocaleString('en-ZA')}<span className={rateClass(r.deliveryRate, { good: 90, warn: 60 })}>{r.deliveryRate}%</span>
                  </td>
                  <td className="adm-sheet__num">
                    {r.openedUnique.toLocaleString('en-ZA')}<span className={rateClass(r.openRate, { good: 25, warn: 10 })}>{r.openRate}%</span>
                  </td>
                  <td className="adm-sheet__num">
                    {r.clickedUnique.toLocaleString('en-ZA')}<span className={rateClass(r.clickRate, { good: 10, warn: 3 })}>{r.clickRate}%</span>
                  </td>
                  <td className="adm-sheet__num">
                    {r.bounced.toLocaleString('en-ZA')}
                    {r.bounced > 0 && <span className="adm-rate adm-rate--bad">{r.bounceRate}%</span>}
                  </td>
                  <td className="adm-sheet__num">{r.unsubscribed.toLocaleString('en-ZA')}</td>
                  <td className="adm-muted" style={{ fontSize: 12 }}>{r.isDraft ? 'Draft' : r.hasRecipientSnapshot ? 'Tracked' : 'Legacy'}</td>
                  <td>
                    <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => setDetail(r)}>
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="adm-section-note" style={{ marginTop: 12 }}>
        “Send accepted” means the Brevo API accepted the message. “Delivery estimate” subtracts recorded bounces;
        it is not a provider-confirmed delivery total. Open and click rates count each PERSON once, measured against
        accepted sends. Engagement stats arrive from Brevo webhooks, so a campaign sent moments ago may still show zeros.
      </p>

      {detail && <CampaignDetail campaign={detail} onClose={() => setDetail(null)} onCompose={onCompose} />}
    </div>
  );
}

function Headline({ label, value, sub, tone }) {
  return (
    <div className={`adm-email-stat${tone === 'bad' ? ' adm-email-stat--bad' : ''}`}>
      <div className="adm-email-stat__label">{label}</div>
      <div className="adm-email-stat__value">{value}</div>
      {sub && <div className="adm-email-stat__sub">{sub}</div>}
    </div>
  );
}

/** Per-campaign recipient detail — one address per line, exportable. */
function uniqueEmails(values) {
  return [...new Set((values || [])
    .map((email) => String(email || '').trim().toLowerCase())
    .filter(Boolean))];
}

function campaignRecipientData(campaign) {
  const snapshot = uniqueEmails(campaign.recipientEmails);
  const opened = new Set(uniqueEmails(campaign.eventEmails?.opened));
  const clicked = new Set(uniqueEmails(campaign.eventEmails?.clicked));
  const bounced = new Set(uniqueEmails(campaign.eventEmails?.bounced));
  const unsubscribed = new Set(uniqueEmails(campaign.eventEmails?.unsubscribed));
  const complained = new Set(uniqueEmails(campaign.eventEmails?.complained));
  const failed = new Set(uniqueEmails(campaign.failedRecipientEmails));
  const known = uniqueEmails([...opened, ...clicked, ...bounced, ...unsubscribed, ...complained, ...failed]);
  const emails = snapshot.length ? snapshot : known;
  const accepted = new Set(emails.filter((email) => !failed.has(email)));
  const delivered = new Set([...accepted].filter((email) => !bounced.has(email)));
  const status = new Map(emails.map((email) => {
    let value = 'Delivered — estimated';
    if (complained.has(email)) value = 'Spam complaint';
    else if (unsubscribed.has(email)) value = 'Unsubscribed';
    else if (bounced.has(email)) value = 'Bounced';
    else if (failed.has(email)) value = 'Not sent — failed';
    else if (clicked.has(email)) value = 'Clicked';
    else if (opened.has(email)) value = 'Opened — no click';
    return [email, value];
  }));
  return { emails, opened, clicked, bounced, unsubscribed, complained, failed, accepted, delivered, status };
}

function CampaignDetail({ campaign, onClose, onCompose }) {
  const data = campaignRecipientData(campaign);
  const snapshotEmails = uniqueEmails(campaign.recipientEmails);
  const hasRecipientSnapshot = snapshotEmails.length > 0;
  const noRecordedOpen = data.emails.filter((email) => data.accepted.has(email) && !data.opened.has(email));
  const openedNoClick = data.emails.filter((email) => data.opened.has(email) && !data.clicked.has(email));
  const legacyKnownEmails = data.emails;
  const groups = [
    {
      key: 'all',
      label: 'All recipients',
      emails: hasRecipientSnapshot ? snapshotEmails : legacyKnownEmails,
      note: hasRecipientSnapshot ? '' : 'Legacy campaign: the original recipient snapshot was not saved. Showing tracked addresses only.',
    },
    { key: 'failed', label: 'Not sent / failed', emails: data.emails.filter((email) => data.failed.has(email)), note: 'The send endpoint could not get this message accepted by Brevo.' },
    { key: 'accepted', label: 'Accepted', emails: [...data.accepted], note: 'Brevo accepted these messages for processing.' },
    { key: 'delivered', label: 'Delivered (estimate)', emails: [...data.delivered], note: 'Estimated as accepted messages less recorded bounces; not provider-confirmed delivery.' },
    {
      key: 'no-open',
      label: 'No recorded open',
      emails: noRecordedOpen,
      unavailable: !hasRecipientSnapshot,
      note: hasRecipientSnapshot
        ? 'Use this as a once-only follow-up list. Image blocking and mail privacy can hide genuine reads.'
        : 'Available for campaigns sent after this follow-up feature was added.',
    },
    { key: 'opened-no-click', label: 'Opened, no click', emails: openedNoClick, note: 'Opened at least once, but no tracked link click.' },
    { key: 'clicked', label: 'Clicked', emails: [...data.clicked], note: 'Clicked at least one tracked link.' },
    { key: 'bounced', label: 'Bounced', emails: [...data.bounced], note: 'Brevo recorded a bounce for these addresses.' },
    { key: 'unsubscribed', label: 'Unsubscribed', emails: [...data.unsubscribed], note: 'These contacts opted out of marketing email.' },
    { key: 'complained', label: 'Spam complaints', emails: [...data.complained], note: 'These contacts reported the message as spam.' },
  ];
  const links = Object.entries(campaign.clickedLinks || {});
  const [tab, setTab] = useState('all');
  const active = groups.find((g) => g.key === tab);

  const fileStem = `campaign-${(campaign.subject || 'email').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const exportRecipients = (group) => {
    const allowed = group ? new Set(group.emails) : null;
    downloadCsv(`${fileStem}-${group ? group.key : 'all-statuses'}.csv`, [
      ['Email', 'Status', 'Send accepted', 'Delivery estimate', 'Opened', 'Clicked', 'Bounced', 'Unsubscribed', 'Spam complaint'],
      ...recipientStatusRows(campaign).filter((row) => !allowed || allowed.has(row[0])),
    ]);
  };

  return (
    <div className="adm-modal-backdrop" onClick={onClose}>
      <div className="adm-modal adm-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-header">
          <div>
            <h3 className="adm-modal-title">{campaign.subject || '(no subject)'}</h3>
            <p className="adm-modal-note" style={{ margin: '2px 0 0' }}>{fmtDate(campaign.sentAt)} · {campaign.sent} recipients</p>
          </div>
          <button type="button" className="adm-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="adm-modal-body">
          <div className="adm-customer-tabs" style={{ marginBottom: 12 }}>
            {groups.map((g) => (
              <button key={g.key} type="button" className={`adm-tab${tab === g.key ? ' adm-tab--active' : ''}`} onClick={() => setTab(g.key)}>
                {g.label} ({g.emails.length})
              </button>
            ))}
            {links.length > 0 && (
              <button type="button" className={`adm-tab${tab === 'links' ? ' adm-tab--active' : ''}`} onClick={() => setTab('links')}>
                Links ({links.length})
              </button>
            )}
          </div>

          {tab === 'links' ? (
            <div className="adm-table-scroll">
              <table className="adm-sheet">
                <thead><tr><th>Link</th><th className="adm-sheet__num">Clicks</th></tr></thead>
                <tbody>
                  {links.map(([url, info]) => (
                    <tr key={url}>
                      <td style={{ wordBreak: 'break-all' }}>{url}</td>
                      <td className="adm-sheet__num">{info.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : active ? (
            <>
              {active.note && <p className="adm-modal-note" style={{ marginTop: 0 }}>{active.note}</p>}
              {active.unavailable ? null : (
                <div className="adm-table-scroll" style={{ maxHeight: '50vh' }}>
                  <table className="adm-sheet">
                    <thead><tr><th style={{ width: 48 }}>#</th><th>Email address</th></tr></thead>
                    <tbody>
                      {active.emails.map((email, i) => (
                        <tr key={email}><td className="adm-muted">{i + 1}</td><td>{email}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="adm-empty" style={{ padding: 24 }}>No recipient detail recorded for this campaign.</div>
          )}
        </div>
        <div className="adm-modal-footer adm-modal-footer--end">
          {tab === 'no-open' && active && !active.unavailable && (
            <button
              type="button"
              className="adm-btn-red"
              disabled={!active.emails.length}
              onClick={() => onCompose?.({ audience: 'selected', recipients: active.emails })}
            >
              Create follow-up email ({active.emails.length})
            </button>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="adm-btn-ghost" onClick={() => exportRecipients()} disabled={!data.emails.length}>
              <Download size={13} style={{ marginRight: 5, verticalAlign: -2 }} /> Export all statuses
            </button>
            {active && tab !== 'links' && (
              <button type="button" className="adm-btn-ghost" onClick={() => exportRecipients(active)} disabled={!active.emails.length}>
                <Download size={13} style={{ marginRight: 5, verticalAlign: -2 }} /> Export {active.label}
              </button>
            )}
          </div>
          <button type="button" className="adm-btn-red" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
