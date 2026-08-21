/**
 * White-glove supervision compliance.
 *
 * These are the rules that keep the qualifying service legal. In Florida a
 * qualifier who lets their license be used on work they do not actually
 * supervise is committing an offence, so the difference between a legitimate
 * service and "renting a license" is whether supervision really happened and
 * can be proven. Each test below pins one way the system refuses to record a
 * state it cannot stand behind.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { distanceMeters, assessProximity, CHECK_IN_RADIUS_METERS } from '../src/domain/geo.js';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, ALPHA_USER,
} from './helpers/db.js';

describe('site proximity', () => {
  it('measures real-world distance', () => {
    // Two points about 1.5 km apart in downtown Tampa.
    const a = { latitude: 27.9506, longitude: -82.4572 };
    const b = { latitude: 27.9639, longitude: -82.4573 };
    const d = distanceMeters(a, b);
    expect(d).toBeGreaterThan(1400);
    expect(d).toBeLessThan(1600);
  });

  it('accepts a check-in at the site and flags one far away', () => {
    const site = { latitude: 27.9506, longitude: -82.4572 };
    const atSite = assessProximity(site, { latitude: 27.9507, longitude: -82.4573 });
    expect(atSite.withinRadius).toBe(true);
    expect(atSite.distanceMeters).toBeLessThan(CHECK_IN_RADIUS_METERS);

    const milesAway = assessProximity(site, { latitude: 28.05, longitude: -82.45 });
    expect(milesAway.withinRadius).toBe(false);
    // Still measured, not discarded — an anomalous check-in must stay visible.
    expect(milesAway.distanceMeters).toBeGreaterThan(CHECK_IN_RADIUS_METERS);
  });

  it('reports unverifiable when the site has no coordinates', () => {
    // Must not silently read as "within radius" — absence of evidence is not
    // evidence of presence.
    const result = assessProximity(
      { latitude: null, longitude: null },
      { latitude: 27.95, longitude: -82.45 },
    );
    expect(result.unverifiable).toBe(true);
    expect(result.withinRadius).toBe(false);
    expect(result.distanceMeters).toBeNull();
  });
});

const describeIfDb = dbConfigured ? describe : describe.skip;

const ROOFING = `(select id from ocs.trades where code = 'roofing')`;
const PLUMBING = `(select id from ocs.trades where code = 'plumbing')`;

describeIfDb('qualifying and supervision, enforced by the database', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();

    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.supervisors where display_name like 'Test %'`);
      await c.query(`delete from ocs.service_licenses where license_number like 'TEST-%'`);

      await c.query(
        `insert into ocs.supervisors (id, user_id, display_name, trade_ids, max_active_engagements)
         select '00000000-1111-0000-0000-000000000001', $1, 'Test Supervisor',
                array[${ROOFING}], 2
         on conflict (user_id) do update set display_name = 'Test Supervisor'`,
        [ALPHA_USER],
      );
      await c.query(
        `insert into ocs.service_licenses
           (id, trade_id, license_number, qualifier_name, expires_on, max_active_engagements)
         values
           ('00000000-2222-0000-0000-000000000001', ${ROOFING}, 'TEST-EXPIRED', 'Q', current_date - 1, 25),
           ('00000000-2222-0000-0000-000000000002', ${ROOFING}, 'TEST-VALID',   'Q', current_date + 365, 1),
           ('00000000-2222-0000-0000-000000000003', ${PLUMBING}, 'TEST-PLUMB',  'P', current_date + 365, 25)`,
      );
    } finally {
      await c.end();
    }
  });

  const activate = (licenseId: string, tradeSql = ROOFING) =>
    asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      await c.query(
        `insert into ocs.supervision_engagements
           (company_id, trade_id, service_license_id, supervisor_id, status, terms_accepted_at)
         values ($1, ${tradeSql}, $2, '00000000-1111-0000-0000-000000000001', 'active', now())`,
        [ALPHA, licenseId],
      );
    });

  it('refuses to qualify work under an EXPIRED license', async () => {
    await expect(activate('00000000-2222-0000-0000-000000000001')).rejects.toThrow(/expired/i);
  });

  it('refuses a license that does not cover the trade', async () => {
    // Qualifying roofing under a plumbing license is exactly the abuse the
    // service must never enable.
    await expect(activate('00000000-2222-0000-0000-000000000003')).rejects.toThrow(
      /does not cover this trade/i,
    );
  });

  it('refuses to activate before the contractor accepts terms', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.supervision_engagements
             (company_id, trade_id, service_license_id, supervisor_id, status)
           values ($1, ${ROOFING}, '00000000-2222-0000-0000-000000000002',
                   '00000000-1111-0000-0000-000000000001', 'active')`,
          [ALPHA],
        );
      }),
    ).rejects.toThrow(/engagements_active_requires_terms/i);
  });

  it('refuses to activate without a named supervisor', async () => {
    // Nobody accountable on site means no supervision. Two guards cover this --
    // the compliance trigger and the CHECK constraint. The trigger fires first
    // and gives the better message, so either is an acceptable rejection.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.supervision_engagements
             (company_id, trade_id, service_license_id, status, terms_accepted_at)
           values ($1, ${ROOFING}, '00000000-2222-0000-0000-000000000002', 'active', now())`,
          [ALPHA],
        );
      }),
    ).rejects.toThrow(/without a supervisor|engagements_active_requires_assignment/i);
  });

  it('enforces the qualifier’s active-engagement limit', async () => {
    // An unbounded caseload makes "real supervisory control" indefensible.
    await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      await c.query(
        `insert into ocs.supervision_engagements
           (company_id, trade_id, service_license_id, supervisor_id, status, terms_accepted_at)
         values ($1, ${ROOFING}, '00000000-2222-0000-0000-000000000002',
                 '00000000-1111-0000-0000-000000000001', 'active', now())`,
        [ALPHA],
      );

      await expect(
        c.query(
          `insert into ocs.supervision_engagements
             (company_id, trade_id, service_license_id, supervisor_id, status, terms_accepted_at)
           values ($1, ${ROOFING}, '00000000-2222-0000-0000-000000000002',
                   '00000000-1111-0000-0000-000000000001', 'active', now())`,
          [ALPHA],
        ),
      ).rejects.toThrow(/limit 1/i);
    });
  });

  it('refuses to complete an engagement with mandatory visits outstanding', async () => {
    // The rule that keeps "completed" from becoming a lie.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const e = await c.query(
          `insert into ocs.supervision_engagements
             (company_id, trade_id, service_license_id, supervisor_id, status, terms_accepted_at)
           values ($1, ${ROOFING}, '00000000-2222-0000-0000-000000000002',
                   '00000000-1111-0000-0000-000000000001', 'active', now())
           returning id`,
          [ALPHA],
        );
        await c.query(
          `insert into ocs.supervision_visits
             (engagement_id, milestone_code, milestone_name, is_mandatory, status)
           values ($1, 'dry_in', 'Dry-in / nailing', true, 'required')`,
          [e.rows[0].id],
        );
        await c.query(`update ocs.supervision_engagements set status='completed' where id=$1`, [
          e.rows[0].id,
        ]);
      }),
    ).rejects.toThrow(/outstanding/i);
  });

  it('refuses a completed visit with no check-in', async () => {
    // A sign-off without a check-in is an assertion, not a record.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const e = await c.query(
          `insert into ocs.supervision_engagements (company_id, trade_id, status)
           values ($1, ${ROOFING}, 'accepted') returning id`,
          [ALPHA],
        );
        await c.query(
          `insert into ocs.supervision_visits
             (engagement_id, milestone_code, milestone_name, status, signed_off_at)
           values ($1, 'final', 'Final', 'completed', now())`,
          [e.rows[0].id],
        );
      }),
    ).rejects.toThrow(/visits_completed_requires_evidence/i);
  });

  it('refuses a waived visit with no reason', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const e = await c.query(
          `insert into ocs.supervision_engagements (company_id, trade_id, status)
           values ($1, ${ROOFING}, 'accepted') returning id`,
          [ALPHA],
        );
        await c.query(
          `insert into ocs.supervision_visits
             (engagement_id, milestone_code, milestone_name, status)
           values ($1, 'final', 'Final', 'waived')`,
          [e.rows[0].id],
        );
      }),
    ).rejects.toThrow(/visits_waived_requires_reason/i);
  });

  it('completes once every mandatory visit is signed off', async () => {
    // The positive case: with the evidence present, completion is allowed.
    const status = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const e = await c.query(
        `insert into ocs.supervision_engagements
           (company_id, trade_id, service_license_id, supervisor_id, status, terms_accepted_at)
         values ($1, ${ROOFING}, '00000000-2222-0000-0000-000000000002',
                 '00000000-1111-0000-0000-000000000001', 'active', now())
         returning id`,
        [ALPHA],
      );
      await c.query(
        `insert into ocs.supervision_visits
           (engagement_id, milestone_code, milestone_name, is_mandatory, status,
            checked_in_at, signed_off_at, signature_name)
         values ($1, 'final', 'Final', true, 'completed', now(), now(), 'Test Supervisor')`,
        [e.rows[0].id],
      );
      const done = await c.query(
        `update ocs.supervision_engagements set status='completed' where id=$1
         returning status::text, completed_at`,
        [e.rows[0].id],
      );
      return done.rows[0];
    });

    expect(status.status).toBe('completed');
    expect(status.completed_at).not.toBeNull();
  });

  it('refuses to sign off a visit with no photographs', async () => {
    // 100% supervision means every visit is photographed. A signed-off visit
    // with no photos would say a supervisor stood in a parking lot.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const e = await c.query(
          `insert into ocs.supervision_engagements (company_id, trade_id, status)
           values ($1, ${ROOFING}, 'accepted') returning id`,
          [ALPHA],
        );
        const v = await c.query(
          `insert into ocs.supervision_visits
             (engagement_id, milestone_code, milestone_name, status,
              required_photo_count, checked_in_at)
           values ($1, 'final', 'Final', 'in_progress', 3, now()) returning id`,
          [e.rows[0].id],
        );
        await c.query(
          `update ocs.supervision_visits
              set status='completed', signed_off_at=now(), signature_name='S'
            where id=$1`,
          [v.rows[0].id],
        );
      }),
    ).rejects.toThrow(/3 photo\(s\) required, 0 uploaded/i);
  });

  it('refuses sign-off when a required photo TYPE is missing', async () => {
    // Four photos of material labels do not show the completed work.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const e = await c.query(
          `insert into ocs.supervision_engagements (company_id, trade_id, status)
           values ($1, ${ROOFING}, 'accepted') returning id`,
          [ALPHA],
        );
        const v = await c.query(
          `insert into ocs.supervision_visits
             (engagement_id, milestone_code, milestone_name, status,
              required_photo_count, required_photo_types, checked_in_at)
           values ($1, 'final', 'Final', 'in_progress', 2,
                   array['site_overview','completed_work'], now()) returning id`,
          [e.rows[0].id],
        );
        for (let i = 0; i < 2; i++) {
          const d = await c.query(
            `insert into ocs.documents (company_id, name, category)
             values ($1, $2, 'photo') returning id`,
            [ALPHA, 'photo' + i],
          );
          await c.query(
            `insert into ocs.supervision_visit_photos (visit_id, document_id, photo_type)
             values ($1, $2, 'materials')`,
            [v.rows[0].id, d.rows[0].id],
          );
        }
        await c.query(
          `update ocs.supervision_visits
              set status='completed', signed_off_at=now(), signature_name='S'
            where id=$1`,
          [v.rows[0].id],
        );
      }),
    ).rejects.toThrow(/missing required photo type/i);
  });

  it('signs off once the photographic record is complete', async () => {
    const result = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const e = await c.query(
        `insert into ocs.supervision_engagements (company_id, trade_id, status)
         values ($1, ${ROOFING}, 'accepted') returning id`,
        [ALPHA],
      );
      const v = await c.query(
        `insert into ocs.supervision_visits
           (engagement_id, milestone_code, milestone_name, status,
            required_photo_count, required_photo_types, checked_in_at)
         values ($1, 'final', 'Final', 'in_progress', 2,
                 array['site_overview','completed_work'], now()) returning id`,
        [e.rows[0].id],
      );
      for (const type of ['site_overview', 'completed_work']) {
        const d = await c.query(
          `insert into ocs.documents (company_id, name, category)
           values ($1, $2, 'photo') returning id`,
          [ALPHA, type],
        );
        await c.query(
          `insert into ocs.supervision_visit_photos (visit_id, document_id, photo_type)
           values ($1, $2, $3::ocs.visit_photo_type)`,
          [v.rows[0].id, d.rows[0].id, type],
        );
      }
      const done = await c.query(
        `update ocs.supervision_visits
            set status='completed', signed_off_at=now(), signature_name='S'
          where id=$1 returning status::text, photo_count`,
        [v.rows[0].id],
      );
      return done.rows[0];
    });

    expect(result.status).toBe('completed');
    // photo_count is maintained by trigger, not by the caller.
    expect(result.photo_count).toBe(2);
  });

  it('keeps the photo count accurate as photos are added and removed', async () => {
    const counts = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const e = await c.query(
        `insert into ocs.supervision_engagements (company_id, trade_id, status)
         values ($1, ${ROOFING}, 'accepted') returning id`,
        [ALPHA],
      );
      const v = await c.query(
        `insert into ocs.supervision_visits
           (engagement_id, milestone_code, milestone_name, status)
         values ($1, 'dry_in', 'Dry-in', 'in_progress') returning id`,
        [e.rows[0].id],
      );
      const d = await c.query(
        `insert into ocs.documents (company_id, name, category)
         values ($1, 'p', 'photo') returning id`,
        [ALPHA],
      );
      await c.query(
        `insert into ocs.supervision_visit_photos (visit_id, document_id, photo_type)
         values ($1, $2, 'site_overview')`,
        [v.rows[0].id, d.rows[0].id],
      );
      const after = await c.query(`select photo_count from ocs.supervision_visits where id=$1`, [v.rows[0].id]);
      await c.query(`delete from ocs.supervision_visit_photos where visit_id=$1`, [v.rows[0].id]);
      const removed = await c.query(`select photo_count from ocs.supervision_visits where id=$1`, [v.rows[0].id]);
      return { added: after.rows[0].photo_count, removed: removed.rows[0].photo_count };
    });
    expect(counts.added).toBe(1);
    expect(counts.removed).toBe(0);
  });

  it('keeps engagements isolated between contractors', async () => {
    // Supervision records are as tenant-sensitive as anything else here.
    const visible = await asTenant(
      appUrl!,
      { companyId: '22222222-2222-2222-2222-222222222222' },
      async (c) => {
        const res = await c.query(
          `select count(*)::int as n from ocs.supervision_engagements where company_id = $1`,
          [ALPHA],
        );
        return res.rows[0].n;
      },
    );
    expect(visible).toBe(0);
  });
});
