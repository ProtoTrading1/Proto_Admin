import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { BarChart2, ChevronLeft, Layers, ChevronRight, Loader2, Mail, RefreshCw, Search, Send, UserMinus, UserX, Users } from 'lucide-react';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';
import { lazyRetry } from '../lib/lazyRetry';
import { BUSINESS_TYPES } from '../lib/businessTypes';
import AdminSelect from './AdminSelect';

const EmailAnalyticsPanel = lazyRetry(() => import('./EmailAnalyticsPanel'));
const EmailGroupsPanel = lazyRetry(() => import('./EmailGroupsPanel'));
const EmailUnsubscribesPanel = lazyRetry(() => import('./EmailUnsubscribesPanel'));

const PAGE_SIZE = 50;

// Same strictness the composer uses (parseEmailList) so a contact that can't be
// sent to can't be ticked — keeps the "Email selected (N)" count truthful.
const SENDABLE_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function isSendableEmail(email) {
  return SENDABLE_EMAIL_RE.test(email);
}

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function contactEmail(c) {
  return String(c?.email || '').trim().toLowerCase();
}

function contactBusiness(c) {
  return c?.business_name || c?.name || '—';
}

function contactPerson(c) {
  return c?.contact_name || c?.first_name || '—';
}

function contactLocation(c) {
  return [c?.city, c?.province].filter(Boolean).join(', ') || '—';
}

/**
 * Email CRM (comms) — one place for customer email work, sourced from the
 * SITE's own approved customers (portal `customers` table via api/admin-customers),
 * not Brevo. Filter by business type, select contacts, and send targeted
 * campaigns through the existing composer. Analytics tab embeds the existing
 * EmailAnalyticsPanel.
 */
export default function CommsPanel({ onCompose, onShowToast }) {
  const [tab, setTab] = useState('contacts');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [unsubscribingEmail, setUnsubscribingEmail] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadContacts = useCallback(async (pageArg, searchArg, typeArg) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ tab: 'regular', page: String(pageArg), pageSize: String(PAGE_SIZE) });
      if (searchArg) params.set('search', searchArg);
      if (typeArg) params.set('business_type', typeArg);
      const res = await fetch(`/api/admin-customers?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load contacts');
      setRows(json.rows || []);
      setTotal(Number(json.total || 0));
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load contacts', 'error');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => { setPage(1); }, [searchDebounced, businessType]);
  useEffect(() => { void loadContacts(page, searchDebounced, businessType); }, [page, searchDebounced, businessType, loadContacts]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'comms') void loadContacts(page, searchDebounced, businessType);
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [loadContacts, page, searchDebounced, businessType]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const emailableRows = useMemo(() => rows.filter((r) => isSendableEmail(contactEmail(r))), [rows]);
  const pageEmails = useMemo(() => emailableRows.map(contactEmail), [emailableRows]);
  const allPageSelected = pageEmails.length > 0 && pageEmails.every((e) => selected.has(e));

  const toggleOne = (email) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  };
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageEmails.forEach((e) => next.delete(e));
      else pageEmails.forEach((e) => next.add(e));
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const unsubscribeContact = async (email) => {
    if (!email || !window.confirm(`Unsubscribe ${email} from Proto marketing emails?`)) return;
    setUnsubscribingEmail(email);
    try {
      const res = await fetch('/api/email-unsubscribes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not unsubscribe this contact');
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(email);
        return next;
      });
      onShowToast?.('Contact unsubscribed from Proto marketing emails');
    } catch (err) {
      onShowToast?.(err.message || 'Unsubscribe failed', 'error');
    } finally {
      setUnsubscribingEmail('');
    }
  };

  const emailSelected = () => {
    const recipients = [...selected];
    if (!recipients.length) return;
    onCompose?.({ audience: 'selected', recipients });
  };

  // "Unspecified" was removed as a filter option: an empty businessTypes list
  // means EVERYONE to the audience resolver, so emailing the audience while
  // filtered to Unspecified silently sent to all approved customers.
  const emailAudience = () => {
    onCompose?.({
      audience: 'all-approved',
      businessTypes: businessType ? [businessType] : [],
    });
  };

  const audienceLabel = businessType ? `all approved · ${businessType}` : 'all approved';

  return (
    <div className="adm-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title">Email CRM</h2>
          <p className="adm-section-note">
            Your approved site customers. Filter by business type, tick the ones you want, and send — or email a whole
            audience. Contacts come straight from the portal, not Brevo.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="adm-btn-ghost" onClick={() => setTab('groups')}>
            <Layers size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
            Groups
          </button>
          <button type="button" className="adm-btn-red" onClick={() => onCompose?.()}>
            <Mail size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
            Send email
          </button>
        </div>
      </div>

      <div className="adm-customer-tabs" style={{ marginBottom: 12 }}>
        <button type="button" onClick={() => setTab('contacts')} className={`adm-tab${tab === 'contacts' ? ' adm-tab--active' : ''}`}>
          <Users size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Contacts{total ? ` (${total})` : ''}
        </button>
        <button type="button" onClick={() => setTab('groups')} className={`adm-tab${tab === 'groups' ? ' adm-tab--active' : ''}`}>
          <Layers size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Groups
        </button>
        <button type="button" onClick={() => setTab('analytics')} className={`adm-tab${tab === 'analytics' ? ' adm-tab--active' : ''}`}>
          <BarChart2 size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Email Analytics
        </button>
        <button type="button" onClick={() => setTab('unsubscribed')} className={'adm-tab' + (tab === 'unsubscribed' ? ' adm-tab--active' : '')}>
          <UserX size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Unsubscribed
        </button>
        {tab === 'contacts' && (
          <>
            <AdminSelect
              ariaLabel="Filter by business type"
              value={businessType}
              onChange={setBusinessType}
              options={[
                { value: '', label: 'All business types' },
                ...BUSINESS_TYPES.map((type) => ({ value: type, label: type })),
              ]}
            />
            <label className="adm-search adm-search--inline">
              <Search size={14} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, business…" className="adm-search-input" />
            </label>
            <button
              type="button"
              className="adm-btn-ghost"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => void loadContacts(page, searchDebounced, businessType)}
              disabled={loading}
              title="Reload contacts"
            >
              {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>
          </>
        )}
      </div>

      {tab === 'groups' ? (
        <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: '#6b7280', fontSize: 13 }}><Loader2 size={16} className="spin" /> Loading Groups…</div>}>
          <EmailGroupsPanel
            onShowToast={onShowToast}
            onEmailGroup={(group) => onCompose?.({ audience: 'group', groupId: group.id })}
          />
        </Suspense>
      ) : tab === 'analytics' ? (
        <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: '#6b7280', fontSize: 13 }}><Loader2 size={16} className="spin" /> Loading Email Analytics…</div>}>
          <EmailAnalyticsPanel onShowToast={onShowToast} onCompose={onCompose} />
        </Suspense>
      ) : tab === 'unsubscribed' ? (
        <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: '#6b7280', fontSize: 13 }}><Loader2 size={16} className="spin" /> Loading unsubscribed contacts...</div>}>
          <EmailUnsubscribesPanel onShowToast={onShowToast} />
        </Suspense>
      ) : (
        <>
          <div
            style={{
              display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 10, padding: '10px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
            }}
          >
            <div style={{ fontSize: 13, color: '#334155' }}>
              {selected.size > 0
                ? <><strong>{selected.size}</strong> contact{selected.size === 1 ? '' : 's'} selected <button type="button" onClick={clearSelection} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', padding: 0 }}>clear</button></>
                : <>Tick contacts to email specific people, or email the whole filtered audience.</>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="adm-btn-red"
                style={{ fontSize: 13, padding: '7px 14px', opacity: selected.size ? 1 : 0.5 }}
                onClick={emailSelected}
                disabled={!selected.size}
              >
                <Send size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                Email selected ({selected.size})
              </button>
              <button
                type="button"
                className="adm-btn-ghost"
                style={{ fontSize: 13, padding: '7px 14px' }}
                onClick={emailAudience}
                title="Opens the send-email window targeting every approved customer in the current business-type filter (not just this page)."
              >
                <Users size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                Email {audienceLabel}
              </button>
            </div>
          </div>

          <div className="adm-list">
            <div className="adm-list-head" style={{ gridTemplateColumns: '36px 1.3fr 1fr 1.3fr 1fr 0.9fr 110px 128px' }}>
              <span>
                <input type="checkbox" checked={allPageSelected} onChange={togglePage} aria-label="Select all on this page" style={{ accentColor: '#dc2626' }} disabled={!pageEmails.length} />
              </span>
              <span>Business</span><span>Contact</span><span>Email</span><span>Business type</span><span>Location</span><span>Last emailed</span><span>Actions</span>
            </div>
            {rows.map((c) => {
              const email = contactEmail(c);
              const hasEmail = isSendableEmail(email);
              return (
                <div key={c.id || email} className="adm-list-row" style={{ gridTemplateColumns: '36px 1.3fr 1fr 1.3fr 1fr 0.9fr 110px 128px' }}>
                  <span data-label="Select">
                    <input
                      type="checkbox"
                      checked={selected.has(email)}
                      onChange={() => toggleOne(email)}
                      disabled={!hasEmail}
                      aria-label={`Select ${contactBusiness(c)}`}
                      style={{ accentColor: '#dc2626' }}
                    />
                  </span>
                  <div data-label="Business" style={{ fontSize: 13, fontWeight: 600 }}>{contactBusiness(c)}</div>
                  <div data-label="Contact" style={{ fontSize: 13 }}>{contactPerson(c)}</div>
                  <div data-label="Email" style={{ fontSize: 12, wordBreak: 'break-all', color: hasEmail ? undefined : '#94a3b8' }}>{email || '— no email —'}</div>
                  <div data-label="Type" className="adm-muted" style={{ fontSize: 12 }}>{c.business_type || '—'}</div>
                  <div data-label="Location" className="adm-muted" style={{ fontSize: 12 }}>{contactLocation(c)}</div>
                  <div data-label="Last emailed" className="adm-muted" style={{ fontSize: 12 }} title={c.last_email_type ? `Last: ${c.last_email_type}` : ''}>{formatWhen(c.last_email_at)}</div>
                  <div data-label="Actions">
                    <button
                      type="button"
                      className="adm-btn-ghost"
                      style={{ padding: '5px 8px', fontSize: 12 }}
                      disabled={!hasEmail || unsubscribingEmail === email}
                      onClick={() => void unsubscribeContact(email)}
                      title="Stop marketing emails for this contact"
                    >
                      {unsubscribingEmail === email ? <Loader2 size={13} className="spin" /> : <UserMinus size={13} />}
                      <span style={{ marginLeft: 5 }}>Unsubscribe</span>
                    </button>
                  </div>
                </div>
              );
            })}
            {!loading && rows.length === 0 && (
              <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
                {searchDebounced || businessType ? 'No customers match this filter.' : 'No approved customers yet.'}
              </div>
            )}
            {loading && rows.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
                <Loader2 size={16} className="spin" /> Loading contacts…
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                <ChevronLeft size={14} />
              </button>
              <span className="adm-muted" style={{ fontSize: 12 }}>Page {page} of {totalPages}</span>
              <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
