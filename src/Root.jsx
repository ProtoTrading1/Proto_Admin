import { useEffect, useState, Suspense } from 'react';
import { installAuthFetch, hasFulfillmentToken } from './lib/adminKey';
import { clearChunkReloadGuard, lazyRetry } from './lib/lazyRetry';
import {
  getVerifiedSession,
  getAdminRole,
  isAllowedAdminEmail,
  onAuthStateChange,
  signOut,
  verifyAdminSession,
} from './lib/auth';
import { PROTO_URLS } from './lib/protoUrls';
import QueryProvider from './components/QueryProvider';
import AdminLoginPage from './components/AdminLoginPage';
import AdminResetPasswordPage from './components/AdminResetPasswordPage';

const AdminPage = lazyRetry(() => import('./pages/AdminPage'));
const FulfillmentPage = lazyRetry(() => import('./pages/FulfillmentPage'));

installAuthFetch();

const loadingFallback = (
  <div className="adm-login-page">
    <div className="adm-login-layout">
      <div className="adm-login-card adm-login-card--loading">Loading dashboard…</div>
    </div>
  </div>
);

function recordStartupFailure(stage, error) {
  const detail = {
    stage,
    code: error?.code || error?.name || 'unknown',
    at: new Date().toISOString(),
  };
  console.error('[admin-startup]', detail);
  try { sessionStorage.setItem('proto_admin_last_startup_failure', JSON.stringify(detail)); } catch { /* ignore */ }
}

export default function Root() {
  // Clear the one-shot chunk-reload guard only AFTER a successful mount, so a
  // stale-chunk reload that fixed things isn't undone before the app renders
  // (and a failed initial load can't spin in a reload loop).
  useEffect(() => { clearChunkReloadGuard(); }, []);

  const path = window.location.pathname;
  const isFulfillment = path === '/fulfillment' || path === '/f' || path.startsWith('/f/');
  const isResetPassword = path === '/reset-password';

  // A signed fulfilment link IS the credential — the packing team opens it on
  // a phone with no admin account, so it must not meet the login screen. The
  // token is verified server-side on every API call it makes.
  if (isFulfillment && hasFulfillmentToken()) {
    return (
      <QueryProvider>
        <Suspense fallback={loadingFallback}>
          <FulfillmentPage linkMode />
        </Suspense>
      </QueryProvider>
    );
  }

  if (isFulfillment) return <AdminGate fulfillment />;

  if (isResetPassword) {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    return (
      <AdminResetPasswordPage
        token={token}
        onDone={() => { window.location.replace('/'); }}
      />
    );
  }

  return <AdminGate />;
}

function AdminGate({ fulfillment = false }) {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [startupError, setStartupError] = useState(null);
  const [startupAttempt, setStartupAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;

    async function resolveSession() {
      try {
        const verified = await getVerifiedSession();
        if (!verified?.access_token) {
          if (mounted) {
            setSession(null);
            setBooting(false);
          }
          return;
        }
        const ok = await verifyAdminSession();
        if (!ok) {
          if (mounted) {
            setSession(null);
            setBooting(false);
          }
          void signOut().catch(() => {});
          return;
        }
        if (mounted) {
          setSession(verified);
          
          setBooting(false);
        }
      } catch (error) {
        if (mounted) {
          recordStartupFailure('initial-session-check', error);
          setStartupError('The admin session check took too long or could not connect.');
          setBooting(false);
        }
      }
    }

    void resolveSession();

    const handleAuthChange = async (s) => {
      if (!mounted) return;
      if (!s?.access_token) {
        setSession(null);
        return;
      }
      const email = s.user?.email || '';
      if (!isAllowedAdminEmail(email)) {
        await signOut();
        setSession(null);
        return;
      }
      try {
        const ok = await verifyAdminSession();
        if (!ok) {
          setSession(null);
          setBooting(false);
          void signOut().catch(() => {});
          return;
        }
        setSession(s);
        setStartupError(null);
      } catch (error) {
        if (mounted) {
          recordStartupFailure('auth-change-check', error);
          setStartupError('The admin session check took too long or could not connect.');
          setBooting(false);
        }
      }
    };
    // Supabase advises against awaiting further auth calls inside its auth
    // callback. Queue the work so the callback can return immediately.
    const { data: { subscription } } = onAuthStateChange((s) => {
      setTimeout(() => { void handleAuthChange(s); }, 0);
    });

    const onUnauthorized = () => { void signOut().then(() => setSession(null)); };
    // 403 means the server rejected this user's email — sign out so they can re-auth with a valid account
    const onForbidden = () => {
      void getVerifiedSession().then((s) => {
        if (!s || !isAllowedAdminEmail(s.user?.email || '')) {
          void signOut().then(() => setSession(null));
        }
      });
    };
    window.addEventListener('proto-admin-unauthorized', onUnauthorized);
    window.addEventListener('proto-admin-forbidden', onForbidden);
    return () => {
      mounted = false;
      subscription.unsubscribe();
      window.removeEventListener('proto-admin-unauthorized', onUnauthorized);
      window.removeEventListener('proto-admin-forbidden', onForbidden);
    };
  }, [startupAttempt]);

  if (booting) return loadingFallback;

  if (startupError) {
    return (
      <div className="adm-login-page">
        <div className="adm-login-layout">
          <div className="adm-login-card adm-startup-error" role="alert">
            <div className="adm-login-brand">
              <div className="adm-login-logo">P</div>
              <h1>Dashboard didn’t load</h1>
              <p>{startupError}</p>
            </div>
            <p className="adm-startup-error__help">
              Your work is safe. Check the connection and try again.
            </p>
            <div className="adm-startup-error__actions">
              <button
                type="button"
                className="adm-btn-red adm-login-submit"
                onClick={() => {
                  setStartupError(null);
                  setBooting(true);
                  setStartupAttempt((attempt) => attempt + 1);
                }}
              >
                Retry
              </button>
              <button
                type="button"
                className="adm-login-link"
                onClick={() => {
                  setSession(null);
                  setStartupError(null);
                  void signOut().catch(() => {});
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const email = session?.user?.email || '';
  const allowed = session && isAllowedAdminEmail(email);

  if (!allowed) {
    return (
      <AdminLoginPage
        forbidden={!!session && !isAllowedAdminEmail(email)}
        onSignedIn={() => {
          void (async () => {
            try {
              const s = await getVerifiedSession();
              if (!s) {
                setSession(null);
                return;
              }
              const ok = await verifyAdminSession();
              if (!ok) {
                setSession(null);
                void signOut().catch(() => {});
                return;
              }
              setSession(s);
            } catch (error) {
              recordStartupFailure('sign-in-check', error);
              setStartupError('The admin session check took too long or could not connect.');
            }
          })();
        }}
      />
    );
  }

  const customer = {
    id: session.user.id,
    name: session.user.user_metadata?.name || email.split('@')[0],
    email,
    role: getAdminRole(email),
  };

  return (
    <QueryProvider>
      <Suspense fallback={loadingFallback}>
        {fulfillment ? (
          <FulfillmentPage />
        ) : (
          <AdminPage
            customer={customer}
            onSignOut={() => void signOut().then(() => setSession(null))}
            onViewPortal={() => { window.location.href = PROTO_URLS.site; }}
          />
        )}
      </Suspense>
    </QueryProvider>
  );
}
