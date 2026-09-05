import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, CheckCircle, Clock, FileText, Loader2, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import {
  addOrderWorkspaceLine,
  addOrderWorkspacePromise,
  addOrderWorkspaceReminder,
  addOrderWorkspaceTask,
  changeOrderWorkspaceStatus,
  completeOrderWorkspaceTask,
  createOrderWorkspace,
  fetchOrderWorkspace,
  listOrderWorkspaces,
  updateOrderWorkspace,
} from '../lib/orderWorkspaces';
import WorkspaceDocuments from './WorkspaceDocuments.jsx';

const STATUSES = ['Draft', 'Pending Review', 'Quoted', 'Waiting Supplier', 'Ordered', 'Waiting Arrival', 'Ready', 'Delivered', 'Closed'];

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDate(value) {
  if (!value) return 'No date';
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function workspaceTitle(row) {
  return row?.customer?.customer_name || row?.command?.replace(/^\/order\s*/i, '') || 'Draft order';
}

export default function OrdersWorkspacePanel({ initialWorkspaceId = '', onShowToast }) {
  const [rows, setRows] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState('');
  const [search, setSearch] = useState('');
  const [command, setCommand] = useState('/order Addie');
  const [line, setLine] = useState({ sku: '', description: '', requestedQty: 1 });
  const [task, setTask] = useState({ title: '', owner: '', dueDate: todayPlus(1) });
  const [promise, setPromise] = useState({ text: '', dueDate: todayPlus(1) });
  const [reminder, setReminder] = useState({ title: '', dueDate: todayPlus(1) });
  const [fields, setFields] = useState({ dueDate: '', notes: '', supplier: '' });

  const toast = useCallback((message, type = 'success') => {
    if (onShowToast) onShowToast(message, type);
  }, [onShowToast]);

  const selectWorkspace = useCallback((row, { replace = false } = {}) => {
    setWorkspace(row);
    setFields({ dueDate: row?.due_date || '', notes: row?.notes || '', supplier: row?.supplier || '' });
    if (row?.id) {
      const url = `/orders/workspace/${row.id}`;
      if (replace) window.history.replaceState({}, '', url);
      else window.history.pushState({}, '', url);
    }
  }, []);

  const loadList = useCallback(async () => {
    const data = await listOrderWorkspaces({ search, limit: 40 });
    setRows(data);
    return data;
  }, [search]);

  const loadWorkspace = useCallback(async (id, { replace = false } = {}) => {
    if (!id) return null;
    const row = await fetchOrderWorkspace(id);
    selectWorkspace(row, { replace });
    return row;
  }, [selectWorkspace]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      loadList(),
      initialWorkspaceId ? loadWorkspace(initialWorkspaceId, { replace: true }) : Promise.resolve(null),
    ]).catch((err) => {
      if (alive) toast(err.message || 'Could not load order workspaces', 'error');
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [initialWorkspaceId, loadList, loadWorkspace, toast]);

  const refreshCurrent = async () => {
    if (workspace?.id) await loadWorkspace(workspace.id, { replace: true });
    await loadList();
  };

  const createFromCommand = async () => {
    setSaving('create');
    try {
      const row = await createOrderWorkspace({ command });
      await loadList();
      selectWorkspace(row);
      toast('Draft Order Workspace created');
    } catch (err) {
      toast(err.message || 'Could not create order workspace', 'error');
    } finally {
      setSaving('');
    }
  };

  const saveFields = async () => {
    if (!workspace?.id) return;
    setSaving('fields');
    try {
      const row = await updateOrderWorkspace(workspace.id, fields);
      selectWorkspace(row, { replace: true });
      await loadList();
      toast('Workspace updated');
    } catch (err) {
      toast(err.message || 'Could not update workspace', 'error');
    } finally {
      setSaving('');
    }
  };

  const addLine = async () => {
    if (!workspace?.id) return;
    setSaving('line');
    try {
      const row = await addOrderWorkspaceLine(workspace.id, line);
      selectWorkspace(row, { replace: true });
      setLine({ sku: '', description: '', requestedQty: 1 });
      toast('Product line added');
    } catch (err) {
      toast(err.message || 'Could not add line', 'error');
    } finally {
      setSaving('');
    }
  };

  const addTask = async () => {
    if (!workspace?.id) return;
    setSaving('task');
    try {
      const row = await addOrderWorkspaceTask(workspace.id, task);
      selectWorkspace(row, { replace: true });
      setTask({ title: '', owner: '', dueDate: todayPlus(1) });
      toast('Task created');
    } catch (err) {
      toast(err.message || 'Could not create task', 'error');
    } finally {
      setSaving('');
    }
  };

  const completeTask = async (taskId) => {
    if (!workspace?.id) return;
    setSaving(taskId);
    try {
      const row = await completeOrderWorkspaceTask(workspace.id, taskId);
      selectWorkspace(row, { replace: true });
      toast('Task completed');
    } catch (err) {
      toast(err.message || 'Could not complete task', 'error');
    } finally {
      setSaving('');
    }
  };

  const addPromise = async () => {
    if (!workspace?.id) return;
    setSaving('promise');
    try {
      const row = await addOrderWorkspacePromise(workspace.id, promise);
      selectWorkspace(row, { replace: true });
      setPromise({ text: '', dueDate: todayPlus(1) });
      toast('Commitment recorded');
    } catch (err) {
      toast(err.message || 'Could not record promise', 'error');
    } finally {
      setSaving('');
    }
  };

  const addReminder = async () => {
    if (!workspace?.id) return;
    setSaving('reminder');
    try {
      const row = await addOrderWorkspaceReminder(workspace.id, reminder);
      selectWorkspace(row, { replace: true });
      setReminder({ title: '', dueDate: todayPlus(1) });
      toast('Reminder created');
    } catch (err) {
      toast(err.message || 'Could not create reminder', 'error');
    } finally {
      setSaving('');
    }
  };

  const changeStatus = async (status) => {
    if (!workspace?.id || status === workspace.status) return;
    setSaving('status');
    try {
      const row = await changeOrderWorkspaceStatus(workspace.id, status);
      selectWorkspace(row, { replace: true });
      await loadList();
      toast(`Status changed to ${status}`);
    } catch (err) {
      toast(err.message || 'Invalid status change', 'error');
    } finally {
      setSaving('');
    }
  };

  const outstanding = useMemo(() => ({
    tasks: (workspace?.tasks || []).filter((t) => t.status === 'Open'),
    promises: (workspace?.promises || []).filter((p) => p.status === 'Open'),
    reminders: (workspace?.reminders || []).filter((r) => r.status === 'Open'),
  }), [workspace]);

  return (
    <div className="ow-panel">
      <div className="ow-head">
        <div>
          <h2 className="adm-section-title">Orders Workspace</h2>
          <p className="adm-section-note">Customer-order notebook replacement. Manual durable workflow first; Excel comes next.</p>
        </div>
        <button type="button" className="adm-btn-ghost" onClick={() => void refreshCurrent()} disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>

      <div className="ow-grid">
        <aside className="ow-left">
          <div className="ow-card">
            <div className="ow-label">Command</div>
            <div className="ow-command">
              <input className="adm-field-input" value={command} onChange={(e) => setCommand(e.target.value)} />
              <button type="button" className="adm-btn-green" onClick={() => void createFromCommand()} disabled={saving === 'create'}>
                {saving === 'create' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Create
              </button>
            </div>
          </div>
          <div className="ow-card">
            <label className="adm-search">
              <Search size={14} />
              <input className="adm-search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search open orders" />
            </label>
            <div className="ow-list">
              {rows.map((row) => (
                <button key={row.id} type="button" className={`ow-list-row${workspace?.id === row.id ? ' ow-list-row--active' : ''}`} onClick={() => { selectWorkspace(row); loadWorkspace(row.id, { replace: true }).catch((err) => toast(err.message || 'Could not open workspace', 'error')); }}>
                  <strong>{workspaceTitle(row)}</strong>
                  <span>{row.status} · {fmtDate(row.due_date)}</span>
                </button>
              ))}
              {!rows.length && <div className="adm-muted" style={{ fontSize: 13, padding: 10 }}>No open workspaces yet.</div>}
            </div>
          </div>
        </aside>

        <main className="ow-centre">
          {!workspace ? (
            <div className="ow-empty">Create or select an Order Workspace to begin.</div>
          ) : (
            <>
              <section className="ow-card">
                <div className="ow-summary">
                  <div>
                    <div className="ow-label">Order</div>
                    <h3>{workspaceTitle(workspace)}</h3>
                    <p>{workspace.id}</p>
                  </div>
                  <select className="adm-field-input" value={workspace.status} onChange={(e) => void changeStatus(e.target.value)} disabled={saving === 'status'}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="ow-form-grid">
                  <label><span>Due date</span><input className="adm-field-input" type="date" value={fields.dueDate} onChange={(e) => setFields((f) => ({ ...f, dueDate: e.target.value }))} /></label>
                  <label><span>Supplier</span><input className="adm-field-input" value={fields.supplier} onChange={(e) => setFields((f) => ({ ...f, supplier: e.target.value }))} /></label>
                </div>
                <label className="ow-notes"><span>Notes</span><textarea className="adm-field-input" rows={3} value={fields.notes} onChange={(e) => setFields((f) => ({ ...f, notes: e.target.value }))} /></label>
                <button type="button" className="adm-btn-green" onClick={() => void saveFields()} disabled={saving === 'fields'}>Save order fields</button>
              </section>

              <section className="ow-card">
                <h3>Products</h3>
                <div className="ow-line-form">
                  <input className="adm-field-input" placeholder="SKU" value={line.sku} onChange={(e) => setLine((v) => ({ ...v, sku: e.target.value }))} />
                  <input className="adm-field-input" placeholder="Description" value={line.description} onChange={(e) => setLine((v) => ({ ...v, description: e.target.value }))} />
                  <input className="adm-field-input" type="number" min="0" value={line.requestedQty} onChange={(e) => setLine((v) => ({ ...v, requestedQty: e.target.value }))} />
                  <button type="button" className="adm-btn-green" onClick={() => void addLine()} disabled={saving === 'line'}>Add line</button>
                </div>
                <div className="ow-table">
                  {(workspace.lines || []).map((item) => (
                    <div key={item.id} className="ow-table-row">
                      <strong>{item.sku || 'No SKU'}</strong>
                      <span>{item.description}</span>
                      <span>Qty {item.requested_qty}</span>
                      <span>{item.status}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ow-card">
                <h3>Tasks</h3>
                <div className="ow-line-form ow-line-form--task">
                  <input className="adm-field-input" placeholder="Task title" value={task.title} onChange={(e) => setTask((v) => ({ ...v, title: e.target.value }))} />
                  <input className="adm-field-input" placeholder="Owner" value={task.owner} onChange={(e) => setTask((v) => ({ ...v, owner: e.target.value }))} />
                  <input className="adm-field-input" type="date" value={task.dueDate} onChange={(e) => setTask((v) => ({ ...v, dueDate: e.target.value }))} />
                  <button type="button" className="adm-btn-green" onClick={() => void addTask()} disabled={saving === 'task'}>Create task</button>
                </div>
                {(workspace.tasks || []).map((item) => (
                  <div key={item.id} className="ow-action-row">
                    <div><strong>{item.title}</strong><span>{item.owner || 'Unassigned'} · {fmtDate(item.due_date)}</span></div>
                    {item.status === 'Open' ? <button type="button" className="adm-btn-ghost" onClick={() => void completeTask(item.id)} disabled={saving === item.id}>Complete</button> : <span className="adm-pill adm-pill--ok">Completed</span>}
                  </div>
                ))}
              </section>

              <section className="ow-card">
                <WorkspaceDocuments
                  workspaceType="orders"
                  recordId={workspace.id}
                  scopeLabel={workspaceTitle(workspace)}
                  onShowToast={onShowToast}
                  compact
                />
              </section>

              <section className="ow-card">
                <h3>Commitments</h3>
                <div className="ow-line-form ow-line-form--promise">
                  <input className="adm-field-input" placeholder="We'll quote tomorrow..." value={promise.text} onChange={(e) => setPromise((v) => ({ ...v, text: e.target.value }))} />
                  <input className="adm-field-input" type="date" value={promise.dueDate} onChange={(e) => setPromise((v) => ({ ...v, dueDate: e.target.value }))} />
                  <button type="button" className="adm-btn-green" onClick={() => void addPromise()} disabled={saving === 'promise'}>Record commitment</button>
                </div>
                {(workspace.promises || []).map((item) => (
                  <div key={item.id} className="ow-action-row"><div><strong>{item.promise_text}</strong><span>Due {fmtDate(item.due_date)} · {item.status}</span></div></div>
                ))}
              </section>

              <section className="ow-card">
                <h3>Timeline</h3>
                <div className="ow-timeline">
                  {(workspace.timeline || []).map((event) => (
                    <div key={event.id} className="ow-timeline-row">
                      <Clock size={14} />
                      <div><strong>{event.summary}</strong><span>{fmtTime(event.created_at)} · {event.actor}</span></div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </main>

        <aside className="ow-right">
          <section className="ow-card">
            <h3>Customer Context</h3>
            <p><strong>{workspace?.customer?.customer_name || 'No workspace selected'}</strong></p>
            <p className="adm-muted">{workspace?.customer?.contact || ''}</p>
            <p className="adm-muted">{workspace?.customer?.email || ''}</p>
            <p className="adm-muted">{workspace?.customer?.phone || ''}</p>
          </section>
          <section className="ow-card">
            <h3>Outstanding Actions</h3>
            <div className="ow-metric"><CheckCircle size={15} /> {outstanding.tasks.length} open tasks</div>
            <div className="ow-metric"><ShieldCheck size={15} /> {outstanding.promises.length} open commitments</div>
            <div className="ow-metric"><Bell size={15} /> {outstanding.reminders.length} open reminders</div>
          </section>
          <section className="ow-card">
            <h3>Reminders</h3>
            {workspace && (
              <div className="ow-reminder-form">
                <input className="adm-field-input" placeholder="Customer waiting" value={reminder.title} onChange={(e) => setReminder((v) => ({ ...v, title: e.target.value }))} />
                <input className="adm-field-input" type="date" value={reminder.dueDate} onChange={(e) => setReminder((v) => ({ ...v, dueDate: e.target.value }))} />
                <button type="button" className="adm-btn-green" onClick={() => void addReminder()} disabled={saving === 'reminder'}>Add reminder</button>
              </div>
            )}
            {(workspace?.reminders || []).map((item) => (
              <div key={item.id} className="ow-mini-row"><FileText size={14} /><span>{item.title} · {fmtDate(item.due_date)}</span></div>
            ))}
          </section>
          <section className="ow-card">
            <h3>Recommendations</h3>
            <p className="adm-muted">Keep every customer promise as a promise, not a note. Tasks are for internal work; reminders keep promises visible here.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
