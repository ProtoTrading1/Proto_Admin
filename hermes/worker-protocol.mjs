import { isAnalysisId } from '../lib/analytics-report-contract.mjs';

export function requireWorkerReply(action, data) {
  if (action === 'claim') {
    if (data?.job === null) return data;
    const job = data?.job;
    if (isAnalysisId(job?.id) && isAnalysisId(job?.claimToken) && job.snapshot && typeof job.snapshot === 'object' && !Array.isArray(job.snapshot)) return data;
    throw new Error('Apollo received an invalid queue claim.');
  }
  if (data?.ok !== true) throw new Error('Apollo could not confirm that the job result was saved.');
  return data;
}

export function completedCodexUsage(stdout, requestedModel) {
  let usage;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'turn.completed') continue;
    const input = event.usage?.input_tokens;
    const output = event.usage?.output_tokens;
    if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) {
      usage = { model: requestedModel, inputTokens: input, outputTokens: output };
    }
  }
  if (!usage) throw new Error('Apollo did not receive a verified Codex completion event.');
  return usage;
}
