import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validAnalyticsReport } from '../lib/analytics-report-contract.mjs';
import { completedCodexUsage, requireWorkerReply } from '../hermes/worker-protocol.mjs';
const { client, gateway } = vi.hoisted(() => ({ client: vi.fn(), gateway: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: client }));
vi.mock('../api/_analytics-preview-gateway.js', async (original) => ({ ...(await original()), callPreviewAnalyticsGateway: gateway }));
import handler from '../api/codex-analytics-worker.js';

const report = { summary: 'Synthetic figures only.', findings: [], limitations: ['Not live data.'] };
const id = '11111111-1111-4111-8111-111111111111';
function res() { return { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function req(body) { return { method: 'POST', headers: { 'x-codex-worker-secret': 'test' }, body: { workerId: 'test-worker', ...body } }; }
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ VERCEL_ENV: 'preview', CODEX_ANALYTICS_WORKER_SECRET: 'test', ANALYTICS_PREVIEW_WRITES_ENABLED: 'true', ANALYTICS_PREVIEW_PROJECT_REF: 'xicygaamdogfdpzyrlcp', ANALYTICS_PREVIEW_GATEWAY_SECRET: 'test', ANALYTICS_PREVIEW_GATEWAY_URL: 'https://xicygaamdogfdpzyrlcp.supabase.co/functions/v1/proto-analytics-preview-gateway' })) vi.stubEnv(key, value);
  gateway.mockResolvedValue({ ok: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('Apollo report completion contract', () => {
  it.each([undefined, '', ' ', ' padded ', 'x'.repeat(101)])('rejects invalid worker identity before claiming %j', async (workerId) => {
    const response = res();
    await handler(req({ action: 'claim', workerId }), response);
    expect(response.code).toBe(400);
    expect(gateway).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });
  it('accepts only a bounded structured report', () => {
    expect(validAnalyticsReport(report)).toBe(true);
    expect(validAnalyticsReport({ ...report, findings: [{ severity: 'low', title: 'Check', explanation: 'Evidence', recommendedAction: 'Review', evidence: ['3 views'] }] })).toBe(true);
  });
  it.each([null, [], { summary: { invalid: true } }, { ...report, summary: '' }, { ...report, summary: 'x'.repeat(1201) }, { ...report, findings: [{}] }, { ...report, limitations: [false] }, { ...report, unexpected: true }])('rejects malformed report %j', (value) => {
    expect(validAnalyticsReport(value)).toBe(false);
  });
  it('rejects invalid completion before any gateway or database operation', async () => {
    const response = res();
    await handler(req({ action: 'complete', jobId: id, claimToken: id, workerId: 'test', result: { summary: { invalid: true } } }), response);
    expect(response.code).toBe(400);
    expect(gateway).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });
  it('requires claim identifiers in preview as well as production', async () => {
    const response = res();
    await handler(req({ action: 'complete', result: report }), response);
    expect(response.code).toBe(400);
    expect(gateway).not.toHaveBeenCalled();
  });
  it('never returns raw gateway diagnostics', async () => {
    gateway.mockRejectedValue(new Error('SECRET credential and internal prompt'));
    const response = res();
    await handler(req({ action: 'claim' }), response);
    expect(response.code).toBe(502);
    expect(JSON.stringify(response.body)).not.toMatch(/SECRET|credential|prompt/);
  });
  it.each([{}, { ok: false }, { ok: 'true' }])('requires a positive completion acknowledgement %j', (value) => {
    expect(() => requireWorkerReply('complete', value)).toThrow('could not confirm');
  });
  it('validates claims and accepts explicit empty queues', () => {
    expect(requireWorkerReply('claim', { job: null })).toEqual({ job: null });
    expect(() => requireWorkerReply('claim', {})).toThrow('invalid queue');
    expect(requireWorkerReply('claim', { job: { id, claimToken: id, snapshot: {} } })).toHaveProperty('job.id', id);
    expect(requireWorkerReply('complete', { ok: true })).toEqual({ ok: true });
  });
  it.each(['', '{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":null,"output_tokens":0}}'])('does not invent completion/token evidence %j', (stdout) => {
    expect(() => completedCodexUsage(stdout, 'requested-model')).toThrow('verified Codex completion');
  });
  it('records actual completion usage, including genuine zero', () => {
    expect(completedCodexUsage('noise\n{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":0}}', 'requested-model')).toEqual({ model: 'requested-model', inputTokens: 20, outputTokens: 0 });
  });
});
