import { useMemo, useState } from 'react';
import { Loader2, Lock, LogIn, Mail } from 'lucide-react';
import { signIn, requestPasswordReset } from '../lib/auth';
import { getDailyQuote } from '../lib/dailyQuote';

export default function AdminLoginPage({ forbidden = false, onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('login');
  const [info, setInfo] = useState('');
  const [error, setError] = useState(forbidden ? 'This account is not authorized for the admin dashboard.' : '');
  const quote = useMemo(() => getDailyQuote(), []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setInfo('');
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email);
        setInfo('Check your inbox for a reset link from Proto Admin (sent via online@proto.co.za).');
        return;
      }
      await signIn(email, password);
      onSignedIn?.();
    } catch (err) {
      setError(err.message || (mode === 'forgot' ? 'Reset request failed' : 'Sign in failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-login-page">
      <div className="adm-login-layout">
        <blockquote className="adm-login-quote" aria-label="Daily quote">
          <p className="adm-login-quote-text">&ldquo;{quote.text}&rdquo;</p>
          <footer className="adm-login-quote-author">&mdash; {quote.author}</footer>
        </blockquote>

        <div className="adm-login-card">
          <div className="adm-login-brand">
            <div className="adm-login-logo">P</div>
            <h1>Proto Admin</h1>
            <p>{mode === 'forgot' ? 'Reset your password' : 'Sign in with your authorized account'}</p>
          </div>

          {error && <div className="adm-login-error" role="alert">{error}</div>}
          {info && <div className="adm-login-info" role="status">{info}</div>}

          <form className="adm-login-form" onSubmit={(e) => void handleSubmit(e)}>
            <label className="adm-field">
              <span className="adm-field-label">Email</span>
              <input
                type="email"
                className="adm-field-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                required
                disabled={busy}
                placeholder="you@proto.co.za"
              />
            </label>
            {mode !== 'forgot' && (
              <label className="adm-field">
                <span className="adm-field-label">Password</span>
                <input
                  type="password"
                  className="adm-field-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  disabled={busy}
                />
              </label>
            )}
            <button type="submit" className="adm-btn-red adm-login-submit" disabled={busy} aria-busy={busy}>
              {busy ? <Loader2 size={16} className="spin" /> : mode === 'forgot' ? <Mail size={16} /> : <LogIn size={16} />}
              {busy ? (mode === 'forgot' ? 'Sending…' : 'Signing in…') : mode === 'forgot' ? 'Send reset link' : 'Sign in'}
            </button>
          </form>

          <p className="adm-login-foot">
            {mode === 'forgot' ? (
              <button type="button" className="adm-login-link" onClick={() => { setMode('login'); setError(''); setInfo(''); }}>
                Back to sign in
              </button>
            ) : (
              <>
                <button type="button" className="adm-login-link" onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}>
                  Forgot password?
                </button>
                <span> · </span>
                <Lock size={12} /> Access restricted to Proto team accounts
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
