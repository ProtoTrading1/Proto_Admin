import { Suspense, useState } from 'react';
import { BarChart2, LayoutDashboard, Loader2, Send, UserX, Users } from 'lucide-react';
import { lazyRetry } from '../lib/lazyRetry';
import WhatsappConnectionStatus from './whatsapp/WhatsappConnectionStatus';

const WhatsappDashboard = lazyRetry(() => import('./whatsapp/WhatsappDashboard'));
const WhatsappContacts = lazyRetry(() => import('./whatsapp/WhatsappContacts'));
const WhatsappComposer = lazyRetry(() => import('./whatsapp/WhatsappComposer'));
const WhatsappAnalytics = lazyRetry(() => import('./whatsapp/WhatsappAnalytics'));
const WhatsappOptOuts = lazyRetry(() => import('./whatsapp/WhatsappOptOuts'));

/**
 * WhatsApp CRM — the WATI side of customer comms, alongside the Email CRM.
 *
 * Scope, deliberately narrow: this messages only customers who ticked the
 * WhatsApp opt-in on their trade application, only through WATI templates
 * WhatsApp has approved, and never anyone on the opt-out list. The internal
 * fulfilment-team alert (api/order-team-whatsapp.js) is a separate path and is
 * untouched by anything here.
 */

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'broadcast', label: 'Broadcast', icon: Send },
  { id: 'analytics', label: 'Analytics', icon: BarChart2 },
  { id: 'opt-outs', label: 'Opted out', icon: UserX },
];

function TabFallback({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: '#6b7280', fontSize: 13 }} role="status" aria-live="polite">
      <Loader2 size={16} className="spin" /> {label}
    </div>
  );
}

export default function WhatsappPanel({ onShowToast, isOwner = true }) {
  const [tab, setTab] = useState('dashboard');
  // Contacts hands a ticked list to the composer. Kept here so switching tabs
  // does not lose a selection the admin just spent time making.
  const [composeTargets, setComposeTargets] = useState([]);
  const [focusBroadcastId, setFocusBroadcastId] = useState(null);
  // Remounts the composer after a send so it resets rather than leaving a
  // finished broadcast looking ready to fire again.
  const [composerKey, setComposerKey] = useState(0);

  const openBroadcast = (phones = []) => {
    setComposeTargets(phones);
    setComposerKey((key) => key + 1);
    setTab('broadcast');
  };

  return (
    <div className="adm-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title">WhatsApp CRM</h2>
          <p className="adm-section-note">
            Broadcasts, delivery and click analytics for the customers who opted in to WhatsApp,
            sent through your WATI account. Customers who opt out are blocked from every future
            broadcast automatically.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <WhatsappConnectionStatus />
          <button type="button" className="adm-btn-red" onClick={() => openBroadcast([])}>
            <Send size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
            New broadcast
          </button>
        </div>
      </div>

      <div className="adm-customer-tabs" style={{ marginBottom: 14 }}>
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`adm-tab${tab === item.id ? ' adm-tab--active' : ''}`}
              onClick={() => {
                if (item.id !== 'analytics') setFocusBroadcastId(null);
                setTab(item.id);
              }}
            >
              <Icon size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'dashboard' && (
        <Suspense fallback={<TabFallback label="Loading the WhatsApp dashboard…" />}>
          <WhatsappDashboard
            onShowToast={onShowToast}
            onOpenBroadcast={() => openBroadcast([])}
            onOpenTab={setTab}
          />
        </Suspense>
      )}

      {tab === 'contacts' && (
        <Suspense fallback={<TabFallback label="Loading WhatsApp contacts…" />}>
          <WhatsappContacts onShowToast={onShowToast} onBroadcastToSelection={openBroadcast} />
        </Suspense>
      )}

      {tab === 'broadcast' && (
        <Suspense fallback={<TabFallback label="Loading the broadcast composer…" />}>
          <WhatsappComposer
            key={composerKey}
            onShowToast={onShowToast}
            initialPhones={composeTargets}
            onSent={(result) => {
              if (result?.broadcastId) {
                setFocusBroadcastId(result.broadcastId);
                setTab('analytics');
              }
              setComposeTargets([]);
            }}
          />
        </Suspense>
      )}

      {tab === 'analytics' && (
        <Suspense fallback={<TabFallback label="Loading broadcast analytics…" />}>
          <WhatsappAnalytics onShowToast={onShowToast} focusBroadcastId={focusBroadcastId} />
        </Suspense>
      )}

      {tab === 'opt-outs' && (
        <Suspense fallback={<TabFallback label="Loading opted-out contacts…" />}>
          <WhatsappOptOuts onShowToast={onShowToast} canResubscribe={isOwner} />
        </Suspense>
      )}
    </div>
  );
}
