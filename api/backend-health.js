// Backend Health is read-only; this comment also triggers the production deployment.
import { createClient } from '@supabase/supabase-js';
import { requireOwner } from './_admin-auth.js';
import { getStockClient, enrichRowsWithProductStock } from './_stock-client.js';
import { readOrderNotifyLog } from './_site-config.js';
import { evaluateCatalogueValues } from '../lib/catalogue-safety.mjs';
import {
  catalogueState,
  freshnessState,
  queueState,
  worstState,
} from '../lib/backend-health.mjs';

const CACHE_TTL_MS = 60_000;
const RECENT_ORDER_LIMIT = 20;
let cached = null;
let cachedAt = 0;
let inflight = null;

function getPortalClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function fetchAll(queryFactory, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < pageSize) break;
  }
  return rows;
}

async function checkBridge() {
  const bridgeUrl = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim();
  const bridgeKey = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();
  const sqlPassword = String(process.env.SQL_PASSWORD || '').trim();
  if (!bridgeUrl && !sqlPassword) {
    return {
      id: 'erp-bridge',
      label: 'ERP bridge',
      state: 'unknown',
      summary: 'No ERP bridge route is configured.',
      action: 'Configure the read-only Positill bridge.',
    };
  }
  const started = Date.now();
  try {
    if (bridgeUrl) {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (bridgeKey) headers['x-api-key'] = bridgeKey;
      const response = await fetch(`${bridgeUrl}/stmast`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sku: '8626100145' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
    } else {
      const sql = (await import('mssql')).default;
      const pool = await sql.connect({
        server: process.env.SQL_SERVER || 'BLADERUNNER-PC',
        database: process.env.SQL_DATABASE || 'POSWINSQL',
        user: process.env.SQL_USER || 'ProtoSyncReadOnly',
        password: sqlPassword,
        options: { encrypt: false, trustServerCertificate: true, readOnlyIntent: true },
        connectionTimeout: 8000,
        requestTimeout: 8000,
      });
      try {
        await pool.request().query('SELECT 1');
      } finally {
        await pool.close();
      }
    }
    return {
      id: 'erp-bridge',
      label: 'ERP bridge',
      state: 'healthy',
      summary: `Positill read-only bridge responded in ${Date.now() - started} ms.`,
    };
  } catch (error) {
    return {
      id: 'erp-bridge',
      label: 'ERP bridge',
      state: 'critical',
      summary: 'The Positill read-only bridge did not respond.',
      detail: error.message || 'Connection failed',
      action: 'Check the bridge service and its network connection.',
    };
  }
}

async function checkPortalDatabase() {
  const started = Date.now();
  const supabase = getPortalClient();
  const [latestOrder, jobs, heartbeat] = await Promise.all([
    supabase.from('orders')
      .select('id, order_number, created_at, status')
      .order('created_at', { ascending: false })
      .limit(RECENT_ORDER_LIMIT),
    supabase.from('order_notification_jobs')
      .select('status, next_attempt_at, last_error'),
    supabase.from('order_notification_worker_heartbeats')
      .select('status, updated_at, last_error')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  for (const result of [latestOrder, jobs, heartbeat]) {
    if (result.error) throw result.error;
  }

  const orders = latestOrder.data || [];
  const logs = await Promise.all(orders.map(async (order) => ({
    order,
    log: await readOrderNotifyLog(String(order.id)),
  })));
  const deliveryFailures = logs.filter(({ log }) => (
    log && (log.emailSent === false || log.emailError || log.emailFailReason)
  ));
  const missingDeliveryLogs = logs.filter(({ log }) => !log).length;
  const latest = orders[0] || null;
  const latestFreshness = freshnessState(latest?.created_at, {
    warningAfterHours: 48,
    criticalAfterHours: 168,
  });

  const queueCounts = {};
  let overdue = 0;
  for (const job of jobs.data || []) {
    queueCounts[job.status] = (queueCounts[job.status] || 0) + 1;
    if (['pending', 'retry_wait'].includes(job.status)
      && job.next_attempt_at
      && new Date(job.next_attempt_at).getTime() < Date.now()) overdue += 1;
  }
  const failed = (queueCounts.dead_letter || 0) + (queueCounts.failed || 0);
  const queueEnabled = String(process.env.ORDER_NOTIFICATION_QUEUE_ENABLED || '').toLowerCase() === 'true';
  const queueHealth = queueState({
    enabled: queueEnabled,
    failed,
    overdue,
    processing: queueCounts.processing || 0,
    heartbeatAt: heartbeat.data?.updated_at,
  });

  return [
    {
      id: 'portal-database',
      label: 'Orders database',
      state: 'healthy',
      summary: `Connected in ${Date.now() - started} ms.`,
      detail: latest ? `Latest order ${latest.order_number || latest.id}.` : 'No orders recorded.',
      measured: { latencyMs: Date.now() - started },
    },
    {
      id: 'latest-order',
      label: 'Latest successful order',
      state: latest ? latestFreshness.state : 'unknown',
      summary: latest
        ? `${latest.order_number || latest.id} was captured successfully.`
        : 'No order has been captured.',
      detail: latest?.created_at || null,
      measured: { orderNumber: latest?.order_number || null, createdAt: latest?.created_at || null },
      action: latestFreshness.state === 'critical'
        ? 'Confirm checkout is working and compare against expected trading activity.'
        : null,
    },
    {
      id: 'recent-email-delivery',
      label: 'Recent order emails',
      state: deliveryFailures.length > 0 ? 'critical' : (missingDeliveryLogs > 0 ? 'warning' : 'healthy'),
      summary: deliveryFailures.length > 0
        ? `${deliveryFailures.length} of the latest ${orders.length} orders show an email failure.`
        : `${orders.length - missingDeliveryLogs} of the latest ${orders.length} orders have a delivery record.`,
      detail: missingDeliveryLogs > 0
        ? `${missingDeliveryLogs} older or incomplete order records have no delivery log.`
        : 'No recorded email failure in the latest orders.',
      action: deliveryFailures.length > 0 ? 'Open Order Requests and resend the failed internal email.' : null,
      measured: { checked: orders.length, failures: deliveryFailures.length, missingLogs: missingDeliveryLogs },
    },
    {
      id: 'notification-queue',
      label: 'Durable email queue',
      state: queueHealth.state,
      summary: queueHealth.reason,
      detail: queueEnabled
        ? `Pending ${queueCounts.pending || 0} · retrying ${queueCounts.retry_wait || 0} · failed ${failed}.`
        : 'Preview infrastructure is installed; live checkout still uses the current direct email flow.',
      measured: { enabled: queueEnabled, counts: queueCounts, overdue, heartbeatAt: heartbeat.data?.updated_at || null },
      action: failed > 0 ? 'Review failed jobs before using exact retry.' : null,
    },
  ];
}

async function checkCatalogue() {
  const started = Date.now();
  const stock = getStockClient();
  const rows = await fetchAll(() => stock
    .from('website_stock')
    .select('sku, barcode, price, stock_qty, available_stock, updated_at'));
  const enriched = await enrichRowsWithProductStock(
    stock,
    rows.map((row) => ({
      ...row,
      website_available_stock: row.available_stock,
    })),
    { includePrice: true },
  );
  const counts = {
    invalidPrices: 0,
    doubleVat: 0,
    majorPriceMismatch: 0,
    majorStockMismatch: 0,
    unmatched: 0,
  };
  for (const row of enriched) {
    const issues = evaluateCatalogueValues({
      websitePrice: row.price,
      canonicalPrice: row.sell_price,
      websiteAvailable: row.website_available_stock,
      canonicalAvailable: row.stockLinked ? row.available_stock : null,
      matched: row.stockLinked,
    });
    for (const issue of issues) {
      if (issue.code === 'zero_or_invalid_price') counts.invalidPrices += 1;
      if (issue.code === 'double_vat_signature') counts.doubleVat += 1;
      if (issue.code === 'price_mismatch') counts.majorPriceMismatch += 1;
      if (issue.code === 'major_stock_mismatch') counts.majorStockMismatch += 1;
      if (issue.code === 'unmatched_product') counts.unmatched += 1;
    }
  }
  const safety = catalogueState(counts);
  const latestWebsiteAt = rows.reduce((latest, row) => (
    !latest || new Date(row.updated_at) > new Date(latest) ? row.updated_at : latest
  ), null);
  const freshness = freshnessState(latestWebsiteAt, {
    warningAfterHours: 12,
    criticalAfterHours: 48,
  });

  return [
    {
      id: 'catalogue-safety',
      label: 'Catalogue price & stock safety',
      state: safety.state,
      summary: safety.reason,
      detail: `${rows.length} live products checked · ${counts.unmatched} without an ERP match.`,
      measured: { liveProducts: rows.length, ...counts, latencyMs: Date.now() - started },
      action: safety.state !== 'healthy' ? 'Open Product Manager and review the safety warnings before publishing.' : null,
    },
    {
      id: 'catalogue-freshness',
      label: 'Catalogue freshness',
      state: freshness.state,
      summary: latestWebsiteAt ? 'Latest live catalogue update recorded.' : 'No catalogue update timestamp found.',
      detail: latestWebsiteAt,
      measured: { latestUpdateAt: latestWebsiteAt, ageHours: freshness.ageHours },
      action: freshness.state === 'critical' ? 'Confirm the ERP catalogue sync is still running.' : null,
    },
  ];
}

async function buildHealth() {
  const generatedAt = new Date().toISOString();
  const checks = [];
  const sources = [
    ['bridge', () => checkBridge()],
    ['orders', () => checkPortalDatabase()],
    ['catalogue', () => checkCatalogue()],
  ];
  const results = await Promise.all(sources.map(async ([source, run]) => {
    try {
      return await run();
    } catch (error) {
      return {
        id: `${source}-health`,
        label: `${source[0].toUpperCase()}${source.slice(1)} health`,
        state: 'critical',
        summary: `The ${source} health check failed.`,
        detail: error.message || 'Unknown health-check error',
        action: 'Check the service connection and Vercel function logs.',
      };
    }
  }));
  for (const result of results) checks.push(...(Array.isArray(result) ? result : [result]));
  checks.push({
    id: 'vercel-runtime',
    label: 'Vercel deployment',
    state: 'healthy',
    summary: 'This health function is running on Vercel.',
    detail: process.env.VERCEL_GIT_COMMIT_SHA
      ? `Release ${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 8)} · ${process.env.VERCEL_ENV || 'unknown environment'}`
      : `Release metadata unavailable · ${process.env.VERCEL_ENV || 'local environment'}`,
    measured: {
      environment: process.env.VERCEL_ENV || 'local',
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    },
  });
  return { overall: worstState(checks), generatedAt, checks };
}

function loadHealth(force = false) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) return Promise.resolve(cached);
  if (!force && inflight) return inflight;
  inflight = buildHealth()
    .then((payload) => {
      cached = payload;
      cachedAt = Date.now();
      return payload;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export default async function handler(req, res) {
  const requestId = String(req.headers['x-vercel-id'] || crypto.randomUUID());
  const started = Date.now();
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();
  console.info(JSON.stringify({ event: 'backend_health_start', requestId }));
  try {
    const payload = await loadHealth(req.query?.refresh === '1');
    console.info(JSON.stringify({
      event: 'backend_health_done',
      requestId,
      durationMs: Date.now() - started,
      overall: payload.overall,
    }));
    return res.status(200).json(payload);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'backend_health_error',
      requestId,
      durationMs: Date.now() - started,
      error: error.message || 'Health check failed',
    }));
    return res.status(500).json({ error: error.message || 'Health check failed' });
  }
}
