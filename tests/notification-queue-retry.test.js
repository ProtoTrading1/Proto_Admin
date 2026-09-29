import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const apiSource = fs.readFileSync(new URL('../api/notification-queue-retry.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../src/components/NotificationQueueHealth.jsx', import.meta.url), 'utf8');

test('manual queue retry requires a verified human admin and a valid UUID', () => {
  assert.match(apiSource, /verifyAdminUser\(req\)/);
  assert.doesNotMatch(apiSource, /requireAdminOrOrderToken/);
  assert.doesNotMatch(apiSource, /hasAdminKey|requireAdminKey/);
  assert.match(apiSource, /UUID_RE\.test\(jobId\)/);
});

test('only one retry_wait or dead_letter job can be requeued', () => {
  assert.match(apiSource, /new Set\(\['dead_letter', 'retry_wait'\]\)/);
  assert.match(apiSource, /\.eq\('id', jobId\)/);
  assert.match(apiSource, /retry_order_notification_job/);
  assert.match(apiSource, /p_job_id:\s*jobId/);
  assert.doesNotMatch(apiSource, /\.in\('id'/);
});

test('retry is audited with bounded actor and reason and does not send to a provider', () => {
  assert.match(apiSource, /MAX_REASON_LENGTH = 240/);
  assert.match(apiSource, /p_actor:\s*actor/);
  assert.match(apiSource, /p_reason:\s*reason/);
  assert.doesNotMatch(apiSource, /wati|brevo|sendTemplate|sendBrevo/i);
});

test('UI confirms and retries only the selected failed recipient', () => {
  assert.match(uiSource, /Retry failed only/);
  assert.match(uiSource, /\['dead_letter', 'retry_wait'\]\.includes\(job\.state\)/);
  assert.match(uiSource, /No other recipients will be retried/);
  assert.match(uiSource, /jobId:\s*job\.id/);
  assert.match(uiSource, /await load\(\)/);
});
