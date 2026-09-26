import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  ServerCog,
} from 'lucide-react';

function age(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const value = Math.max(0, Number(seconds));
  if (value < 60) return `${Math.floor(value)} sec`;
  if (value < 3600) return `${Math.floor(value / 60)} min`;
  if (value < 86400) return `${Math.floor(value / 3600)} hr`;
  return `${Math.floor(value / 86400)} day`;
}

function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-ZA', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Metric({ label, value, tone = 'neutral' }) {
  const colours = {
    neutral: ['#f8fafc', '#cbd5e1', '#334155'],
    good: ['#f0fdf4', '#bbf7d0', '#166534'],
    warn: ['#fffbeb', '#fde68a', '#92400e'],
    bad: ['#fef2f2', '#fecaca', '#991b1b'],
  };
  const [background, borderColor, color] = colours[tone] || colours.neutral;
  return (
    <div style={{ padding: '9px 12px', border: `1px solid ${borderColor}`, borderRadius: 8, background, color }}>
      <strong style={{ display: 'block', fontSize: 18 }}>{value}</strong>
      <span style={{ display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
    </div>
  );
}

export default function NotificationQueueHealth({ orderId = '' }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryingJobId, setRetryingJobId] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: orderId ? '100' : '25' });
      if (orderId) params.set('orderId', orderId);
      const response = await fetch(`/api/notification-queue?${params}`);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || 'Queue health check failed');
      setData(json);
    } catch (err) {
      setError(err.message || 'Queue health check failed');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  const retryJob = async (job) => {
    if (!['dead_letter', 'retry_wait'].includes(job?.state)) return;
    const target = job.recipient || 'this recipient';
    const reason = window.prompt(
      `Reason for retrying only the failed ${job.channel || 'notification'} to ${target}:`,
      'Verified failure; retry this recipient only',
    );
    if (reason == null) return;
    if (!window.confirm(`Retry only this queue job for ${target}? No other recipients will be retried.`)) return;

    setRetryingJobId(job.id);
    setActionMessage('');
    try {
      const response = await fetch('/api/notification-queue-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, reason }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || 'Queue retry failed');
      setActionMessage(`Queued one retry for ${json.recipient || target}.`);
      await load();
    } catch (err) {
      setActionMessage(err.message || 'Queue retry failed');
    } finally {
      setRetryingJobId('');
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading && !data) {
    return (
      <div style={{ margin: '10px 0', padding: 12, border: '1px solid #e2e8f0', borderRadius: 9, color: '#64748b' }}>
        <Loader2 size={14} className="star-spinning" /> Checking notification queue…
      </div>
    );
  }

  if (data?.setupRequired) {
    return (
      <div style={{ margin: '10px 0', padding: 12, border: '1px solid #cbd5e1', borderRadius: 9, background: '#f8fafc', color: '#475569', fontSize: 12 }}>
        <strong>Durable notification queue: awaiting database setup</strong>
        <div style={{ marginTop: 3 }}>Current order delivery continues unchanged. This panel will activate after the queue migration.</div>
      </div>
    );
  }

  const counts = data?.counts || {};
  const heartbeat = data?.heartbeat;
  const unhealthy = Number(counts.deadLetter || 0) > 0 || heartbeat?.stale;

  return (
    <section style={{ margin: '10px 0 14px', padding: 12, border: `1px solid ${unhealthy ? '#fecaca' : '#dbeafe'}`, borderRadius: 10, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <ServerCog size={16} color={unhealthy ? '#b91c1c' : '#1d4ed8'} />
        <strong style={{ fontSize: 13 }}>Notification queue health</strong>
        <span style={{ color: '#64748b', fontSize: 11 }}>Read-only · refreshed {stamp(data?.checkedAt)}</span>
        <button type="button" className="adm-icon-btn" onClick={() => void load()} disabled={loading} title="Refresh queue health" style={{ marginLeft: 'auto' }}>
          {loading ? <Loader2 size={13} className="star-spinning" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {error && <div style={{ color: '#b91c1c', fontSize: 12, marginBottom: 8 }}><AlertTriangle size={13} /> {error}</div>}
      {actionMessage && <div style={{ color: '#334155', fontSize: 12, marginBottom: 8 }}>{actionMessage}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))', gap: 7 }}>
        <Metric label="Queued" value={Number(counts.queued || 0)} tone={counts.queued ? 'warn' : 'good'} />
        <Metric label="Processing" value={Number(counts.processing || 0)} />
        <Metric label="Retrying" value={Number(counts.retry || 0)} tone={counts.retry ? 'warn' : 'good'} />
        <Metric label="Dead-letter" value={Number(counts.deadLetter || 0)} tone={counts.deadLetter ? 'bad' : 'good'} />
        <Metric label="Oldest waiting" value={age(data?.oldest?.ageSeconds)} tone={Number(data?.oldest?.ageSeconds || 0) > 900 ? 'bad' : 'neutral'} />
        <Metric label="Worker" value={!heartbeat ? 'No signal' : heartbeat.stale ? 'Stale' : 'Online'} tone={!heartbeat || heartbeat.stale ? 'bad' : 'good'} />
      </div>

      {heartbeat && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 9, fontSize: 11, color: heartbeat.stale ? '#b91c1c' : '#166534' }}>
          {heartbeat.stale ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
          Worker {heartbeat.worker || 'default'} · last heartbeat {age(heartbeat.ageSeconds)} ago
          {heartbeat.error ? ` · ${heartbeat.error}` : ''}
        </div>
      )}

      {(data?.jobs || []).length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Recent queue jobs ({data.jobs.length})</summary>
          <div style={{ overflowX: 'auto', marginTop: 7 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={{ padding: '5px 6px' }}>Order / channel</th>
                  <th style={{ padding: '5px 6px' }}>Recipient</th>
                  <th style={{ padding: '5px 6px' }}>State</th>
                  <th style={{ padding: '5px 6px' }}>Attempts</th>
                  <th style={{ padding: '5px 6px' }}>Next retry</th>
                  <th style={{ padding: '5px 6px' }}>Failure</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '6px' }}><strong>{job.orderId || '—'}</strong><br />{job.channel || '—'}</td>
                    <td style={{ padding: '6px', overflowWrap: 'anywhere' }}>{job.recipient || '—'}</td>
                    <td style={{ padding: '6px' }}>{job.state || '—'}</td>
                    <td style={{ padding: '6px' }}>{job.attempts}/{job.maxAttempts || '—'}</td>
                    <td style={{ padding: '6px' }}>{job.nextRetryAt ? <><RotateCcw size={11} /> {stamp(job.nextRetryAt)}</> : '—'}</td>
                    <td style={{ padding: '6px', color: job.error ? '#b91c1c' : '#64748b', maxWidth: 300, overflowWrap: 'anywhere' }}>
                      {job.errorCode ? `${job.errorCode}: ` : ''}{job.error || '—'}
                      {['dead_letter', 'retry_wait'].includes(job.state) && (
                        <button
                          type="button"
                          className="adm-btn-ghost adm-btn-sm"
                          onClick={() => void retryJob(job)}
                          disabled={Boolean(retryingJobId)}
                          style={{ display: 'flex', marginTop: 5, padding: '4px 7px', fontSize: 10 }}
                          title={`Retry only ${job.recipient || 'this failed recipient'}`}
                        >
                          {retryingJobId === job.id
                            ? <Loader2 size={11} className="star-spinning" />
                            : <RotateCcw size={11} />}
                          Retry failed only
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {!heartbeat && data?.available && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 9, fontSize: 11, color: '#92400e' }}>
          <Clock3 size={12} /> No worker heartbeat has been recorded yet.
        </div>
      )}
    </section>
  );
}
