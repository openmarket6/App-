/**
 * API client.
 *
 * The access token lives in a module variable, never localStorage. Refresh is
 * a single in-flight promise so a burst of parallel 401s produces one refresh
 * call rather than five, and every caller waits on the same result.
 */
let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSignedOut: (() => void) | null = null;

export function setAccessToken(t: string | null): void {
  accessToken = t;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setSignOutHandler(fn: () => void): void {
  onSignedOut = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function refresh(): Promise<string | null> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return null;
        const data = await r.json();
        accessToken = data.accessToken;
        return accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic refresh-and-retry. Used by the auth calls themselves. */
  raw?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = async (token: string | null): Promise<Response> => {
    const headers = new Headers(opts.headers as HeadersInit);
    if (token) headers.set('authorization', `Bearer ${token}`);
    let body: BodyInit | undefined;
    if (opts.body instanceof FormData) {
      body = opts.body;
    } else if (opts.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.body);
    }
    return fetch(`/api${path}`, { ...opts, headers, body, credentials: 'include' });
  };

  let res = await send(accessToken);

  if (res.status === 401 && !opts.raw) {
    const t = await refresh();
    if (t) res = await send(t);
    else {
      accessToken = null;
      onSignedOut?.();
    }
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, data?.message ?? 'Request failed', data?.error ?? 'error', data?.details);
  }
  return data as T;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body });
export const patch = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T,>(p: string) => api<T>(p, { method: 'DELETE' });

/**
 * Binary GET, for stored document bytes.
 *
 * `api` parses JSON, which a plan set or a job photo is not, so this is the
 * same request path with the body left alone. It exists so no page has to
 * reach for `fetch` itself: `<img src="/api/documents/…/content">` arrives
 * without the bearer token and 401s, and putting the token in the URL would
 * write it into browser history, referrers and server logs.
 *
 * Returns an object URL. The caller owns it and must `URL.revokeObjectURL`.
 */
export async function getBlobUrl(path: string): Promise<string> {
  const send = (token: string | null): Promise<Response> => {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetch(`/api${path}`, { headers, credentials: 'include' });
  };

  let res = await send(accessToken);
  if (res.status === 401) {
    const t = await refresh();
    if (t) res = await send(t);
    else {
      accessToken = null;
      onSignedOut?.();
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let data: { message?: string; error?: string; details?: unknown } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    throw new ApiError(res.status, data?.message ?? 'Could not load that file', data?.error ?? 'error', data?.details);
  }

  return URL.createObjectURL(await res.blob());
}
