/**
 * A photograph from a job site has to fit through the door.
 *
 * The server-wide body limit is 1 MB, set with the comment "files never come
 * through here — they go direct to storage". True of some things and false of
 * three endpoints, which take the file inline as base64. Base64 is four bytes
 * for every three, so a 1 MB body caps a photograph at about 750 KB, and a
 * photo from any phone made in the last decade is 2–5 MB.
 *
 * So every field photograph was refused with "Request body is too large"
 * before the handler ran — including the handler's own, much friendlier size
 * check, which was unreachable. Supervision photographs are the evidence that
 * makes a managed licence defensible, and none of them could be uploaded.
 *
 * The sizes below are real phone photographs, not round numbers, because the
 * failure is about the ratio between a limit and a file and round numbers hide
 * exactly that.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;
const ADMIN = { email: 'upload-admin@test.invalid', password: 'UploadAdmin2026!' };

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('uploading a file', () => {
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

  type App = Awaited<ReturnType<typeof server>>;
  const headersFor = async (app: App) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${JSON.parse(res.body).accessToken}` };
  };

  const photo = (mb: number) => {
    const bytes = Buffer.alloc(Math.round(mb * 1024 * 1024), 0x41);
    return {
      clientId: ALPHA,
      fileName: 'roof.jpg',
      contentType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString('base64'),
      capturedAt: '2026-04-15T14:00:00.000Z',
    };
  };

  /*
   * 4.2 MB is a photograph from a current iPhone at default settings. If this
   * one does not fit, the feature does not exist.
   */
  it.each([1.8, 3.1, 4.2])('does not refuse a %s MB photograph at the door', async (mb) => {
    const app = await server();
    try {
      const headers = await headersFor(app);
      const res = await app.inject({
        method: 'POST', url: '/api/documents/photos', payload: photo(mb), headers,
      });

      expect(
        res.statusCode,
        `a ${mb} MB photo was rejected with ${res.statusCode}: ${res.body.slice(0, 200)}. ` +
        '413 here means the body limit is below what a phone produces, and no ' +
        'field photograph can be uploaded at all.',
      ).not.toBe(413);

      /*
       * 503 is the honest answer in this environment: there is no storage
       * bucket configured for the tests. What matters is that the request
       * reached the handler, which a 413 would mean it had not.
       */
      expect([201, 503]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('still refuses something far past any real photograph', async () => {
    const app = await server();
    try {
      const headers = await headersFor(app);
      const res = await app.inject({
        method: 'POST', url: '/api/documents/photos', payload: photo(40), headers,
      });
      // The limit moved up; it did not go away.
      expect(res.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('says what is unavailable, rather than "an unexpected error occurred"', async () => {
    /*
     * 503 messages are hand-written and name the missing piece of
     * configuration. They were all being replaced by the generic 5xx text,
     * because `expose` defaulted to statusCode < 500.
     *
     * This project has already paid for that failure mode once: a worker sat
     * dead for seventeen hours behind green health checks. A misconfigured
     * bucket on the first morning would have produced a screen of "an
     * unexpected error occurred" and an afternoon of guessing.
     */
    const app = await server();
    try {
      const headers = await headersFor(app);
      const res = await app.inject({
        method: 'POST', url: '/api/documents/photos', payload: photo(0.4), headers,
      });
      if (res.statusCode !== 503) return;   // storage configured; nothing to assert

      const body = JSON.parse(res.body);
      expect(body.message).not.toBe('An unexpected error occurred');
      expect(body.message).toMatch(/storage/i);
    } finally {
      await app.close();
    }
  }, 60_000);
});
