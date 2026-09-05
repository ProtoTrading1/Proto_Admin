import { requireAdminKey } from './_admin-auth.js';
import { getPortalAdminClient } from './_site-config.js';
import {
  assertValidTransition,
  customerSnapshot,
  normalizeLine,
  parseOrderCommand,
  resolveCustomerMatch,
  workspaceDeadlines,
} from './_order-workspace-core.js';

const WORKSPACE_SELECT = 'id,status,priority,command,customer_id,due_date,supplier,notes,created_by,created_at,updated_at,archived_at';

function actorFromReq(req) {
  return String(req.headers['x-admin-email'] || req.body?.actor || 'admin').trim() || 'admin';
}

function safeSearchTerm(value) {
  return String(value || '').replace(/[%',()\\]/g, ' ').trim();
}

function migrationError(err) {
  return /order_workspace|order_workspaces|does not exist|Could not find the table/i.test(String(err?.message || ''));
}

async function writeTimeline(supabase, workspaceId, { actor, eventType, summary, refTable = null, refId = null }) {
  const { error } = await supabase.from('order_workspace_timeline').insert({
    workspace_id: workspaceId,
    actor,
    event_type: eventType,
    summary,
    ref_table: refTable,
    ref_id: refId,
  });
  if (error) throw error;
}

export async function loadWorkspace(supabase, id) {
  const { data: workspace, error } = await supabase
    .from('order_workspaces')
    .select(WORKSPACE_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!workspace) return null;

  const [
    customer,
    lines,
    tasks,
    promises,
    reminders,
    files,
    timeline,
  ] = await Promise.all([
    supabase.from('order_workspace_customers').select('*').eq('workspace_id', id).maybeSingle(),
    supabase.from('order_workspace_lines').select('*').eq('workspace_id', id).order('created_at', { ascending: true }),
    supabase.from('order_workspace_tasks').select('*').eq('workspace_id', id).order('created_at', { ascending: true }),
    supabase.from('order_workspace_promises').select('*').eq('workspace_id', id).order('created_at', { ascending: true }),
    supabase.from('order_workspace_reminders').select('*').eq('workspace_id', id).order('due_date', { ascending: true }),
    supabase.from('order_workspace_files').select('*').eq('workspace_id', id).order('uploaded_at', { ascending: false }),
    supabase.from('order_workspace_timeline').select('*').eq('workspace_id', id).order('created_at', { ascending: false }),
  ]);

  for (const result of [customer, lines, tasks, promises, reminders, files, timeline]) {
    if (result.error) throw result.error;
  }

  const row = {
    ...workspace,
    customer: customer.data || null,
    lines: lines.data || [],
    tasks: tasks.data || [],
    promises: promises.data || [],
    reminders: reminders.data || [],
    files: files.data || [],
    timeline: timeline.data || [],
  };
  row.deadlines = workspaceDeadlines(row);
  return row;
}

/**
 * Lightweight list rows for the workspace picker: the workspace columns plus a
 * minimal customer snapshot (for the row title). ONE extra query covers every
 * row, instead of loadWorkspace()'s seven-per-row deep fetch — the old list ran
 * 8×N queries (up to ~800 for a 100-row page). The detail pane re-fetches the
 * full workspace by id when a row is opened.
 */
export async function loadWorkspaceSummaries(supabase, workspaces) {
  const list = workspaces || [];
  if (!list.length) return [];
  const ids = list.map((w) => w.id);
  const { data: customers, error } = await supabase
    .from('order_workspace_customers')
    .select('workspace_id, customer_id, customer_name, account, contact, email, phone')
    .in('workspace_id', ids);
  if (error) throw error;
  const byWorkspace = new Map();
  for (const c of customers || []) byWorkspace.set(c.workspace_id, c);
  return list.map((w) => ({ ...w, customer: byWorkspace.get(w.id) || null }));
}

export async function findCustomers(supabase, query) {
  const safe = safeSearchTerm(query);
  if (!safe) return [];
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, contact_name, email, phone, business_name, customer_code')
    .or(`name.ilike.%${safe}%,email.ilike.%${safe}%,business_name.ilike.%${safe}%,contact_name.ilike.%${safe}%,customer_code.ilike.%${safe}%`)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) throw error;
  return data || [];
}

export async function createWorkspace(supabase, { actor, command = '', customerQuery = '', customerId = '' }) {
  let customer = null;
  let matches = [];
  if (customerId) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, contact_name, email, phone, business_name, customer_code')
      .eq('id', customerId)
      .maybeSingle();
    if (error) throw error;
    customer = data;
  } else {
    matches = await findCustomers(supabase, customerQuery);
    const resolved = resolveCustomerMatch(matches, customerQuery);
    if (resolved.ambiguous) return { ambiguous: true, matches: resolved.matches };
    customer = resolved.customer;
  }

  const snapshot = customerSnapshot(customer, customerQuery);
  const { data: workspace, error } = await supabase
    .from('order_workspaces')
    .insert({
      command,
      customer_id: snapshot.customerId,
      created_by: actor,
    })
    .select(WORKSPACE_SELECT)
    .single();
  if (error) throw error;

  const { error: customerError } = await supabase.from('order_workspace_customers').insert({
    workspace_id: workspace.id,
    customer_id: snapshot.customerId,
    customer_name: snapshot.customerName,
    account: snapshot.account,
    contact: snapshot.contact,
    email: snapshot.email,
    phone: snapshot.phone,
    notes: snapshot.notes,
  });
  if (customerError) throw customerError;

  await writeTimeline(supabase, workspace.id, {
    actor,
    eventType: 'order_created',
    summary: `Draft order workspace created${snapshot.customerName ? ` for ${snapshot.customerName}` : ''}`,
    refTable: 'order_workspaces',
    refId: workspace.id,
  });
  return { row: await loadWorkspace(supabase, workspace.id) };
}

export async function addWorkspaceLine(supabase, workspaceId, { actor, line }) {
  const normalized = normalizeLine(line);
  if (!normalized.sku && !normalized.description) {
    throw new Error('Product line needs SKU or description');
  }
  const { data, error } = await supabase.from('order_workspace_lines').insert({
    workspace_id: workspaceId,
    sku: normalized.sku,
    description: normalized.description,
    requested_qty: normalized.requestedQty,
    confirmed_qty: normalized.confirmedQty,
    status: normalized.status,
    supplier: normalized.supplier,
    price: normalized.price,
    availability: normalized.availability,
    created_by: actor,
  }).select('id').single();
  if (error) throw error;
  await touchWorkspace(supabase, workspaceId);
  await writeTimeline(supabase, workspaceId, {
    actor,
    eventType: 'line_added',
    summary: `Product line added: ${normalized.sku || normalized.description}`,
    refTable: 'order_workspace_lines',
    refId: data.id,
  });
  return loadWorkspace(supabase, workspaceId);
}

async function touchWorkspace(supabase, id, patch = {}) {
  const { error } = await supabase
    .from('order_workspaces')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const supabase = getPortalAdminClient();

  try {
    if (req.method === 'GET') {
      const { id = '', search = '', limit = '30', timeline = '' } = req.query || {};
      if (id && timeline === '1') {
        const { data, error } = await supabase
          .from('order_workspace_timeline')
          .select('*')
          .eq('workspace_id', id)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json({ timeline: data || [] });
      }
      if (id) return res.status(200).json({ row: await loadWorkspace(supabase, id) });

      const lim = Math.min(100, Math.max(1, Number(limit) || 30));
      let query = supabase
        .from('order_workspaces')
        .select(WORKSPACE_SELECT)
        .is('archived_at', null)
        .order('updated_at', { ascending: false })
        .limit(lim);
      const safe = safeSearchTerm(search);
      if (safe) query = query.or(`command.ilike.%${safe}%,supplier.ilike.%${safe}%,notes.ilike.%${safe}%`);
      const { data, error } = await query;
      if (error) throw error;
      // Summary rows only (batched) — the deep per-row load was an 8×N N+1.
      const rows = await loadWorkspaceSummaries(supabase, data || []);
      return res.status(200).json({ rows });
    }

    if (req.method === 'POST') {
      const actor = actorFromReq(req);
      const command = String(req.body?.command || '').trim();
      const parsed = parseOrderCommand(command);
      const customerQuery = String(req.body?.customerQuery || parsed?.customerQuery || '').trim();
      const created = await createWorkspace(supabase, {
        actor,
        command,
        customerQuery,
        customerId: req.body?.customerId || '',
      });
      if (created.ambiguous) {
        return res.status(409).json({
          error: 'Multiple customers match this order command',
          reason: 'customer_ambiguous',
          matches: created.matches,
        });
      }
      return res.status(201).json(created);
    }

    if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

    const actor = actorFromReq(req);
    const { id, action = 'update' } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const workspace = await loadWorkspace(supabase, id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    if (action === 'update') {
      const patch = {};
      if (req.body.dueDate !== undefined) patch.due_date = req.body.dueDate || null;
      if (req.body.notes !== undefined) patch.notes = String(req.body.notes || '');
      if (req.body.supplier !== undefined) patch.supplier = String(req.body.supplier || '').trim();
      if (req.body.priority !== undefined) patch.priority = String(req.body.priority || 'Normal');
      await touchWorkspace(supabase, id, patch);
      await writeTimeline(supabase, id, { actor, eventType: 'workspace_updated', summary: 'Workspace fields updated' });
    } else if (action === 'change_status') {
      const to = String(req.body.status || '').trim();
      assertValidTransition(workspace.status, to);
      await touchWorkspace(supabase, id, { status: to, archived_at: to === 'Closed' ? new Date().toISOString() : workspace.archived_at });
      await writeTimeline(supabase, id, { actor, eventType: 'status_changed', summary: `Status changed: ${workspace.status} -> ${to}` });
    } else if (action === 'add_line' || action === 'confirm_line') {
      const line = normalizeLine(req.body.line || req.body);
      if (!line.sku && !line.description) return res.status(400).json({ error: 'Product line needs SKU or description' });
      if (action === 'add_line') {
        const { data, error } = await supabase.from('order_workspace_lines').insert({
          workspace_id: id,
          sku: line.sku,
          description: line.description,
          requested_qty: line.requestedQty,
          confirmed_qty: line.confirmedQty,
          status: line.status,
          supplier: line.supplier,
          price: line.price,
          availability: line.availability,
          created_by: actor,
        }).select('id').single();
        if (error) throw error;
        await touchWorkspace(supabase, id);
        await writeTimeline(supabase, id, { actor, eventType: 'line_added', summary: `Product line added: ${line.sku || line.description}`, refTable: 'order_workspace_lines', refId: data.id });
      } else {
        if (!req.body.lineId) return res.status(400).json({ error: 'lineId required' });
        const { error } = await supabase.from('order_workspace_lines').update({
          confirmed_qty: line.confirmedQty,
          status: 'Confirmed',
          updated_at: new Date().toISOString(),
        }).eq('id', req.body.lineId).eq('workspace_id', id);
        if (error) throw error;
        await touchWorkspace(supabase, id, { status: workspace.status === 'Draft' ? 'Pending Review' : workspace.status });
        await writeTimeline(supabase, id, { actor, eventType: 'line_confirmed', summary: `Product line confirmed: ${line.sku || line.description}`, refTable: 'order_workspace_lines', refId: req.body.lineId });
      }
    } else if (action === 'add_task') {
      const title = String(req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Task title required' });
      const { data, error } = await supabase.from('order_workspace_tasks').insert({
        workspace_id: id,
        title,
        owner: String(req.body.owner || '').trim(),
        due_date: req.body.dueDate || null,
        created_by: actor,
      }).select('id').single();
      if (error) throw error;
      await touchWorkspace(supabase, id);
      await writeTimeline(supabase, id, { actor, eventType: 'task_created', summary: `Task created: ${title}`, refTable: 'order_workspace_tasks', refId: data.id });
    } else if (action === 'complete_task') {
      if (!req.body.taskId) return res.status(400).json({ error: 'taskId required' });
      const { error } = await supabase.from('order_workspace_tasks').update({
        status: 'Completed',
        completed_by: actor,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', req.body.taskId).eq('workspace_id', id);
      if (error) throw error;
      await touchWorkspace(supabase, id);
      await writeTimeline(supabase, id, { actor, eventType: 'task_completed', summary: 'Task completed', refTable: 'order_workspace_tasks', refId: req.body.taskId });
    } else if (action === 'add_promise') {
      const text = String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Promise text required' });
      const { data, error } = await supabase.from('order_workspace_promises').insert({
        workspace_id: id,
        promise_text: text,
        made_by: actor,
        made_to: String(req.body.madeTo || workspace.customer?.customer_name || '').trim(),
        due_date: req.body.dueDate || null,
      }).select('id').single();
      if (error) throw error;
      await touchWorkspace(supabase, id);
      await writeTimeline(supabase, id, { actor, eventType: 'promise_recorded', summary: `Promise recorded: ${text}`, refTable: 'order_workspace_promises', refId: data.id });
    } else if (action === 'add_reminder') {
      const title = String(req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Reminder title required' });
      if (!req.body.dueDate) return res.status(400).json({ error: 'Reminder due date required' });
      const { data, error } = await supabase.from('order_workspace_reminders').insert({
        workspace_id: id,
        title,
        due_date: req.body.dueDate,
        created_by: actor,
      }).select('id').single();
      if (error) throw error;
      await touchWorkspace(supabase, id);
      await writeTimeline(supabase, id, { actor, eventType: 'reminder_created', summary: `Reminder created: ${title}`, refTable: 'order_workspace_reminders', refId: data.id });
    } else {
      return res.status(400).json({ error: `Unsupported action: ${action}` });
    }

    return res.status(200).json({ row: await loadWorkspace(supabase, id) });
  } catch (err) {
    if (migrationError(err)) {
      return res.status(501).json({
        error: 'Orders Workspace migration not applied',
        migrationRequired: true,
        migration: 'migrations/044_order_workspaces_v1.sql',
      });
    }
    return res.status(400).json({ error: err.message || 'Order workspace request failed' });
  }
}

