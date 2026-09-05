import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// The full prompt is already an argument. Signal EOF so Codex does not wait
// for additional piped input until the process timeout expires.
export function runWithClosedInput(file, args, options) {
  const execution = execute(file, args, options);
  execution.child.stdin?.end();
  return execution;
}

// Never send child-process output to the job API: it may contain the prompt,
// environment details or authentication diagnostics.
export function publicWorkerFailure(error) {
  if (error?.killed || error?.code === 'ETIMEDOUT') {
    return 'Apollo analysis timed out. The operator should check the worker before retrying.';
  }
  return 'Apollo could not complete this analysis. The operator should check the worker and its Codex sign-in.';
}

export async function checkWorkerPrerequisites({ codex, schema, env, run, read = readFile }) {
  if (!isAbsolute(codex) || !isAbsolute(schema)) {
    throw new Error('Worker executable and report schema must use explicit absolute paths.');
  }
  let parsed;
  try {
    parsed = JSON.parse(await read(schema, 'utf8'));
  } catch {
    throw new Error('Apollo report schema is missing or invalid. No job was claimed.');
  }
  if (parsed.type !== 'object' || !['summary', 'findings', 'limitations'].every((key) => parsed.required?.includes(key))) {
    throw new Error('Apollo report schema does not match the report contract. No job was claimed.');
  }
  const options = { env, timeout: 15000, maxBuffer: 65536 };
  try {
    await run(codex, ['--version'], options);
  } catch {
    throw new Error('Apollo cannot start Codex CLI. Check its installation and permissions. No job was claimed.');
  }
  try {
    await run(codex, ['login', 'status'], options);
  } catch {
    throw new Error('Apollo Codex sign-in is unavailable for the worker account. No job was claimed.');
  }
  return { ready: true };
}
