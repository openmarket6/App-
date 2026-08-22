import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { errorMessage } from '../components/ErrorState.tsx';

/**
 * The only route reachable without a session other than sign-in. It exchanges
 * an invitation token for a password the invitee chooses themselves — nobody,
 * including whoever sent the invite, ever knows their password.
 */
export default function AcceptInvite() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && password !== confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Those two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/accept-invite', { method: 'POST', body: { token, password }, raw: true });
      // Full reload so the auth provider picks up the fresh session cleanly.
      window.location.replace('/dashboard');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <form onSubmit={onSubmit} className="card card-pad w-full max-w-sm">
        <div className="flex items-center gap-3">
          <img src="/brand/1cs-mark.png" alt="" aria-hidden className="h-8 w-auto shrink-0" />
          <div className="font-semibold">1 Contractor Solutions</div>
        </div>

        <h1 className="mt-6 text-lg font-semibold">Choose your password</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {token ? 'Set a password and you are in.' : 'This link is missing its invitation token.'}
        </p>

        {error && (
          <div className="mt-4 rounded-md bg-danger-soft border border-danger/20 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="mt-5 space-y-4">
          <div>
            <label className="label" htmlFor="pw">New password</label>
            <input
              id="pw"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              className="input mt-1.5"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className={`mt-1 text-[11px] ${tooShort ? 'text-danger' : 'text-ink-mute'}`}>
              At least 12 characters. Length beats punctuation — three unrelated words works well.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="pw2">Confirm password</label>
            <input
              id="pw2"
              type="password"
              autoComplete="new-password"
              required
              className="input mt-1.5"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch && <p className="mt-1 text-[11px] text-danger">These do not match yet.</p>}
          </div>
        </div>

        <button type="submit" disabled={busy || !token || tooShort || mismatch} className="btn-primary w-full mt-6">
          {busy ? 'Setting up…' : 'Set password and sign in'}
        </button>
      </form>
    </div>
  );
}
