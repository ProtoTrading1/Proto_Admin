import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const apiSource = fs.readFileSync(new URL('../api/notification-queue.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../src/components/NotificationQueueHealth.jsx', import.meta.url), 'utf8');
const adminSource = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');

test('queue visibility API is authenticated and read-only', () => {
  assert.match(apiSource, /requireAdminOrOrderToken/);
  assert.match(apiSource, /req\.method !== 'GET'/);
  assert.doesNotMatch(apiSource, /\.(insert|update|upsert|delete)\(/);
  assert.match(apiSource, /SAFE_JOB_COLUMNS/);
});

test('queue API exposes operational fields without job payloads or secrets', () => {
  for (const field of ['queued', 'processing', 'retry', 'deadLetter', 'attempts', 'nextRetryAt', 'recipient', 'heartbeat']) {
    assert.match(apiSource, new RegExp(field));
  }
  assert.doesNotMatch(apiSource, /\bpayload\b/i);
  assert.doesNotMatch(apiSource, /idempotency_key/);
  assert.doesNotMatch(apiSource, /lease_token/);
});

test('missing queue schema degrades to an explicit setup state', () => {
  assert.match(apiSource, /setupRequired:\s*true/);
  assert.match(apiSource, /isMissingQueueSchema/);
  assert.match(uiSource, /awaiting database setup/i);
});

test('Order Requests includes queue health, dead-letter and exact recipient visibility', () => {
  assert.match(adminSource, /<NotificationQueueHealth \/>/);
  assert.match(uiSource, /Dead-letter/);
  assert.match(uiSource, /Oldest waiting/);
  assert.match(uiSource, /Worker/);
  assert.match(uiSource, /job\.recipient/);
  assert.match(uiSource, /job\.attempts/);
  assert.match(uiSource, /job\.nextRetryAt/);
});
