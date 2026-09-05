import { CheckCircle2 } from 'lucide-react';
import {
  getWorkflowMeta,
  getStatusTimestamp,
  normalizeOrderStatus,
  WORKFLOW_STATUSES,
} from '../lib/orderStatus';

function formatStatusTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-ZA', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function OrderWorkflowBadge({ order, compact = false }) {
  const status = normalizeOrderStatus(order?.status);
  const meta = getWorkflowMeta(status);
  const ts = getStatusTimestamp(order, status);
  const step = meta.step;
  const total = WORKFLOW_STATUSES.length - 1;

  return (
    <div className="order-workflow-badge-wrap">
      <span
        className="order-workflow-badge"
        style={{
          color: meta.color,
          background: meta.bg,
          border: `1px solid ${meta.color}22`,
        }}
        title={ts ? `Updated ${formatStatusTime(ts)}` : meta.label}
      >
        {status === 'payment received' && <CheckCircle2 size={13} strokeWidth={2.5} />}
        {meta.label}
      </span>
      {!compact && (
        <div className="order-workflow-steps" aria-hidden="true">
          {WORKFLOW_STATUSES.slice(1).map((key, i) => {
            const done = step > i + 1;
            const active = step === i + 1;
            const m = getWorkflowMeta(key);
            return (
              <span
                key={key}
                className={`order-workflow-step${done ? ' order-workflow-step--done' : ''}${active ? ' order-workflow-step--active' : ''}`}
                style={active ? { background: m.color } : undefined}
              />
            );
          })}
        </div>
      )}
      {ts && !compact && (
        <span className="order-workflow-ts">{formatStatusTime(ts)}</span>
      )}
    </div>
  );
}
