import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth.tsx';
import { ApiError } from '../lib/api.ts';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between bg-navy text-white p-12">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded bg-white/10 grid place-items-center text-sm font-bold tracking-wide">1CS</div>
          <div>
            <div className="font-semibold leading-tight">1 Contractor Solutions</div>
          </div>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-snug">Permits, compliance and supervision in one record.</h1>
          <p className="mt-4 text-white/70 text-sm leading-relaxed">
            Every filing, correction and site visit lands in the same schema whether it arrived through an agency API,
            a portal, or a coordinator at a counter.
          </p>
        </div>
        <p className="text-xs text-white/40">Private system. Access is by invitation only.</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="h-10 w-10 rounded bg-navy grid place-items-center text-white text-sm font-bold">1CS</div>
            <div className="font-semibold">1 Contractor Solutions</div>
          </div>

          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="mt-1 text-sm text-ink-soft">Staff and contractor accounts use the same door.</p>

          {error && (
            <div className="mt-5 rounded-md bg-danger-soft border border-danger/20 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-6 space-y-4">
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
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                className="input mt-1.5"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button type="submit" disabled={busy} className="btn-primary w-full mt-6">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="mt-6 text-xs text-ink-mute leading-relaxed">
            There is no self-service sign-up. If you are a contractor and need access, ask your coordinator to send an
            invitation.
          </p>
        </form>
      </div>
    </div>
  );
}
