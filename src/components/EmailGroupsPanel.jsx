/**
 * Email Groups — labelled mailing lists uploaded by CSV.
 *
 * Members are database-only: they live in email_groups / email_group_members
 * and are never written to customers, so they cannot show up in Customer
 * Management or in any audience other than their own group. The panel says so
 * plainly, because that is the whole reason the feature exists.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, Loader2, Mail, Plus, RefreshCw, Trash2, Upload, Users, X,
} from 'lucide-react';
import { parseGroupRows, sampleGroupCsv } from '../../lib/email-groups.mjs';
import { readFileTable } from '../lib/customerCsvImport';

function whenLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function downloadSample() {
  const blob = new Blob([sampleGroupCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'proto-group-sample.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function EmailGroupsPanel({ onShowToast, onEmailGroup }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState('');
  const [addToGroupId, setAddToGroupId] = useState('');
  const fileRef = useRef(null);

  const [openGroup, setOpenGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [membersTotal, setMembersTotal] = useState(0);

  const toast = useCallback((msg, kind) => onShowToast?.(msg, kind), [onShowToast]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/email-groups');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load groups');
      setGroups(json.groups || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const pickFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    try {
      // readFileTable, not parseCustomerFile — the latter returns shaped
      // customer records, and handing those to parseGroupRows produced zero
      // members with no explanation.
      const table = await readFileTable(file);
      const result = parseGroupRows(table);
      if (result.error) { setParsed(null); toast(result.error, 'error'); return; }
      if (!result.members.length) { setParsed(null); toast('No valid email addresses found in that file', 'error'); return; }
      setParsed(result);
      // A sensible default label so the admin can upload in two clicks.
      if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
    } catch (e) {
      setParsed(null);
      toast(e.message || 'Could not read that file', 'error');
    }
  };

  const reset = () => {
    setParsed(null);
    setFileName('');
    setName('');
    setDescription('');
    setAddToGroupId('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const upload = async () => {
    if (!parsed?.members?.length) return;
    const addingTo = addToGroupId ? groups.find((g) => g.id === addToGroupId) : null;
    if (!addingTo && !name.trim()) { toast('Give the group a name', 'error'); return; }

    setBusy('upload');
    try {
      const res = await fetch('/api/email-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addingTo
          ? { groupId: addingTo.id, members: parsed.members }
          : { name: name.trim(), description: description.trim(), members: parsed.members }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      const skippedNote = parsed.skipped.length ? `, ${parsed.skipped.length} skipped` : '';
      const dupeNote = json.submitted > json.added ? `, ${json.submitted - json.added} already on the list` : '';
      toast(`${json.added} added to ${addingTo ? addingTo.name : name.trim()}${dupeNote}${skippedNote}`, 'success');
      reset();
      await load();
    } catch (e) {
      toast(e.message || 'Upload failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const remove = async (group) => {
    if (!window.confirm(`Delete the group "${group.name}" and its ${group.memberCount} contacts?\n\nThis cannot be undone. It does not affect any customer accounts.`)) return;
    setBusy(`del-${group.id}`);
    try {
      const res = await fetch(`/api/email-groups?groupId=${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Delete failed');
      toast(`Deleted "${group.name}"`, 'success');
      if (openGroup?.id === group.id) setOpenGroup(null);
      await load();
    } catch (e) {
      toast(e.message || 'Delete failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const viewMembers = async (group) => {
    setOpenGroup(group);
    setMembers([]);
    setBusy(`members-${group.id}`);
    try {
      const res = await fetch(`/api/email-groups?groupId=${encodeURIComponent(group.id)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load members');
      setMembers(json.members || []);
      setMembersTotal(json.total || 0);
    } catch (e) {
      toast(e.message || 'Could not load members', 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="eg-panel">
      <div className="oa-panel-head">
        <div>
          <h3>Groups</h3>
          <p className="oa-note eg-subtitle">
            Mailing lists you upload by CSV — the 10000 club and any others. These contacts
            live in the database only: they never appear in Customer Management, never get a
            portal login, and can only be emailed by picking their group here.
          </p>
        </div>
        <div className="oa-panel-actions">
          <button type="button" className="adm-btn-ghost adm-btn-sm" onClick={downloadSample}>
            <Download size={14} /> Sample CSV
          </button>
          <button type="button" className="adm-btn-ghost adm-btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="oa-error">{error}</div>}

      {/* ── Upload ─────────────────────────────────────────────── */}
      <section className="oa-panel eg-upload">
        <div className="oa-subhead">Upload a list</div>

        {!parsed ? (
          <label className="eg-drop">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
            <Upload size={20} />
            <span className="eg-drop__title">Choose a CSV or Excel file</span>
            <span className="eg-drop__hint">
              One row per contact. An <strong>email</strong> column is all that is required —
              add <strong>name</strong> and <strong>business_name</strong> to personalise the mail.
            </span>
            <span className="eg-drop__hint eg-drop__hint--warn">
              Apple Numbers files are not CSVs. In Numbers use <strong>File → Export To → CSV…</strong> first.
            </span>
          </label>
        ) : (
          <div className="eg-parsed">
            <div className="eg-parsed__summary">
              <strong>{parsed.members.length}</strong> contacts ready from <em>{fileName}</em>
              {parsed.duplicates > 0 && <span className="eg-muted"> · {parsed.duplicates} duplicate rows merged</span>}
              {parsed.skipped.length > 0 && <span className="eg-warn"> · {parsed.skipped.length} skipped</span>}
              <button type="button" className="eg-clear" onClick={reset} aria-label="Clear"><X size={14} /></button>
            </div>

            {parsed.skipped.length > 0 && (
              <details className="eg-skipped">
                <summary>{parsed.skipped.length} rows skipped</summary>
                <ul>
                  {parsed.skipped.slice(0, 20).map((s) => (
                    <li key={`${s.row}-${s.value}`}>Row {s.row}: “{s.value || '(blank)'}” — {s.reason}</li>
                  ))}
                  {parsed.skipped.length > 20 && <li>…and {parsed.skipped.length - 20} more</li>}
                </ul>
              </details>
            )}

            <div className="eg-fields">
              <label className="eg-field">
                <span>Add to</span>
                <select value={addToGroupId} onChange={(e) => setAddToGroupId(e.target.value)}>
                  <option value="">➕ A new group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>
                  ))}
                </select>
              </label>

              {!addToGroupId && (
                <>
                  <label className="eg-field">
                    <span>Group name</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. 10000 club"
                      maxLength={120}
                    />
                  </label>
                  <label className="eg-field eg-field--wide">
                    <span>Description <em>(optional)</em></span>
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What is this list for?"
                      maxLength={500}
                    />
                  </label>
                </>
              )}
            </div>

            <div className="eg-actions">
              <button type="button" className="adm-btn-ghost" onClick={reset}>Cancel</button>
              <button type="button" className="adm-btn-red" onClick={() => void upload()} disabled={busy === 'upload'}>
                {busy === 'upload'
                  ? <><Loader2 size={15} className="spin" /> Uploading…</>
                  : <><Plus size={15} /> {addToGroupId ? 'Add to group' : 'Create group'}</>}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Existing groups ────────────────────────────────────── */}
      <section className="oa-panel">
        <div className="oa-subhead">Your groups</div>

        {loading && !groups.length && (
          <div className="oa-loading"><Loader2 size={22} className="star-spinning" /></div>
        )}

        {!loading && !groups.length && (
          <p className="oa-empty">No groups yet. Upload a CSV above to make your first one.</p>
        )}

        {groups.length > 0 && (
          <div className="eg-grid">
            {groups.map((group) => (
              <div key={group.id} className="eg-card">
                <div className="eg-card__head">
                  <span className="eg-card__name">{group.name}</span>
                  <span className="eg-card__count"><Users size={13} /> {group.memberCount}</span>
                </div>
                {group.description && <p className="eg-card__desc">{group.description}</p>}
                <p className="eg-card__meta">Created {whenLabel(group.created_at)}</p>
                <div className="eg-card__actions">
                  <button
                    type="button"
                    className="adm-btn-ghost adm-btn-sm"
                    onClick={() => onEmailGroup?.(group)}
                    disabled={!group.memberCount}
                    title={group.memberCount ? `Email the ${group.memberCount} contacts in ${group.name}` : 'This group is empty'}
                  >
                    <Mail size={14} /> Email
                  </button>
                  <button
                    type="button"
                    className="adm-btn-ghost adm-btn-sm"
                    onClick={() => void viewMembers(group)}
                    disabled={!group.memberCount}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="adm-icon-btn"
                    style={{ color: '#c40000' }}
                    onClick={() => void remove(group)}
                    disabled={busy === `del-${group.id}`}
                    title={`Delete ${group.name}`}
                  >
                    {busy === `del-${group.id}` ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {openGroup && (
        <div className="adm-modal-backdrop" onClick={() => setOpenGroup(null)}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">{openGroup.name}</h3>
              <button type="button" className="adm-modal-close" onClick={() => setOpenGroup(null)} aria-label="Close"><X size={18} /></button>
            </div>
            <p className="adm-modal-note">
              {membersTotal} contacts{members.length < membersTotal ? ` · showing the first ${members.length}` : ''}
            </p>
            <div className="oa-table-wrap eg-members">
              <table className="oa-table">
                <thead><tr><th>Email</th><th>Name</th><th>Business</th></tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>{m.email}</td>
                      <td>{m.name || '—'}</td>
                      <td>{m.business_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
