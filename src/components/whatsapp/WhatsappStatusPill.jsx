import { STATUS_COLOURS, STATUS_LABELS } from '../../lib/whatsappFormat';

/**
 * Delivery status badge.
 *
 * "Sent" is amber, not green: on WhatsApp a message that is sent but never
 * delivered usually means the number is not reachable, and colouring it as a
 * success is how a broadcast looks fine while half of it goes nowhere.
 */
export default function WhatsappStatusPill({ status }) {
  const tone = STATUS_COLOURS[status] || STATUS_COLOURS.queued;
  return (
    <span
      style={{
        background: tone.bg,
        color: tone.fg,
        fontSize: 11,
        fontWeight: 700,
        padding: '3px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      {STATUS_LABELS[status] || status || '—'}
    </span>
  );
}
