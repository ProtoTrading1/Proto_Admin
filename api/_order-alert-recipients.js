/**
 * Who receives the new-order alert.
 *
 * Mirrors Proto-Website-/api/_order-email-recipients.js — keep the two in sync.
 * The rule is the same in both places: configuration may ADD recipients but can
 * never DROP a required one. A single-address alert meant that when the portal's
 * own order email failed, the cron sweep and the manual resend could only ever
 * recover online@ — george@ and danieljoffeinfo@ stayed missing.
 */
const REQUIRED_ALERT_EMAILS = [
  'george@proto.co.za',
  'online@proto.co.za',
  'danieljoffeinfo@gmail.com',
];

export function resolveOrderAlertRecipients(
  raw = process.env.NEW_ORDER_ALERT_EMAIL || '',
) {
  const extra = raw
    ? String(raw).split(',').map((part) => part.trim()).filter(Boolean)
    : [];

  return [...new Set(
    [...REQUIRED_ALERT_EMAILS, ...extra].map((email) => email.toLowerCase()),
  )];
}
