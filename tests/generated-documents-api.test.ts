/**
 * The generated-documents endpoints, and the database rules under them.
 *
 * Two separate concerns, tested together on purpose. The route layer decides
 * who may produce an instrument and refuses defective ones; the database
 * decides what a stored instrument is allowed to claim about itself. Neither
 * one is enough alone -- a route can be bypassed by the next route somebody
 * writes, and a constraint cannot tell a permit tech why they were refused.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA, BETA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'gd-admin@test.invalid', password: 'GenDocAdmin2026!' };
const TECH = { email: 'gd-tech@test.invalid', password: 'GenDocTech2026!' };
const VIEWER = { email: 'gd-viewer@test.invalid', password: 'GenDocViewer2026!' };

const NOC_INPUT = {
  propertyAddress: '1200 Bay Street, Tampa, FL 33606',
  legalDescription: 'Lot 4, Block 7, HYDE PARK ADDITION, Plat Book 12, Page 44',
  parcelId: 'A-12-29-18-3RM-000007-00004.0',
  improvementDescription: 'Replacement of existing shingle roof, 34 squares',
  ownerName: 'Marta Delgado',
  ownerAddress: '1200 Bay Street, Tampa, FL 33606',
  ownerInterest: 'Fee simple',
  contractorName: 'Alpha Roofing LLC',
  contractorAddress: '88 Industrial Way, Tampa, FL 33619',
  contractorLicenseNumber: 'CCC1330000',
  designatedPersonName: 'Ana Reyes',
  designatedPersonAddress: '88 Industrial Way, Tampa, FL 33619',
  expirationDate: '2027-03-01',
  ownerSignatureName: 'Marta Delgado',
  notarizationId: 'ron://session/9f2',
};

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('generated documents', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id in ($1,$2)', [ALPHA, BETA]);
      await c.query(
        `insert into ocs.companies (id, name)
         values ($1,'Alpha Roofing LLC'), ($2,'Beta Builders Inc')`,
        [ALPHA, BETA],
      );
      await c.query('delete from ocs.app_users where email in ($1,$2,$3)', [
        ADMIN.email, TECH.email, VIEWER.email,
      ]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash) values
           ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10))),
           ($3,'Tech','PERMIT_TECH',true, crypt($4, gen_salt('bf',10))),
           ($5,'Viewer','VIEWER',true, crypt($6, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password, TECH.email, TECH.password, VIEWER.email, VIEWER.password],
      );
    } finally {
      await c.end();
    }
  });

  const tokenFor = async (
    app: Awaited<ReturnType<typeof server>>,
    who: { email: string; password: string },
  ) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode, who.email).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  const post = (
    app: Awaited<ReturnType<typeof server>>,
    token: string,
    url: string,
    payload: unknown,
  ) => app.inject({
    method: 'POST', url, payload: payload as object,
    headers: { authorization: `Bearer ${token}` },
  });

  const get = (
    app: Awaited<ReturnType<typeof server>>,
    token: string,
    url: string,
  ) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('produces a Notice of Commencement and stores what it was made from', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      const res = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT, permitId: null,
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.kind).toBe('NOC');
      expect(body.status).toBe('draft');
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);

      /*
       * The snapshot is the whole reason this table exists. If a recorded NOC
       * turns out to be defective, the question is what it was made from, and
       * a system that kept only the rendered page cannot answer it.
       */
      const detail = await get(app, token, `/api/generated-documents/${body.id}`);
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body).inputSnapshot.legalDescription)
        .toBe(NOC_INPUT.legalDescription);
    } finally {
      await app.close();
    }
  });

  it('refuses a defective one, and says which field', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      const { legalDescription: _drop, ...bad } = NOC_INPUT;
      const res = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: bad,
      });
      expect(res.statusCode).toBe(400);
      const problems = JSON.parse(res.body).details.problems as Array<{ field: string }>;
      expect(problems.map((p) => p.field)).toContain('legalDescription');
    } finally {
      await app.close();
    }
  });

  it('stops on warnings until somebody accepts them', async () => {
    /*
     * A notice served past its window may still be worth serving. That is a
     * decision, and this is the endpoint making sure somebody actually makes
     * it rather than never seeing the question.
     */
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      const late = {
        claimantName: 'Bay Area Truss Supply',
        claimantAddress: '15 Depot Rd, Plant City, FL',
        servicesOrMaterials: 'Prefabricated roof trusses',
        ownerName: 'Marta Delgado',
        ownerAddress: '1200 Bay Street, Tampa, FL',
        propertyAddress: '1200 Bay Street, Tampa, FL',
        legalDescription: 'Lot 4, Block 7, HYDE PARK ADDITION',
        firstFurnishingDate: '2020-01-01',
      };

      const stopped = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NTO', input: late,
      });
      expect(stopped.statusCode).toBe(409);
      expect(JSON.parse(stopped.body).details.warnings.length).toBeGreaterThan(0);

      const accepted = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NTO', input: late, acceptWarnings: true,
      });
      expect(accepted.statusCode).toBe(201);
      // And the accepted warning is kept with the document, not swallowed.
      expect(JSON.parse(accepted.body).warnings.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('serves the stored page rather than re-rendering it', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      const made = JSON.parse((await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      })).body);

      const html = await get(app, token, `/api/generated-documents/${made.id}/html`);
      expect(html.statusCode).toBe(200);
      expect(html.headers['content-type']).toContain('text/html');
      // A document viewer is not where you want to discover an escaping gap.
      expect(html.headers['content-security-policy']).toContain("default-src 'none'");
      expect(html.body).toContain('WARNING TO OWNER');
    } finally {
      await app.close();
    }
  });

  it('does not let a viewer produce one', async () => {
    // A viewer can read the whole system. Producing a recordable instrument is
    // a different act, and it is not theirs.
    const app = await server();
    try {
      const token = await tokenFor(app, VIEWER);
      const res = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('corrects by superseding, never by editing', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const first = JSON.parse((await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      })).body);

      const corrected = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', supersedesId: first.id,
        input: { ...NOC_INPUT, improvementDescription: 'Re-roof, 36 squares (corrected)' },
      });
      expect(corrected.statusCode).toBe(201);
      const second = JSON.parse(corrected.body);
      expect(second.supersedesId).toBe(first.id);
      expect(second.sha256).not.toBe(first.sha256);

      // The original keeps its own snapshot and hash. Nothing moved under it.
      const original = JSON.parse((await get(app, token, `/api/generated-documents/${first.id}`)).body);
      expect(original.sha256).toBe(first.sha256);
      expect(original.supersededById).toBe(second.id);
      expect(original.isCurrent).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('will not let one kind supersede another', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const noc = JSON.parse((await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      })).body);

      const res = await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'HOLD_HARMLESS', supersedesId: noc.id,
        input: {
          indemnifiedPartyName: 'OCS', indemnifyingPartyName: 'Alpha Roofing LLC',
          indemnifyingPartyAddress: '88 Industrial Way', signerName: 'Ana',
          scopeDescription: 'Re-roof', effectiveDate: '2026-03-01',
          generalLiabilityCarrier: 'Southeastern Mutual',
          generalLiabilityLimitCents: 100000000,
          signerTitle: 'Member', terminationNoticeDays: 30,
        },
        acceptWarnings: true,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('records an NOC as recorded, with the clerk reference', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      const made = JSON.parse((await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      })).body);

      const res = await post(app, token, `/api/generated-documents/${made.id}/complete`, {
        reference: '2026123456', note: 'Recorded, Hillsborough County',
      });
      expect(res.statusCode).toBe(200);
      const done = JSON.parse(res.body);
      // Recorded, not "completed". The word is the fact anyone asks for later.
      expect(done.status).toBe('recorded');
      expect(done.completionReference).toBe('2026123456');
      expect(done.completedAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('voids rather than deletes, and refuses a void with no reason', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const made = JSON.parse((await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      })).body);

      const noReason = await post(app, token, `/api/generated-documents/${made.id}/void`, {});
      expect(noReason.statusCode).toBe(400);

      const res = await post(app, token, `/api/generated-documents/${made.id}/void`, {
        reason: 'Recorded against the wrong parcel',
      });
      expect(res.statusCode).toBe(200);
      const voided = JSON.parse(res.body);
      expect(voided.status).toBe('void');
      expect(voided.voidReason).toBe('Recorded against the wrong parcel');

      // Still there. A withdrawn notice is a fact about a job.
      const still = await get(app, token, `/api/generated-documents/${made.id}`);
      expect(still.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('will not complete a voided document', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const made = JSON.parse((await post(app, token, '/api/generated-documents', {
        clientId: ALPHA, kind: 'NOC', input: NOC_INPUT,
      })).body);
      await post(app, token, `/api/generated-documents/${made.id}/void`, { reason: 'Wrong parcel' });

      const res = await post(app, token, `/api/generated-documents/${made.id}/complete`, {
        reference: '2026999999',
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('does not show one tenant another tenant’s instruments', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      await post(app, token, '/api/generated-documents', {
        clientId: BETA, kind: 'NOC',
        input: { ...NOC_INPUT, ownerName: 'Beta Owner' },
      });

      const alpha = JSON.parse((await get(
        app, token, `/api/generated-documents?clientId=${ALPHA}`,
      )).body);
      const owners = alpha.documents.map((d: { clientId: string }) => d.clientId);
      expect(owners.every((c: string) => c === ALPHA)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('validates without producing anything', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      const before = JSON.parse((await get(
        app, token, `/api/generated-documents?clientId=${ALPHA}`,
      )).body).total;

      const res = await post(app, token, '/api/generated-documents/validate', {
        kind: 'NOC', input: { propertyAddress: '1200 Bay Street' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(false);

      const after = JSON.parse((await get(
        app, token, `/api/generated-documents?clientId=${ALPHA}`,
      )).body).total;
      expect(after).toBe(before);
    } finally {
      await app.close();
    }
  });

  // ---------------------------------------------------------------------------
  // The database's own rules, tested where they live.
  // ---------------------------------------------------------------------------

  const rawInsert = async (extra: string, params: unknown[]) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      return await c.query(
        `insert into ocs.generated_documents
           (company_id, kind, title, input_snapshot, rendered_html, content_sha256${extra}`,
        params,
      );
    } finally {
      await c.end();
    }
  };

  it('refuses a status the kind cannot reach', async () => {
    // An agreement is never "recorded"; a Notice of Commencement is never
    // "served" -- it is recorded and posted. A report built on the other
    // assumption would be quietly wrong.
    await expect(rawInsert(
      `, status, completed_at)
       values ($1, 'CONTRACTOR_AGREEMENT', 'x', '{}'::jsonb, 'x', repeat('a',64),
               'recorded', now())`,
      [ALPHA],
    )).rejects.toThrow(/status_fits_kind/);
  });

  it('refuses a terminal status with no date', async () => {
    await expect(rawInsert(
      `, status)
       values ($1, 'NOC', 'x', '{}'::jsonb, 'x', repeat('a',64), 'recorded')`,
      [ALPHA],
    )).rejects.toThrow(/completion_has_a_date/);
  });

  it('refuses a void with no reason', async () => {
    await expect(rawInsert(
      `, status, voided_at)
       values ($1, 'NOC', 'x', '{}'::jsonb, 'x', repeat('a',64), 'void', now())`,
      [ALPHA],
    )).rejects.toThrow(/void_has_a_reason/);
  });

  it('refuses a hash that is not a sha256', async () => {
    await expect(rawInsert(
      `) values ($1, 'NOC', 'x', '{}'::jsonb, 'x', 'not-a-hash')`,
      [ALPHA],
    )).rejects.toThrow(/content_sha256/);
  });
});
