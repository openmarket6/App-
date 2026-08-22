/**
 * Accela Construct API client.
 *
 * Accela is the widest-reaching permitting platform in Florida, and the reason
 * this is one client rather than one per county: every agency running Accela
 * speaks the same v4 API. Only the agency name, the environment and the
 * credentials differ. One implementation, configured per jurisdiction, reaches
 * all of them.
 *
 * TWO THINGS ABOUT THIS API THAT ARE EASY TO GET WRONG
 *
 * 1. The Authorization header carries the access token RAW -- no "Bearer "
 *    prefix. Sending the prefix produces a 401 that reads exactly like bad
 *    credentials, and hours get lost to it. The scheme is configurable anyway,
 *    because agencies sit behind gateways that sometimes disagree.
 *
 * 2. Responses are enveloped: `{ status, result, page }`. The HTTP status can
 *    be 200 while `status` inside the body is an error. Reading only the HTTP
 *    status will report success for a failed call.
 *
 * NOTHING HERE HAS BEEN RUN AGAINST A LIVE FLORIDA AGENCY from this codebase.
 * That is why the jurisdiction onboarding flow requires a human to run
 * test-connection against a real permit and record what they saw before
 * automated checking can be switched on. An unverified adapter does not return
 * "no data" -- it returns confidently wrong permit statuses, and a contractor
 * who believes a permit was issued sends a crew to a site they may not work.
 */
import { requestWithRetry, excerpt, HttpError } from '../../../lib/http.js';
import { logger } from '../../../lib/logger.js';

const DEFAULT_BASE = 'https://apis.accela.com';

/**
 * Refresh this long before the token actually expires.
 *
 * A token that expires mid-flight fails the request it was fetched for. Sixty
 * seconds covers clock skew between us and Accela plus a slow round trip.
 */
const TOKEN_SKEW_SECONDS = 60;

export interface AccelaConfig {
  /** Base URL. Overridable because some agencies sit behind their own gateway. */
  baseUrl?: string;
  /** The Accela app's client id. Not a secret, but not public either. */
  clientId: string;
  clientSecret: string;
  /** Agency short name, e.g. 'CITYOFTAMPA'. Accela is case-sensitive here. */
  agency: string;
  /** 'PROD' or 'TEST'. */
  environment: string;
  /** Agency user the app acts as. */
  username: string;
  password: string;
  /** Scopes the app is entitled to. */
  scope?: string;
  /** 'token' sends the value raw (Accela's own convention); 'bearer' prefixes it. */
  authScheme?: 'token' | 'bearer';
}

interface CachedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
}

/** Accela's response envelope. */
interface Envelope<T> {
  status?: number;
  result?: T;
  page?: { hasmore?: boolean; offset?: number; limit?: number };
  // Present on failures, in more than one spelling depending on endpoint.
  message?: string;
  traceId?: string;
}

export class AccelaError extends Error {
  constructor(
    readonly kind: 'auth' | 'not_found' | 'rate_limited' | 'transport' | 'api',
    message: string,
    readonly httpStatus?: number,
    readonly bodyExcerpt?: string,
  ) {
    super(message);
    this.name = 'AccelaError';
  }
}

/**
 * One client per agency.
 *
 * The token cache lives on the instance, so callers should keep an instance
 * alive for the duration of a sync rather than constructing one per permit --
 * otherwise every permit costs an extra round trip to fetch a token that was
 * already valid.
 */
export class AccelaClient {
  private token: CachedToken | null = null;
  private inFlight: Promise<CachedToken> | null = null;

  constructor(private readonly config: AccelaConfig) {}

  private get baseUrl(): string {
    return (this.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  /** Never log or return this. */
  private authHeader(accessToken: string): string {
    return this.config.authScheme === 'bearer' ? `Bearer ${accessToken}` : accessToken;
  }

  /**
   * Fetch or reuse an access token.
   *
   * Single-flight: concurrent callers share one request rather than each
   * fetching a token and invalidating the others'. Accela rate-limits token
   * issuance, and a sync over hundreds of permits will otherwise trip it.
   */
  private async getToken(): Promise<CachedToken> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now) return this.token;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.requestToken()
      .then((t) => {
        this.token = t;
        return t;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async requestToken(): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password,
      agency_name: this.config.agency,
      environment: this.config.environment,
      scope: this.config.scope ?? 'records inspections documents',
    });

    let res;
    try {
      res = await requestWithRetry(
        `${this.baseUrl}/oauth2/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        },
        {
          // Token issuance is idempotent in effect: a repeat produces another
          // valid token and changes nothing else.
          retryUnsafeMethod: true,
          attempts: 3,
          timeoutMs: 15_000,
          label: `accela:token:${this.config.agency}`,
        },
      );
    } catch (err) {
      throw new AccelaError('transport', `Could not reach Accela: ${(err as Error).message}`);
    }

    if (!res.ok) {
      // Deliberately does not include the response body in the message: a failed
      // token response can echo the submitted username back.
      throw new AccelaError(
        res.status === 401 || res.status === 400 ? 'auth' : 'api',
        `Accela rejected the credentials for ${this.config.agency} (HTTP ${res.status})`,
        res.status,
      );
    }

    let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new AccelaError('api', 'Accela returned a token response that was not JSON');
    }

    if (!parsed.access_token) {
      throw new AccelaError('auth', 'Accela returned no access token');
    }

    const lifetime = Math.max(60, parsed.expires_in ?? 3600) - TOKEN_SKEW_SECONDS;

    logger.info(
      { agency: this.config.agency, environment: this.config.environment, lifetimeSeconds: lifetime },
      'accela token issued',
    );

    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? null,
      expiresAtMs: Date.now() + lifetime * 1000,
    };
  }

  /**
   * One authenticated call.
   *
   * A 401 clears the cached token and retries exactly once. Tokens can be
   * revoked agency-side at any moment, and without this a sync would fail every
   * remaining permit until the process restarted. Once, not in a loop: if the
   * fresh token is also refused, the credentials are wrong and retrying is just
   * a way to get the account locked.
   */
  private async call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
    isRetry = false,
  ): Promise<{ data: T; durationMs: number; httpStatus: number }> {
    const token = await this.getToken();

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      authorization: this.authHeader(token.accessToken),
      accept: 'application/json',
      'x-accela-appid': this.config.clientId,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await requestWithRetry(
        url.toString(),
        {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        },
        { attempts: method === 'GET' ? 3 : 1, timeoutMs: 25_000, label: `accela:${path}` },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        throw new AccelaError('transport', err.message, err.status, err.bodyExcerpt);
      }
      throw new AccelaError('transport', (err as Error).message);
    }

    if (res.status === 401 && !isRetry) {
      logger.warn({ agency: this.config.agency, path }, 'accela token refused; refreshing once');
      this.token = null;
      return this.call<T>(method, path, options, true);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AccelaError('auth', 'Accela refused the request', res.status, excerpt(res.body, 200));
    }
    if (res.status === 404) {
      throw new AccelaError('not_found', 'Not found in Accela', 404);
    }
    if (res.status === 429) {
      throw new AccelaError('rate_limited', 'Accela rate limit reached', 429);
    }

    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(res.body) as Envelope<T>;
    } catch {
      throw new AccelaError('api', 'Accela returned a response that was not JSON', res.status,
        excerpt(res.body, 200));
    }

    // The envelope can carry an error while the HTTP status is 200. Checking
    // only the HTTP status reports success for a failed call.
    if (!res.ok || (envelope.status !== undefined && envelope.status >= 400)) {
      throw new AccelaError(
        'api',
        envelope.message ?? `Accela returned status ${envelope.status ?? res.status}`,
        envelope.status ?? res.status,
        excerpt(res.body, 300),
      );
    }

    return {
      data: (envelope.result ?? ([] as unknown)) as T,
      durationMs: res.durationMs,
      httpStatus: res.status,
    };
  }

  // -- Reads ----------------------------------------------------------------

  /** One record by its Accela id (the `recordId`, not the permit number). */
  async getRecord(recordId: string): Promise<AccelaRecord | null> {
    const { data } = await this.call<AccelaRecord[]>(
      'GET',
      `/v4/records/${encodeURIComponent(recordId)}`,
    );
    return data[0] ?? null;
  }

  /**
   * Find a record by the number printed on the permit.
   *
   * Accela calls this `customId`. It is what a contractor reads off their
   * paperwork, and the only identifier a person can be expected to have.
   */
  async findByPermitNumber(permitNumber: string): Promise<AccelaRecord | null> {
    const { data } = await this.call<AccelaRecord[]>('GET', '/v4/records', {
      query: { customId: permitNumber, limit: 1 },
    });
    return data[0] ?? null;
  }

  /**
   * Every record the authenticated account can see, a page at a time.
   *
   * Paged rather than returned whole: an agency can hold hundreds of thousands
   * of records, and materialising them all is how a sync runs a worker out of
   * memory. Callers iterate.
   */
  async *listRecords(params: {
    openedFrom?: string;
    openedTo?: string;
    module?: string;
    pageSize?: number;
  } = {}): AsyncGenerator<AccelaRecord[], void, unknown> {
    const limit = Math.min(Math.max(params.pageSize ?? 100, 1), 1000);
    let offset = 0;

    for (;;) {
      const { data } = await this.call<AccelaRecord[]>('GET', '/v4/records', {
        query: {
          openedDateFrom: params.openedFrom,
          openedDateTo: params.openedTo,
          module: params.module,
          offset,
          limit,
        },
      });

      if (data.length === 0) return;
      yield data;

      // Stop on a short page rather than trusting `hasmore`: agencies on older
      // Accela builds do not always set it, and an infinite loop against a
      // rate-limited API is an expensive mistake.
      if (data.length < limit) return;
      offset += data.length;
    }
  }

  async getInspections(recordId: string): Promise<AccelaInspection[]> {
    const { data } = await this.call<AccelaInspection[]>(
      'GET',
      `/v4/records/${encodeURIComponent(recordId)}/inspections`,
    );
    return data;
  }

  /** Plan-review comments: the jurisdiction telling you what is wrong. */
  async getComments(recordId: string): Promise<AccelaComment[]> {
    const { data } = await this.call<AccelaComment[]>(
      'GET',
      `/v4/records/${encodeURIComponent(recordId)}/comments`,
    );
    return data;
  }

  // -- Writes ---------------------------------------------------------------
  //
  // Not retried. A repeated POST here books a second inspection or posts a
  // duplicate comment, and an apologetic phone call to a plans examiner costs
  // more than a failed request the caller can retry deliberately.

  async addComment(recordId: string, text: string): Promise<void> {
    await this.call('POST', `/v4/records/${encodeURIComponent(recordId)}/comments`, {
      body: [{ text }],
    });
  }

  async scheduleInspection(input: {
    recordId: string;
    inspectionType: string;
    scheduledDate: string;
    comment?: string;
  }): Promise<AccelaInspection | null> {
    const { data } = await this.call<AccelaInspection[]>('POST', '/v4/inspections', {
      body: [
        {
          recordId: input.recordId,
          type: { text: input.inspectionType },
          scheduledDate: input.scheduledDate,
          ...(input.comment ? { comment: input.comment } : {}),
        },
      ],
    });
    return data[0] ?? null;
  }

  /**
   * Confirms the credentials work, without changing anything.
   *
   * This is what jurisdiction onboarding calls before a human is allowed to
   * mark an adapter verified.
   */
  async testConnection(): Promise<{ ok: true; agency: string }> {
    await this.getToken();
    await this.call<unknown[]>('GET', '/v4/records', { query: { limit: 1 } });
    return { ok: true, agency: this.config.agency };
  }
}

// -- Response shapes ---------------------------------------------------------
//
// Only the fields actually used are declared. Accela records carry a great deal
// more, much of it applicant personal data, and naming a field here is a
// decision to handle it.

export interface AccelaRecord {
  id: string;
  customId?: string;
  status?: { value?: string; text?: string };
  statusDate?: string;
  type?: { value?: string; text?: string; group?: string };
  openedDate?: string;
  description?: string;
  totalFee?: number;
  balance?: number;
  address?: { streetAddress?: string; city?: string; state?: string; postalCode?: string };
}

export interface AccelaInspection {
  id?: string | number;
  type?: { text?: string; value?: string };
  status?: { text?: string; value?: string };
  scheduledDate?: string;
  completedDate?: string;
  result?: string;
  inspectorName?: string;
  comment?: string;
}

export interface AccelaComment {
  id?: string | number;
  text?: string;
  displayOnInspection?: boolean;
  recordId?: string;
  createdBy?: string;
  createdDate?: string;
}
