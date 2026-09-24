/** Shared formatting for the WhatsApp CRM screens. */

export function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-ZA', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function formatWhenLong(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-ZA', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatCount(value) {
  return new Intl.NumberFormat('en-ZA').format(Number(value || 0));
}

export function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}%` : '—';
}

export const STATUS_LABELS = {
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  received: 'Received',
};

/**
 * Status colours. Read is the win state, so it gets the strongest treatment;
 * "sent but never delivered" is amber rather than green because on WhatsApp it
 * usually means the number is not reachable.
 */
export const STATUS_COLOURS = {
  queued: { bg: '#f1f5f9', fg: '#475569' },
  sent: { bg: '#fef3c7', fg: '#92400e' },
  delivered: { bg: '#dbeafe', fg: '#1e40af' },
  read: { bg: '#dcfce7', fg: '#166534' },
  failed: { bg: '#fee2e2', fg: '#991b1b' },
  received: { bg: '#ede9fe', fg: '#5b21b6' },
};
