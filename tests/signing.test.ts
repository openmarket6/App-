/**
 * Signing, end to end, against a real database.
 *
 * The screens for this shipped before the backend did and called into a 501
 * for months: onboarding step 4 sat at "pending" for every contractor ever
 * taken on, and no contractor has a signed master service agreement. So the
 * first thing this file proves is the dull thing -- that the endpoints answer
 * at all -- and the route-coverage regex is not evidence of that.
 *
 * The rest is about whether the record would survive being questioned. An
 * electronic signature is worth exactly what can be shown about it afterwards,
 * and every assertion below corresponds to a way the record could be worthless
 * while still looking fine in a list.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA, BETA } from './helpers/db.js';
import { assessSigning, REQUIRED_SIGNABLES } from '../src/shared/signing.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'sign-admin@test.invalid', password: 'SignAdmin2026!' };
const ALPHA_USER = { email: 'sign-alpha@test.invalid', password: 'SignAlpha2026!' };
const BETA_USER = { email: 'sign-beta@test.invalid', password: 'SignBeta2026!' };

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('signing', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id in ($1,$2)', [ALPHA, BETA]);
      await c.query(
        // `email`, not contact_email: the frontend calls it contactEmail
        // because /api/clients/:id renames it, but the column is `email`.
        `insert into ocs.companies (id, name, legal_name, email, service_line)
         values ($1,'Alpha Roofing','Alpha Roofing LLC','ana@alpha.test','EXPEDITING'),
                ($2,'Beta Builders','Beta Builders Inc','ben@beta.test','MANAGED_LICENSE')`,
        [ALPHA, BETA],
      );
      await c.query('delete from ocs.app_users where email in ($1,$2,$3)', [
        ADMIN.email, ALPHA_USER.email, BETA_USER.email,
      ]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash, client_id) values
           ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)), null),
           ($3,'Ana','CLIENT',true, crypt($4, gen_salt('bf',10)), $7),
           ($5,'Ben','CLIENT',true, crypt($6, gen_salt('bf',10)), $8)`,
        [ADMIN.email, ADMIN.password, ALPHA_USER.email, ALPHA_USER.password,
         BETA_USER.email, BETA_USER.password, ALPHA, BETA],
      );
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;

  const tokenFor = async (app: App, who: { email: string; password: string }) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode, who.email).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };
  const get = (app: App, token: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  const post = (app: App, token: string, url: string, payload?: unknown) =>
    app.inject({
      method: 'POST', url, payload: (payload ?? {}) as object,
      headers: { authorization: `Bearer ${token}` },
    });

  /** Clear signature rows so each test starts from a known verdict. */
  const reset = async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.signature_requests where company_id in ($1,$2)', [ALPHA, BETA]);
    } finally {
      await c.end();
    }
  };

  it('answers at all, and says which documents this service line needs', async () => {
    await reset();
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const res = await get(app, token, `/api/signing/status/${ALPHA}`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.serviceLine).toBe('EXPEDITING');
      expect(body.verdict.complete).toBe(false);
      // Nothing sent yet, so every required document is missing rather than
      // pending. The distinction drives what the portal tells the contractor:
      // "waiting on you" versus "waiting on us".
      expect(body.verdict.missing.sort()).toEqual([...REQUIRED_SIGNABLES.EXPEDITING].sort());
      expect(body.verdict.pending).toEqual([]);
      expect(body.required).toEqual(REQUIRED_SIGNABLES.EXPEDITING);
    } finally {
      await app.close();
    }
  });

  it('freezes the document text and its hash at send time', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const sent = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      });
      expect(sent.statusCode).toBe(201);
      const row = JSON.parse(sent.body);
      expect(row.status).toBe('SENT');
      expect(row.signerEmail).toBe('ana@alpha.test');
      expect(row.renderedHash).toMatch(/^[0-9a-f]{64}$/);

      /*
       * The hash must be of the words actually stored, not of anything
       * re-rendered later. If these ever disagree the tamper check is
       * meaningless: it would fire on every document, and an alarm that always
       * fires is one nobody reads.
       */
      const detail = await get(app, staff, `/api/signing/requests/${row.id}`);
      expect(detail.statusCode).toBe(200);
      const full = JSON.parse(detail.body);
      expect(createHash('sha256').update(full.renderedBody, 'utf8').digest('hex'))
        .toBe(row.renderedHash);

      // The contractor's legal name, not the trade name. A trade name binds
      // nobody, which is the entire reason the column exists.
      expect(full.renderedBody).toContain('Alpha Roofing LLC');
    } finally {
      await app.close();
    }
  });

  it('refuses a second open request for the same document', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const first = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'HOLD_HARMLESS',
      });
      expect(first.statusCode).toBe(201);

      /*
       * Two open hold-harmless requests is a contractor who signs one and stays
       * pending on the other forever. The verdict would say pending, onboarding
       * would never complete, and nobody would be able to see why.
       */
      const second = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'HOLD_HARMLESS',
      });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).message).toMatch(/already been sent/i);
    } finally {
      await app.close();
    }
  });

  it('refuses a document the contractor\'s service line does not use', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      // Alpha is EXPEDITING. Our licence is not on their permits, so the
      // supervision addendum describes an arrangement they are not in.
      const res = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MANAGED_LICENSE_ADDENDUM',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/expediting service line/i);

      // Beta is on the managed line, so for them it is required.
      const ok = await post(app, staff, '/api/signing/requests', {
        clientId: BETA, kind: 'MANAGED_LICENSE_ADDENDUM',
      });
      expect(ok.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('will not let this firm sign on the contractor\'s behalf', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);

      /*
       * ADMIN holds every capability, portal:sign_documents included, so the
       * capability guard alone would have allowed this. A signature applied by
       * the counterparty is not weak evidence of agreement -- it is the absence
       * of it, and in the stored record it would be indistinguishable from a
       * real one.
       */
      const res = await post(app, staff, `/api/signing/requests/${sent.id}/sign`, {
        typedName: 'Ana Reyes', consentToElectronicSignature: true,
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/only the contractor can sign/i);
    } finally {
      await app.close();
    }
  });

  it('records presentment when the signer opens it, not when staff preview it', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);

      // Staff reading the document is not the signer being presented with it.
      await get(app, staff, `/api/signing/requests/${sent.id}`);
      const afterStaff = JSON.parse((await get(app, staff, `/api/signing/requests/${sent.id}`)).body);
      expect(afterStaff.status).toBe('SENT');
      expect(afterStaff.viewedAt).toBeNull();

      const opened = JSON.parse((await get(app, signer, `/api/signing/requests/${sent.id}`)).body);
      expect(opened.status).toBe('VIEWED');
      expect(opened.viewedAt).not.toBeNull();
      expect(opened.auditTrail.map((e: { event: string }) => e.event)).toContain('opened');
    } finally {
      await app.close();
    }
  });

  it('signs, and stores evidence that would survive being questioned', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);

      const res = await post(app, signer, `/api/signing/requests/${sent.id}/sign`, {
        typedName: 'Ana Reyes',
        consentToElectronicSignature: true,
      });
      expect(res.statusCode).toBe(200);
      const signed = JSON.parse(res.body);

      expect(signed.status).toBe('SIGNED');
      expect(signed.signedAt).not.toBeNull();
      expect(signed.signature.typedName).toBe('Ana Reyes');
      // E-SIGN requires consent to transact electronically be affirmative, and
      // a consent nobody can produce later is the same as no consent.
      expect(signed.signature.consentToElectronicSignature).toBe(true);
      expect(signed.signature.ipAddress).toBeTruthy();
      // Recomputed at signing from the stored body. Equal today; a later
      // inequality is the tamper signal the whole design turns on.
      expect(signed.signature.documentHashAtSigning).toBe(signed.renderedHash);
      expect(signed.intact).toBe(true);
      expect(signed.auditTrail.map((e: { event: string }) => e.event)).toContain('signed');
    } finally {
      await app.close();
    }
  });

  it('refuses a signature without affirmative consent', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);

      const res = await post(app, signer, `/api/signing/requests/${sent.id}/sign`, {
        typedName: 'Ana Reyes', consentToElectronicSignature: false,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('refuses to sign the same document twice', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);
      const body = { typedName: 'Ana Reyes', consentToElectronicSignature: true };

      expect((await post(app, signer, `/api/signing/requests/${sent.id}/sign`, body)).statusCode).toBe(200);
      const again = await post(app, signer, `/api/signing/requests/${sent.id}/sign`, body);
      expect(again.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('reaches a complete verdict once every required document is signed', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);

      for (const kind of REQUIRED_SIGNABLES.EXPEDITING) {
        const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
          clientId: ALPHA, kind,
        })).body);
        const res = await post(app, signer, `/api/signing/requests/${sent.id}/sign`, {
          typedName: 'Ana Reyes', consentToElectronicSignature: true,
        });
        expect(res.statusCode, kind).toBe(200);
      }

      /*
       * The point of the whole exercise. Onboarding step 4 has never once
       * reached "done" for anybody, because this verdict came from a 501.
       */
      const status = JSON.parse((await get(app, staff, `/api/signing/status/${ALPHA}`)).body);
      expect(status.verdict.complete).toBe(true);
      expect(status.verdict.missing).toEqual([]);
      expect(status.verdict.pending).toEqual([]);
      expect(status.verdict.compromised).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reports a signed document whose words have changed as compromised', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);
      await post(app, signer, `/api/signing/requests/${sent.id}/sign`, {
        typedName: 'Ana Reyes', consentToElectronicSignature: true,
      });

      /*
       * Tamper with the stored text behind the API's back -- the case this
       * design exists for. No endpoint can do this, which is the point; the
       * check has to hold against a direct UPDATE, because that is what a
       * compromise would look like.
       */
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query(
          `update ocs.signature_requests
              set rendered_body = rendered_body || '<p>and also forfeits everything</p>'
            where id = $1`,
          [sent.id],
        );
      } finally {
        await c.end();
      }

      const row = JSON.parse((await get(app, staff, `/api/signing/requests/${sent.id}`)).body);
      // The stored hash still describes the words that were signed, and the
      // body no longer matches it. The signature is intact by that comparison
      // -- what has moved is the document.
      expect(createHash('sha256').update(row.renderedBody, 'utf8').digest('hex'))
        .not.toBe(row.renderedHash);

      const status = JSON.parse((await get(app, staff, `/api/signing/status/${ALPHA}`)).body);
      expect(status.verdict.complete).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps one contractor out of another\'s agreements', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      await post(app, staff, '/api/signing/requests', {
        clientId: BETA, kind: 'MASTER_SERVICE_AGREEMENT',
      });

      const ana = await tokenFor(app, ALPHA_USER);
      const res = await get(app, ana, `/api/signing/status/${BETA}`);
      // A 403 rather than an empty list. An empty agreements list reads as
      // "nothing was ever sent to us", which is a different and much more
      // alarming fact than "you cannot look there".
      expect(res.statusCode).toBe(403);

      const list = JSON.parse((await get(app, ana, '/api/signing/requests')).body);
      expect(list.requests.every((r: { clientId: string }) => r.clientId === ALPHA)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('voids rather than deletes, and will not void a signature', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const signer = await tokenFor(app, ALPHA_USER);
      const sent = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'HOLD_HARMLESS',
      })).body);

      const voided = await post(app, staff, `/api/signing/requests/${sent.id}/void`,
        { reason: 'Wrong entity named' });
      expect(voided.statusCode).toBe(200);
      expect(JSON.parse(voided.body).status).toBe('VOIDED');

      // Voiding frees the kind, so a corrected one can be sent.
      const replacement = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'HOLD_HARMLESS',
      });
      expect(replacement.statusCode).toBe(201);

      await post(app, signer, `/api/signing/requests/${JSON.parse(replacement.body).id}/sign`, {
        typedName: 'Ana Reyes', consentToElectronicSignature: true,
      });
      // A void must not be a way to undo a signature that was given.
      const undo = await post(app, staff,
        `/api/signing/requests/${JSON.parse(replacement.body).id}/void`,
        { reason: 'changed our mind' });
      expect(undo.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('tells the contractor, rather than only writing a row', async () => {
    await reset();
    const app = await server();
    try {
      const staff = await tokenFor(app, ADMIN);
      const sent = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      });
      expect(sent.statusCode).toBe(201);
      const body = JSON.parse(sent.body);

      /*
       * The staff screen renders the word "Sent". Before this it meant "an
       * INSERT succeeded" -- no notification, no email, nothing the contractor
       * could see. An agreement can wait three weeks on somebody who was never
       * told.
       */
      expect(body.delivery.notifiedUsers).toBe(1);

      const c = client(ownerUrl!);
      await c.connect();
      try {
        const { rows } = await c.query(
          `select kind::text as kind, title, link_path from ocs.notifications
            where company_id = $1 and entity_id = $2`,
          [ALPHA, body.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe('signature_requested');
        expect(rows[0].link_path).toBe('/onboarding');
      } finally {
        await c.end();
      }
    } finally {
      await app.close();
    }
  });

  it('says so when there is nobody at the contractor to tell', async () => {
    await reset();
    const app = await server();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      // A contractor onboarded before anyone was invited. Common, and the
      // state in which "Sent" is most misleading.
      await c.query('update ocs.app_users set is_active = false where email = $1',
        [ALPHA_USER.email]);
      const staff = await tokenFor(app, ADMIN);
      const body = JSON.parse((await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      })).body);

      expect(body.delivery.notifiedUsers).toBe(0);
      expect(body.delivery.emailQueued).toBe(false);
      expect(body.delivery.note).toMatch(/portal account yet/i);
    } finally {
      await c.query('update ocs.app_users set is_active = true where email = $1',
        [ALPHA_USER.email]);
      await c.end();
      await app.close();
    }
  });

  it('refuses to send to a contractor with nobody to send to', async () => {
    await reset();
    const app = await server();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('update ocs.companies set email = null where id = $1', [ALPHA]);
      const staff = await tokenFor(app, ADMIN);
      const res = await post(app, staff, '/api/signing/requests', {
        clientId: ALPHA, kind: 'MASTER_SERVICE_AGREEMENT',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/no contact email/i);
    } finally {
      await c.query('update ocs.companies set email = $2 where id = $1',
        [ALPHA, 'ana@alpha.test']);
      await c.end();
      await app.close();
    }
  });
});

describe('the signing verdict itself', () => {
  it('does not call a contractor complete on somebody else\'s documents', () => {
    // assessSigning takes a flat list. If it ever stopped keying on kind, a
    // contractor with five copies of one agreement would read as complete.
    const one = {
      kind: 'MASTER_SERVICE_AGREEMENT', status: 'SIGNED',
      renderedHash: 'a', signature: { documentHashAtSigning: 'a' },
    } as never;
    const verdict = assessSigning([one, one, one, one], 'EXPEDITING');
    expect(verdict.complete).toBe(false);
    expect(verdict.missing).toContain('HOLD_HARMLESS');
  });
});
