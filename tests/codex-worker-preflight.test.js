import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkWorkerPrerequisites, publicWorkerFailure, runWithClosedInput } from '../hermes/worker-preflight.mjs';

describe('Apollo child-process input', () => {
  it('closes input so an EOF-dependent process can return its report', async () => {
    const script = 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("INPUT_CLOSED_OK"));';
    const result = await runWithClosedInput(process.execPath, ['-e', script], { timeout: 2000 });
    expect(result.stdout).toBe('INPUT_CLOSED_OK');
  });
  it('preserves failed process exit codes', async () => {
    await expect(runWithClosedInput(process.execPath, ['-e', 'process.exit(7)'], { timeout: 2000 }))
      .rejects.toMatchObject({ code: 7 });
  });
  it('preserves the timeout for a genuinely stalled process', async () => {
    await expect(runWithClosedInput(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 200 }))
      .rejects.toMatchObject({ killed: true });
  });
  it('connects the worker to the EOF-safe runner', () => {
    const source = readFileSync(new URL('../hermes/codex-analytics-worker.mjs', import.meta.url), 'utf8');
    expect(source).toContain('runWithClosedInput as run');
    expect(source).not.toContain('promisify(execFile)');
  });
});

function fixture() {
  return {
    codex: '/opt/proto-analytics/codex', schema: '/opt/proto-analytics/schema.json',
    env: { PATH: '/usr/bin' }, run: vi.fn().mockResolvedValue({ stdout: 'ok' }),
    read: vi.fn().mockResolvedValue(JSON.stringify({ type: 'object', required: ['summary', 'findings', 'limitations'] })),
  };
}

describe('Apollo worker prerequisites', () => {
  it('checks the installed CLI and worker-account login without invoking a model', async () => {
    const input = fixture();
    await expect(checkWorkerPrerequisites(input)).resolves.toEqual({ ready: true });
    expect(input.run.mock.calls.map((call) => call[1])).toEqual([['--version'], ['login', 'status']]);
    expect(input.run.mock.calls[1][2]).toEqual({ env: input.env, timeout: 15000, maxBuffer: 65536 });
  });
  it('rejects implicit executable paths', async () => {
    const input = fixture();
    input.codex = 'codex';
    await expect(checkWorkerPrerequisites(input)).rejects.toThrow('absolute paths');
    expect(input.run).not.toHaveBeenCalled();
  });
  it.each(['not-json', '{"type":"object","required":["summary"]}'])('rejects unusable report schemas before invoking Codex', async (contents) => {
    const input = fixture();
    input.read.mockResolvedValue(contents);
    await expect(checkWorkerPrerequisites(input)).rejects.toThrow('No job was claimed');
    expect(input.run).not.toHaveBeenCalled();
  });
  it('handles a missing schema', async () => {
    const input = fixture();
    input.read.mockRejectedValue(new Error('private path'));
    await expect(checkWorkerPrerequisites(input)).rejects.toThrow('schema is missing or invalid');
  });
  it('does not leak executable errors', async () => {
    const input = fixture();
    input.run.mockRejectedValue(new Error('SECRET stderr and prompt'));
    await expect(checkWorkerPrerequisites(input)).rejects.toThrow('cannot start Codex CLI');
  });
  it('detects missing login before claiming', async () => {
    const input = fixture();
    input.run.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('secret diagnostic'));
    await expect(checkWorkerPrerequisites(input)).rejects.toThrow('sign-in is unavailable');
  });
  it('redacts failures sent back to the API', () => {
    expect(publicWorkerFailure(new Error('TOKEN AND PRIVATE PROMPT'))).not.toMatch(/TOKEN|PRIVATE/);
    expect(publicWorkerFailure({ killed: true })).toContain('timed out');
  });
  it('runs the prerequisites before the first queue claim and keeps a no-claim check mode', () => {
    const source = readFileSync(new URL('../hermes/codex-analytics-worker.mjs', import.meta.url), 'utf8');
    expect(source.indexOf('await checkWorkerPrerequisites')).toBeLessThan(source.indexOf("workerRequest({ action: 'claim'"));
    expect(source.indexOf("process.argv.includes('--check')")).toBeLessThan(source.indexOf("workerRequest({ action: 'claim'"));
    expect(source).not.toContain('error: error.message');
  });
});
