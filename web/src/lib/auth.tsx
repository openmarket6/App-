import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { STAFF_ROLES, type Role } from '@flph/shared';
import { api, post, setAccessToken, setSignOutHandler } from './api.ts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  clientId: string | null;
  active: boolean;
  hasPassword: boolean;
}

interface AuthValue {
  user: SessionUser | null;
  loading: boolean;
  /** True while the deployment has no accounts at all. */
  needsSetup: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  isStaff: boolean;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  // On first paint we try the refresh cookie. A returning user with a live
  // session should never see the sign-in screen flash before their dashboard.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ accessToken: string; user: SessionUser }>('/auth/refresh', {
          method: 'POST',
          raw: true,
        });
        if (!cancelled) {
          setAccessToken(data.accessToken);
          setUser(data.user);
        }
      } catch {
        if (cancelled) return;
        setUser(null);
        // No session. Find out whether that is because nobody has signed in
        // yet, or because nobody has ever claimed this deployment.
        try {
          const state = await api<{ needsSetup: boolean }>('/auth/setup-state', { raw: true });
          if (!cancelled) setNeedsSetup(!!state.needsSetup);
        } catch {
          if (!cancelled) setNeedsSetup(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSignOutHandler(() => setUser(null));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const data = await api<{ accessToken: string; user: SessionUser }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      raw: true,
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setNeedsSetup(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ accessToken: string; user: SessionUser }>('/auth/refresh', {
        method: 'POST',
        raw: true,
      });
      setAccessToken(data.accessToken);
      setUser(data.user);
      setNeedsSetup(false);
    } catch {
      setUser(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ user, loading, needsSetup, signIn, signOut, refresh, isStaff: !!user && STAFF_ROLES.includes(user.role) }),
    [user, loading, needsSetup, signIn, signOut, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
