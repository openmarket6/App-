/**
 * Attaching a photograph to a site visit.
 *
 * This path did not exist. Nothing anywhere created a supervision_visit_photos
 * row, which meant `photo_count` stayed at zero on every visit forever, which
 * meant the sign-off rule -- a visit needs its photographs before it can be
 * signed -- could never be satisfied by anybody. A supervisor could check in
 * and never finish. The evidence this business sells could be started and not
 * completed, and nothing failed loudly enough to say so.
 *
 * The tests below pin both halves: the route refuses the wrong person and the
 * wrong moment, and the database keeps the count honest.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, client, ownerUrl, ALPHA,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const SUP = { email: 'field-sup@test.invalid', password: 'FieldSupervisor2026!' };
const OTHER = { email: 'field-other@test.invalid', password: 'OtherSupervisor2026!' };

// A 1x1 PNG. Small enough to keep in the test, real enough to be an image.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64').byteLength;

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('photographs on a site visit', () => {
  let visitId = '';
  let otherVisitId = '';

  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.app_users where email in ($1,$2)', [SUP.email, OTHER.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash) values
           ($1,'Field Sam','SITE_SUPERVISOR',true, crypt($2, gen_salt('bf',10))),
           ($3,'Other Sam','SITE_SUPERVISOR',true, crypt($4, gen_salt('bf',10)))`,
        [SUP.email, SUP.password, OTHER.email, OTHER.password],
      );
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.supervision_visit_photos');
      await c.query('delete from ocs.supervision_visits');
      await c.query("delete from ocs.supervisors where display_name like 'Field %'");
      await c.query(
        'delete from ocs.supervision_engagements where company_id = $1 and engagement_number = 9600',
        [ALPHA],
      );

      const mine = await c.query(
        `insert into ocs.supervisors (user_id, display_name, is_active)
         values ((select id from ocs.app_users where email = $1), 'Field Sam Sup', true)
         returning id`,
        [SUP.email],
      );
      const theirs = await c.query(
        `insert into ocs.supervisors (user_id, display_name, is_active)
         values ((select id from ocs.app_users where email = $1), 'Field Other Sup', true)
         returning id`,
        [OTHER.email],
      );
      const eng = await c.query(
        `insert into ocs.supervision_engagements (company_id, engagement_number, trade_id, status)
         values ($1, 9600, (select id from ocs.trades limit 1), 'accepted') returning id`,
        [ALPHA],
      );
      const v = await c.query(
        `insert into ocs.supervision_visits
           (company_id, engagement_id, milestone_code, milestone_name, sequence,
            status, supervisor_id, required_photo_count, photo_count)
         values ($1,$2,'progress','Progress',1,'in_progress',$3,3,0) returning id`,
        [ALPHA, eng.rows[0].id, mine.rows[0].id],
      );
      visitId = v.rows[0].id;

      const ov = await c.query(
        `insert into ocs.supervision_visits
           (company_id, engagement_id, milestone_code, milestone_name, sequence,
            status, supervisor_id, required_photo_count, photo_count)
         values ($1,$2,'final','Final',2,'in_progress',$3,3,0) returning id`,
        [ALPHA, eng.rows[0].id, theirs.rows[0].id],
      );
      otherVisitId = ov.rows[0].id;
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

  const photo = (over: Record<string, unknown> = {}) => ({
    fileName: 'roof-deck.png',
    contentType: 'image/png',
    sizeBytes: PNG_BYTES,
    dataBase64: PNG_B64,
    photoType: 'work_in_progress',
    takenAt: new Date().toISOString(),
    ...over,
  });

  const send = (
    app: Awaited<ReturnType<typeof server>>,
    token: string, id: string, payload: unknown,
  ) => app.inject({
    method: 'POST', url: `/api/supervision/visits/${id}/photos`,
    payload: payload as object, headers: { authorization: `Bearer ${token}` },
  });

  it('refuses a photograph on somebody else’s visit', async () => {
    /*
     * The rule the whole record rests on: a visit says who was PHYSICALLY
     * PRESENT. One supervisor photographing another's visit would make the
     * evidence worthless without making it look wrong.
     */
    const app = await server();
    try {
      const token = await tokenFor(app, SUP);
      const res = await send(app, token, otherVisitId, photo());
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/different supervisor/i);
    } finally {
      await app.close();
    }
  });

  it('refuses one that is not an image', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, SUP);
      const res = await send(app, token, visitId, photo({
        contentType: 'application/pdf', fileName: 'report.pdf',
      }));
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('refuses one that did not arrive intact', async () => {
    // A truncated photograph looks fine in a list until somebody opens it as
    // evidence, which is the worst moment to find out.
    const app = await server();
    try {
      const token = await tokenFor(app, SUP);
      const res = await send(app, token, visitId, photo({ sizeBytes: PNG_BYTES + 5000 }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/intact/i);
    } finally {
      await app.close();
    }
  });

  it('refuses one on a visit that is already signed off', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      // Satisfy the photo minimum directly so sign-off is allowed, then sign.
      await c.query(
        `update ocs.supervision_visits set required_photo_count = 0 where id = $1`,
        [visitId],
      );
      await c.query(
        `update ocs.supervision_visits
            set status = 'completed', checked_in_at = now(),
                signed_off_at = now(), findings = 'Fine'
          where id = $1`,
        [visitId],
      );
    } finally {
      await c.end();
    }

    const app = await server();
    try {
      const token = await tokenFor(app, SUP);
      const res = await send(app, token, visitId, photo());
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toMatch(/already signed off/i);
    } finally {
      await app.close();
    }
  });

  it('refuses a photo type the database does not know', async () => {
    // Validated in the route so it is a 400 with a sentence, not a 500 from
    // the enum cast.
    const app = await server();
    try {
      const token = await tokenFor(app, SUP);
      const res = await send(app, token, visitId, photo({ photoType: 'drone_footage' }));
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---------------------------------------------------------------------------
  // The count, and what it unblocks.
  // ---------------------------------------------------------------------------

  const attach = async (n: number) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      for (let i = 0; i < n; i += 1) {
        const doc = await c.query(
          `insert into ocs.documents (company_id, name, category, version_count)
           values ($1, $2, 'photo', 1) returning id`,
          [ALPHA, `p${i}.png`],
        );
        await c.query(
          `insert into ocs.supervision_visit_photos
             (company_id, visit_id, document_id, photo_type, sequence, taken_at)
           values ($1,$2,$3,'work_in_progress',$4, now())`,
          [ALPHA, visitId, doc.rows[0].id, i + 1],
        );
      }
      const v = await c.query(
        'select photo_count from ocs.supervision_visits where id = $1', [visitId],
      );
      return Number(v.rows[0].photo_count);
    } finally {
      await c.end();
    }
  };

  it('keeps the visit’s photo count honest', async () => {
    expect(await attach(2)).toBe(2);
  });

  it('unblocks sign-off once the photographs are there', async () => {
    /*
     * The end-to-end point of this file. Before the attach endpoint existed
     * this update could never succeed, on any visit, ever.
     */
    await attach(3);
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `update ocs.supervision_visits
              set status = 'completed', checked_in_at = now(),
                  signed_off_at = now(), findings = 'Deck sound'
            where id = $1`,
          [visitId],
        ),
      ).resolves.toBeTruthy();
    } finally {
      await c.end();
    }
  });

  it('still refuses sign-off one photograph short', async () => {
    await attach(2);
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `update ocs.supervision_visits
              set status = 'completed', checked_in_at = now(),
                  signed_off_at = now(), findings = 'Deck sound'
            where id = $1`,
          [visitId],
        ),
      ).rejects.toThrow(/photo/i);
    } finally {
      await c.end();
    }
  });

  it('shows the supervisor their own queue', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, SUP);
      const res = await app.inject({
        method: 'GET', url: '/api/supervision/my-visits',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.visits.map((v: { id: string }) => v.id);
      expect(ids).toContain(visitId);
      // And not the other supervisor's.
      expect(ids).not.toContain(otherVisitId);
    } finally {
      await app.close();
    }
  });
});
