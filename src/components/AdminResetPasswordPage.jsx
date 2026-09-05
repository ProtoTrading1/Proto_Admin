import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';

export default function AdminResetPasswordPage({ token, onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin-reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      setDone(true);
    } catch (err) {
      setError(err.message || 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-login-page">
      <div className="adm-login-layout">
        <div className="adm-login-card">
          <div className="adm-login-brand">
            <div className="adm-login-logo">P</div>
            <h1>Proto Admin</h1>
            <p>{done ? 'Password updated' : 'Set a new password'}</p>
          </div>

          {error && <div className="adm-login-error" role="alert">{error}</div>}

          {done ? (
            <button type="button" className="adm-btn-red adm-login-submit" onClick={onDone}>
              Back to sign in
            </button>
          ) : (
            <form className="adm-login-form" onSubmit={(e) => void handleSubmit(e)}>
              <label className="adm-field">
                <span className="adm-field-label">New password</span>
                <input
                  type="password"
                  className="adm-field-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={busy}
                  minLength={8}
                />
              </label>
              <label className="adm-field">
                <span className="adm-field-label">Confirm password</span>
                <input
                  type="password"
                  className="adm-field-input"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={busy}
                  minLength={8}
                />
              </label>
              <button type="submit" className="adm-btn-red adm-login-submit" disabled={busy}>
                {busy ? <Loader2 size={16} className="spin" /> : <Lock size={16} />}
                {busy ? 'Saving…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
