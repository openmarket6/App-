/**
 * The supervision record, on the path the application can reach.
 *
 * This is what the business is selling: a contractor works under this firm's
 * licence, and the only thing between that and an unlicensed-contracting
 * problem is evidence that somebody qualified was genuinely supervising.
 *
 * Two identities matter here and they are easy to confuse. A LOGIN is an
 * app_users row. A SUPERVISOR is an ocs.supervisors row -- a person with trades
 * they are competent in, a service area and a daily capacity. Visits point at
 * the second. Comparing a visit against the first does not error; it silently
 * compares two unrelated identifiers, which is how anyone with the capability
 * ends up able to check in against somebody else's visit.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, client, ownerUrl, ALPHA,
} from './helpers/db.js';
import { assessSupervision, SITE_VISIT_PURPOSES } from '../src/shared/supervision.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'v1', permitId: 'p1', projectId: 'pr1', clientId: 'c1',
  supervisorUserId: 's1', purpose: 'PROGRESS' as const,
  occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
  location: null, observations: 'Deck sound', directionGiven: null,
  photoDocumentIds: ['d1', 'd2', 'd3'], amendedAt: null, amendedBy: null,
  amendmentReason: null, ...over,
});

describe('the supervision verdict', () => {
  it('is not defensible with no supervisor named', () => {
    // A managed-licence permit with nobody named has no basis at all. This is
    // the finding that matters most, so it is blocking rather than a warning.
    const v = assessSupervision({
      visits: [], supervisorUserId: null, qualifier: null,
      qualifierActivePermits: 0, stage: 'ISSUED',
    });
    expect(v.defensible).toBe(false);
    expect(v.gaps.some((g) => g.kind === 'no_supervisor' && g.severity === 'blocking')).toBe(true);
  });

  it('is not defensible on an expired qualifier licence', () => {
    const v = assessSupervision({
      visits: [visit()], supervisorUserId: 's1',
      qualifier: { licenseExpiresAt: '2020-01-01', maxConcurrentPermits: null },
      qualifierActivePermits: 1, stage: 'ISSUED',
    });
    expect(v.gaps.some((g) => g.kind === 'license_expired')).toBe(true);
    expect(v.defensible).toBe(false);
  });

  it('flags a qualifier past their own capacity', () => {
    // Capacity somebody cannot supervise is the exact pattern a regulator
    // looks for, and the cap here is self-imposed -- which makes exceeding it
    // worse, not better.
    const v = assessSupervision({
      visits: [visit()], supervisorUserId: 's1',
      qualifier: { licenseExpiresAt: null, maxConcurrentPermits: 10 },
      qualifierActivePermits: 25, stage: 'ISSUED',
    });
    expect(v.gaps.some((g) => g.kind === 'qualifier_over_capacity')).toBe(true);
  });

  it('counts the visits it was given', () => {
    const v = assessSupervision({
      visits: [visit({ id: 'a' }), visit({ id: 'b' })], supervisorUserId: 's1',
      qualifier: { licenseExpiresAt: null, maxConcurrentPermits: null },
      qualifierActivePermits: 1, stage: 'ISSUED',
    });
    expect(v.visitCount).toBe(2);
    expect(v.lastVisitAt).toBeTruthy();
  });

  it('knows every visit purpose the field app can record', () => {
    expect(SITE_VISIT_PURPOSES).toContain('PRE_CONSTRUCTION');
    expect(SITE_VISIT_PURPOSES).toContain('FINAL');
  });
});

describeIfDb('a visit belongs to the person who was there', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.supervision_visit_photos`);
      await c.query(`delete from ocs.supervision_visits`);
      await c.query(`delete from ocs.supervisors where display_name like 'Test %'`);
    } finally {
      await c.end();
    }
  });

  it('points supervisor_id at a supervisor, not at a login', async () => {
    /*
     * The bug this pins. A login and a supervisor are different rows, and
     * comparing one against the other does not fail loudly -- it just never
     * matches, or worse, matches nothing and lets the check pass.
     */
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const user = await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active)
         values ('sup-test@test.invalid','Test Sam','SITE_SUPERVISOR',true)
         on conflict (lower(email)) do update set name = excluded.name
         returning id`,
      );

      // A user id is NOT accepted where a supervisor id belongs.
      await expect(
        c.query(
          `insert into ocs.supervision_engagements (company_id, engagement_number, trade_id, status)
           values ($1, 9500, (select id from ocs.trades limit 1), 'accepted')
           returning id`,
          [ALPHA],
        ).then((e) =>
          c.query(
            `insert into ocs.supervision_visits
               (company_id, engagement_id, milestone_code, milestone_name, sequence,
                status, supervisor_id, required_photo_count)
             values ($1, $2, 'progress', 'Progress', 1, 'scheduled', $3, 3)`,
            [ALPHA, e.rows[0].id, user.rows[0].id],
          ),
        ),
      ).rejects.toThrow(/supervisor_id_fkey/i);
    } finally {
      await c.end();
    }
  });

  it('will not sign off a visit without its photographs', async () => {
    // Enforced by a trigger, not only by the route. A photograph minimum that
    // lives in a route is a minimum that lasts until the next route.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const user = await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active)
         values ('sup-photo@test.invalid','Test Photo','SITE_SUPERVISOR',true)
         on conflict (lower(email)) do update set name = excluded.name returning id`,
      );
      const sup = await c.query(
        `insert into ocs.supervisors (user_id, display_name, is_active)
         values ($1, 'Test Photo Sup', true) returning id`,
        [user.rows[0].id],
      );
      const eng = await c.query(
        `insert into ocs.supervision_engagements (company_id, engagement_number, trade_id, status)
         values ($1, 9501, (select id from ocs.trades limit 1), 'accepted') returning id`,
        [ALPHA],
      );
      const v = await c.query(
        `insert into ocs.supervision_visits
           (company_id, engagement_id, milestone_code, milestone_name, sequence,
            status, supervisor_id, required_photo_count, photo_count)
         values ($1,$2,'progress','Progress',1,'in_progress',$3,3,0) returning id`,
        [ALPHA, eng.rows[0].id, sup.rows[0].id],
      );

      await expect(
        c.query(
          `update ocs.supervision_visits
              set status = 'completed', signed_off_at = now(), findings = 'Looks fine'
            where id = $1`,
          [v.rows[0].id],
        ),
      ).rejects.toThrow(/photo/i);
    } finally {
      await c.end();
    }
  });
});
