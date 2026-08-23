/**
 * Nothing should answer 500.
 *
 * A 500 is the server saying it did not consider this. It tells the caller
 * nothing about what was wrong, it cannot be acted on, and — the part that
 * matters here — it usually means an exception escaped from somewhere that was
 * assuming its input had already been checked. That assumption is exactly what
 * this codebase has been wrong about repeatedly: a Postgres enum rejecting a
 * value, a trigger raising, a null where a row was assumed.
 *
 * So every mutating endpoint the frontend calls gets three shapes of nonsense:
 * nothing at all, the wrong types, and a well-formed body pointing at an id
 * that does not exist. Any 4xx is a pass — refusing badly-formed input is the
 * job. 500 is the finding.
 *
 * The ids are real UUIDs that own no row, which is deliberate: a malformed
 * uuid is caught by Zod before any handler runs and proves only that Zod
 * works. A valid uuid with nothing behind it reaches the handler, which is
 * where the assumption lives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'err-admin@test.invalid', password: 'ErrAdmin2026!' };
/** A syntactically perfect uuid that owns nothing. */
const NOWHERE = '00000000-0000-4000-8000-000000000000';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

/** The endpoints the application actually posts to. */
const TARGETS: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
  { method: 'POST', url: '/api/permits' },
  { method: 'PATCH', url: `/api/permits/${NOWHERE}` },
  { method: 'POST', url: `/api/permits/${NOWHERE}/status` },
  { method: 'POST', url: `/api/permits/${NOWHERE}/advance` },
  { method: 'POST', url: '/api/projects' },
  { method: 'POST', url: '/api/clients' },
  { method: 'PATCH', url: `/api/clients/${NOWHERE}` },
  { method: 'POST', url: '/api/compliance' },
  { method: 'POST', url: `/api/compliance/${NOWHERE}/review` },
  { method: 'POST', url: `/api/compliance/${NOWHERE}/waive` },
  { method: 'POST', url: '/api/documents/photos' },
  { method: 'POST', url: '/api/support' },
  { method: 'PATCH', url: `/api/support/${NOWHERE}` },
  { method: 'POST', url: `/api/support/${NOWHERE}/messages` },
  { method: 'POST', url: '/api/billing/invoices' },
  { method: 'POST', url: `/api/billing/invoices/${NOWHERE}/send` },
  { method: 'POST', url: '/api/corrections' },
  { method: 'PATCH', url: `/api/corrections/${NOWHERE}` },
  { method: 'POST', url: `/api/corrections/${NOWHERE}/promote` },
  { method: 'POST', url: '/api/inspections' },
  { method: 'PATCH', url: `/api/inspections/${NOWHERE}` },
  { method: 'POST', url: '/api/notary' },
  { method: 'PATCH', url: `/api/notary/${NOWHERE}` },
  { method: 'POST', url: `/api/notary/${NOWHERE}/complete` },
  { method: 'POST', url: '/api/drafting' },
  { method: 'PATCH', url: `/api/drafting/${NOWHERE}` },
  { method: 'POST', url: `/api/drafting/${NOWHERE}/quote` },
  { method: 'POST', url: `/api/drafting/${NOWHERE}/approve` },
  { method: 'POST', url: `/api/drafting/${NOWHERE}/deliver` },
  { method: 'POST', url: '/api/generated-documents' },
  { method: 'POST', url: `/api/generated-documents/${NOWHERE}/mail` },
  { method: 'POST', url: '/api/signing/requests' },
  { method: 'POST', url: `/api/signing/requests/${NOWHERE}/sign` },
  { method: 'POST', url: `/api/signing/requests/${NOWHERE}/void` },
  { method: 'POST', url: '/api/supervision/visits' },
  { method: 'PATCH', url: `/api/supervision/visits/${NOWHERE}` },
  { method: 'POST', url: `/api/supervision/visits/${NOWHERE}/check-in` },
  { method: 'POST', url: `/api/supervision/visits/${NOWHERE}/sign-off` },
  { method: 'POST', url: `/api/supervision/visits/${NOWHERE}/photos` },
  { method: 'POST', url: '/api/supervision/engagements' },
  { method: 'POST', url: '/api/supervision/licenses' },
  { method: 'POST', url: '/api/supervision/supervisors' },
  { method: 'POST', url: '/api/users/invite' },
  { method: 'PATCH', url: `/api/users/${NOWHERE}` },
  { method: 'PATCH', url: `/api/users/${NOWHERE}/role` },
  { method: 'POST', url: `/api/users/${NOWHERE}/resend-invite` },
  { method: 'POST', url: `/api/users/${NOWHERE}/reset-password` },
  { method: 'PATCH', url: `/api/jurisdictions/${NOWHERE}` },
  { method: 'POST', url: '/api/portal/permit-requests' },
  { method: 'POST', url: '/api/portal/folders' },
];

/**
 * Three ways to be wrong. Numbers where strings go and arrays where objects
 * go are the shapes that reach a query builder intact and fail deep, rather
 * than being turned away at the schema.
 */
const BODIES: Array<[string, unknown]> = [
  ['empty', {}],
  ['wrong types', {
    clientId: 12345, permitId: [], projectId: {}, status: 99, kind: false,
    name: null, reason: [], notes: { a: 1 }, cents: 'lots', quantity: 'two',
    email: 42, role: ['ADMIN'], expiresAt: 'not-a-date', id: true,
  }],
  ['plausible but pointing nowhere', {
    clientId: NOWHERE, permitId: NOWHERE, projectId: NOWHERE,
    documentId: NOWHERE, visitId: NOWHERE, engagementId: NOWHERE,
    reason: 'because', note: 'because', subject: 'x', body: 'x',
  }],
];

describeIfDb('malformed input', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(
        `insert into ocs.companies (id, name, email, status)
         values ($1,'Alpha Roofing','ana@alpha.test','active')`,
        [ALPHA],
      );
      await c.query('delete from ocs.app_users where email = $1', [ADMIN.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password],
      );
    } finally {
      await c.end();
    }
  });

  it('never makes the server fall over', async () => {
    const app = await server();
    const crashes: string[] = [];
    const seen = new Map<number, number>();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
      expect(login.statusCode).toBe(200);
      const headers = {
        authorization: `Bearer ${JSON.parse(login.body).accessToken}`,
      };

      for (const t of TARGETS) {
        for (const [label, payload] of BODIES) {
          const res = await app.inject({
            method: t.method, url: t.url, payload: payload as object, headers,
          });
          seen.set(res.statusCode, (seen.get(res.statusCode) ?? 0) + 1);
          if (res.statusCode >= 500) {
            crashes.push(
              `${t.method} ${t.url} [${label}] -> ${res.statusCode} ` +
              `${res.body.slice(0, 160).replace(/\s+/g, ' ')}`,
            );
          }
        }
      }
    } finally {
      await app.close();
    }

    /*
     * Proof the sweep reached handlers at all.
     *
     * If every URL were wrong this would be 150 404s and a clean pass that
     * established nothing — the same shape of false all-clear as a schema
     * check run against an empty database.
     */
    const notFound = seen.get(404) ?? 0;
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    expect(
      notFound / total,
      `${notFound} of ${total} requests 404'd. Statuses seen: ` +
      `${[...seen.entries()].sort().map(([k, v]) => `${k}x${v}`).join(' ')}. ` +
      'Too many means the URLs are wrong and this proves nothing.',
    ).toBeLessThan(0.5);

    expect(
      crashes,
      crashes.length
        ? 'These endpoints answered 5xx to input they should have refused. A ' +
          '500 tells the caller nothing and usually means an exception escaped ' +
          'from code assuming its input had already been checked:\n  ' +
          `${crashes.join('\n  ')}`
        : '',
    ).toEqual([]);
  }, 120_000);
});
