import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import assert from 'node:assert/strict';

// New-order alert (email-only). WhatsApp/WATI order notifications were removed
// entirely — the alert email IS the notification, so it must reach the whole
// team and must never be blocked by the PDF. (PT_00099 — 160 lines — reached
// nobody under the old rules.)

const notifySource = fs.readFileSync(new URL('../api/_order-notify-core.js', import.meta.url), 'utf8');
const brevoSource = fs.readFileSync(new URL('../api/_brevo-email.js', import.meta.url), 'utf8');

test('the new-order alert reaches the whole team, and config can only add', async () => {
  const { resolveOrderAlertRecipients } = await import('../api/_order-alert-recipients.js');
  const required = ['george@proto.co.za', 'online@proto.co.za', 'danieljoffeinfo@gmail.com'];
  assert.deepEqual(resolveOrderAlertRecipients(''), required);
  const withExtra = resolveOrderAlertRecipients('someone-else@example.com');
  for (const email of required) assert.ok(withExtra.includes(email), `${email} cannot be dropped`);
  assert.ok(withExtra.includes('someone-else@example.com'), 'configured extra is added');
  assert.deepEqual(resolveOrderAlertRecipients('GEORGE@Proto.co.za'), required);
});

test('Brevo transactional sends accept a list of recipients', () => {
  assert.match(brevoSource, /Array\.isArray\(to\) \? to : \[to\]/);
});

test('a missing or oversized PDF never cancels the alert', () => {
  assert.match(notifySource, /MAX_ALERT_ATTACHMENT_BYTES/, 'oversized PDFs are detected');
  assert.match(notifySource, /attachment: pdf \?/, 'the attachment is conditional');
  assert.match(notifySource, /pdfProblem/, 'the email says why the PDF is absent');
  assert.doesNotMatch(notifySource, /^\s*const pdf = await loadStoredOrderPdf/m, 'the PDF load is guarded');
});

test('no WATI/WhatsApp sends remain in the order-notify path', () => {
  assert.doesNotMatch(notifySource, /watiSend|sendTemplateMessage|whatsappNumber/, 'no WATI calls');
  assert.ok(!fs.existsSync(fileURLToPath(new URL('../api/_wati.js', import.meta.url))), '_wati.js deleted');
  assert.ok(!fs.existsSync(fileURLToPath(new URL('../api/team-whatsapp-test.js', import.meta.url))), 'team WhatsApp test deleted');
  assert.match(notifySource, /email is the notification/i);
});

// WATI came back for ONE purpose: broadcasting a new order to the fulfilment
// team. The original rule — no WhatsApp anywhere near the order-notify path,
// and never to a customer — still holds, so assert the boundary rather than
// the absence of the file.
test('WATI is reachable only from the internal team broadcast', () => {
  const wati = fileURLToPath(new URL('../api/_wati-notify.js', import.meta.url));
  assert.ok(fs.existsSync(wati), 'the team broadcast helper exists');

  const importers = fs.readdirSync(fileURLToPath(new URL('../api/', import.meta.url)))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /from '\.\/_wati-notify\.js'/.test(
      fs.readFileSync(new URL(`../api/${f}`, import.meta.url), 'utf8'),
    ));
  assert.deepEqual(importers, ['order-team-whatsapp.js'], 'only the team broadcast imports WATI');

  // Recipients must come from the fulfilment team store, never from customers.
  const broadcast = fs.readFileSync(new URL('../api/order-team-whatsapp.js', import.meta.url), 'utf8');
  assert.match(broadcast, /fulfillment\/users\.json/, 'recipients are team members');
  assert.doesNotMatch(broadcast, /accept_whatsapp|customers\.phone/, 'never targets a customer number');
});
