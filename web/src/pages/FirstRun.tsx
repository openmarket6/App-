import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { errorMessage } from '../components/ErrorState.tsx';

/**
 * Shown only while the deployment has no accounts at all. The first person
 * here becomes the administrator by choosing their own password, and this
 * screen is then unreachable forever. No credential has to travel through a
 * chat or an email to get somebody into their own system.
 */
export default function FirstRun({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = email.includes('@') && name.trim().length > 0 && password.length >= 12 && password === confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/setup', {
        method: 'POST',
        body: { email: email.trim(), name: name.trim(), password },
        raw: true,
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between bg-navy text-white p-12">
        <div className="flex items-center gap-3">
          <img src="/brand/1cs-mark-onnavy.png" alt="" aria-hidden className="h-9 w-auto shrink-0" />
          <div className="font-semibold leading-tight">1 Contractor Solutions</div>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-snug">Nobody owns this system yet.</h1>
          <p className="mt-4 text-white/70 text-sm leading-relaxed">
            The account you create here is the administrator. It can invite staff, set access levels, configure
            connectors and see everything. Once it exists, this screen is gone for good.
          </p>
        </div>
        <p className="text-xs text-white/40">Choose a password nobody else has seen — not even in a chat window.</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <img src="/brand/1cs-mark.png" alt="" aria-hidden className="h-9 w-auto shrink-0" />
            <div className="font-semibold">1 Contractor Solutions</div>
          </div>

          <h2 className="text-xl font-semibold">Create the administrator account</h2>
          <p className="mt-1 text-sm text-ink-soft">This is a one-time step.</p>

          {error && (
            <div className="mt-5 rounded-md bg-danger-soft border border-danger/20 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="name">Your name</label>
              <input id="name" required className="input mt-1.5" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                className="input mt-1.5"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="pw">Password</label>
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

          <button type="submit" disabled={busy || !valid} className="btn-primary w-full mt-6">
            {busy ? 'Creating…' : 'Create account and sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
