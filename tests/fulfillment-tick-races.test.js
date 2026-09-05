import fs from 'node:fs';
import { test } from 'vitest';
import assert from 'node:assert/strict';

// Ticks on the fulfilment checklist were vanishing "out of nowhere". Two
// client races (a poll snapshot taken before a tick resolving after it, and
// two ticks' responses arriving out of order) plus one server race (writes in
// the same millisecond tie on updatedAt and clobber each other). These
// assertions pin the shape of all three fixes.

const pageSrc = fs.readFileSync(new URL('../src/pages/FulfillmentPage.jsx', import.meta.url), 'utf8');
const mutateSrc = fs.readFileSync(new URL('../api/_site-config-mutate.js', import.meta.url), 'utf8');

test('every server snapshot is overlaid with in-flight ticks before painting', () => {
  assert.match(pageSrc, /pendingTicksRef/, 'in-flight ticks are tracked per item');
  assert.match(pageSrc, /setProgress\(overlayPendingTicks\(data\)\)/, 'snapshots are overlaid, never applied raw');
  assert.doesNotMatch(pageSrc, /setProgress\(data\)/, 'no raw server snapshot reaches the screen');
});

test('a poll snapshot that predates a tick is discarded', () => {
  assert.match(pageSrc, /const startedAt = Date\.now\(\)/, 'poll records when it started');
  assert.match(pageSrc, /if \(lastTickAtRef\.current > startedAt\) return/, 'stale snapshots are dropped');
});

test('concurrent same-millisecond writes are detected server-side', () => {
  assert.match(mutateSrc, /__rev/, 'a per-write revision exists');
  assert.match(mutateSrc, /randomUUID\(\)/, 'the revision is unique per write, not a timestamp');
});
