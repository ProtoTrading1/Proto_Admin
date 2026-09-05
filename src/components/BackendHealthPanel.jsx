import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock3,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from 'lucide-react';

const LABELS = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
  disabled: 'Disabled',
};

function formatAge(hours) {
  if (hours == null) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${Math.round(hours)} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function StatusIcon({ state }) {
  if (state === 'healthy') return <CheckCircle2 size={22} />;
  if (state === 'critical') return <ShieldAlert size={22} />;
  if (state === 'warning') return <AlertTriangle size={22} />;
  if (state === 'disabled') return <Clock3 size={22} />;
  return <CircleHelp size={22} />;
}

function HealthCard({ check }) {
  const age = formatAge(check.measured?.ageHours);
  return (
    <article className={`health-card health-card--${check.state}`}>
      <div className="health-card__icon"><StatusIcon state={check.state} /></div>
      <div className="health-card__body">
        <div className="health-card__heading">
          <h3>{check.label}</h3>
          <span className={`health-pill health-pill--${check.state}`}>{LABELS[check.state] || 'Unknown'}</span>
        </div>
        <p className="health-card__summary">{check.summary}</p>
        {check.detail && <p className="health-card__detail">{check.detail}</p>}
        {age && <p className="health-card__age">{age}</p>}
        {check.action && (
          <div className="health-card__action">
            <Wrench size={14} />
            <span>{check.action}</span>
          </div>
        )}
      </div>
    </article>
  );
}

export default function BackendHealthPanel() {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/backend-health${force ? '?refresh=1' : ''}`, {
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Backend health check failed');
      setPayload(data);
    } catch (loadError) {
      setError(loadError.message || 'Backend health check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const criticalCount = payload?.checks?.filter((check) => check.state === 'critical').length || 0;
  const warningCount = payload?.checks?.filter((check) => check.state === 'warning').length || 0;

  return (
    <section className="adm-panel health-panel" aria-labelledby="backend-health-title">
      <div className="health-panel__head">
        <div>
          <h2 id="backend-health-title" className="adm-section-title">Backend Health</h2>
          <p className="adm-section-note">
            Read-only checks for orders, email delivery, the durable queue, catalogue safety, ERP, databases and this Vercel release.
          </p>
        </div>
        <button type="button" className="adm-btn-ghost" onClick={() => void load(true)} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          {loading ? 'Checking…' : 'Refresh now'}
        </button>
      </div>

      {error && (
        <div className="health-overall health-overall--critical" role="alert">
          <ShieldAlert size={26} />
          <div><strong>Health check unavailable</strong><span>{error}</span></div>
        </div>
      )}

      {payload && (
        <>
          <div className={`health-overall health-overall--${payload.overall}`} role={criticalCount ? 'alert' : 'status'}>
            <StatusIcon state={payload.overall} />
            <div>
              <strong>
                {criticalCount
                  ? `${criticalCount} critical backend warning${criticalCount === 1 ? '' : 's'}`
                  : warningCount
                    ? `${warningCount} backend warning${warningCount === 1 ? '' : 's'}`
                    : 'All monitored backend systems are healthy'}
              </strong>
              <span>Last checked {new Date(payload.generatedAt).toLocaleString('en-ZA')}</span>
            </div>
          </div>
          <div className="health-grid">
            {payload.checks.map((check) => <HealthCard key={check.id} check={check} />)}
          </div>
          <p className="health-panel__footnote">
            WhatsApp is intentionally excluded until the WhatsApp delivery channel is introduced.
          </p>
        </>
      )}
    </section>
  );
}
