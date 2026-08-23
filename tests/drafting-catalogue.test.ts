/**
 * The drafting catalogue exists twice, and both copies must say the same thing.
 *
 * The screen renders its checkboxes from DRAFTING_SERVICES in src/shared. The
 * API validates a submitted order against ocs.drafting_services in the
 * database — "Not a service we offer" comes from a SELECT, not from the
 * constant. So a service added to one and not the other fails in the worst
 * available way: the option appears, a contractor picks it, fills in the rest
 * of the request, and is refused on submit by a server that does not believe
 * in something it is showing them.
 *
 * The reverse is quieter and still wrong — a row in the table with no entry in
 * the constant is a service that is sold, priced and unorderable.
 *
 * Also checked here: every service belongs to exactly one group. A service
 * missing from DRAFTING_GROUPS renders nowhere at all, and nothing else in the
 * system would mention it.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAFTING_SERVICES,
  DRAFTING_LABELS,
  DRAFTING_GROUPS,
  DRAFTING_SATISFIES,
  DEFAULT_DRAFTING_RATES,
} from '../src/shared/drafting.js';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

describe('the drafting catalogue', () => {
  it('offers the disciplines a building department reviews separately', () => {
    /*
     * Named individually rather than by counting, because the point is these
     * four in particular. Mechanical, electrical and plumbing each go to their
     * own plans examiner; life safety goes to the fire marshal on a separate
     * track and is asked for by name.
     */
    for (const service of [
      'MECHANICAL_PLANS', 'ELECTRICAL_PLANS', 'PLUMBING_PLANS', 'LIFE_SAFETY_PLANS',
    ] as const) {
      expect(DRAFTING_SERVICES, `${service} is missing`).toContain(service);
      expect(DRAFTING_LABELS[service], `${service} has no label`).toBeTruthy();
    }

    // The combined package stays: orders already reference it, and removing a
    // value would leave those rows carrying a key nothing maps to a label.
    expect(DRAFTING_SERVICES).toContain('MEP_DESIGN');
  });

  it('gives every service a label, a price and a group', () => {
    const grouped = DRAFTING_GROUPS.flatMap((g) => g.services);

    for (const service of DRAFTING_SERVICES) {
      expect(DRAFTING_LABELS[service], `${service} has no label`).toBeTruthy();
      expect(
        DEFAULT_DRAFTING_RATES.find((r) => r.service === service),
        `${service} is not in the price book, so the screen shows it with no price or turnaround`,
      ).toBeTruthy();
      expect(
        DRAFTING_SATISFIES[service],
        `${service} is not in the satisfies map`,
      ).toBeDefined();
      expect(
        grouped.filter((s) => s === service).length,
        `${service} must be in exactly one group — none means it renders nowhere`,
      ).toBe(1);
    }

    // Nothing invented on the group side either.
    for (const service of grouped) {
      expect(DRAFTING_SERVICES, `${service} is grouped but is not a service`)
        .toContain(service);
    }
  });

  it('claims only requirement keys that exist', async () => {
    /*
     * A delivered plan set that claims to satisfy a requirement it does not is
     * worse than one claiming nothing: the first clears a checklist item
     * nobody then looks at again. Where no key exists for a discipline the
     * list is deliberately empty rather than pointed at an approximate one.
     */
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/shared/requirements.ts', import.meta.url), 'utf8');
    for (const [service, keys] of Object.entries(DRAFTING_SATISFIES)) {
      for (const key of keys) {
        expect(
          src.includes(`'${key}'`),
          `${service} claims to satisfy '${key}', which is not a requirement key`,
        ).toBe(true);
      }
    }
  });
});

describeIfDb('the catalogue in the database', () => {
  it('matches the one the screen renders from', async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    let rows: Array<{ service: string; label: string; is_active: boolean }>;
    try {
      ({ rows } = await c.query('select service, label, is_active from ocs.drafting_services'));
    } finally {
      await c.end();
    }

    const inDb = new Set(rows.filter((r) => r.is_active).map((r) => r.service));
    const inCode = new Set<string>(DRAFTING_SERVICES);

    const shownButRejected = [...inCode].filter((s) => !inDb.has(s));
    expect(
      shownButRejected,
      shownButRejected.length
        ? 'The screen offers these and the API will refuse them — the create ' +
          'handler validates against ocs.drafting_services, so a contractor ' +
          `picks one, fills in the request and is told "Not a service we ` +
          `offer":\n  ${shownButRejected.join('\n  ')}\n` +
          'Add them in a migration.'
        : '',
    ).toEqual([]);

    const soldButUnorderable = [...inDb].filter((s) => !inCode.has(s));
    expect(
      soldButUnorderable,
      soldButUnorderable.length
        ? 'These are active and priced in the database and appear on no screen:\n  ' +
          `${soldButUnorderable.join('\n  ')}`
        : '',
    ).toEqual([]);
  });

  it('agrees on whether each service needs a seal', async () => {
    /*
     * requiresSeal drives the AWAITING_SEAL step, and the ROUTE reads it from
     * the table while the screen reads it from the price book. Disagreeing
     * means the screen promises a sealed drawing the workflow never routes to
     * an engineer, or the reverse.
     */
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    let rows: Array<{ service: string; requires_seal: boolean }>;
    try {
      ({ rows } = await c.query('select service, requires_seal from ocs.drafting_services'));
    } finally {
      await c.end();
    }

    const mismatched: string[] = [];
    for (const row of rows) {
      const rate = DEFAULT_DRAFTING_RATES.find((r) => r.service === row.service);
      if (!rate) continue;
      if (rate.requiresSeal !== row.requires_seal) {
        mismatched.push(
          `${row.service}: table says ${row.requires_seal}, price book says ${rate.requiresSeal}`,
        );
      }
    }
    expect(mismatched, mismatched.join('\n  ')).toEqual([]);
  });

  it('accepts an order for the new disciplines, end to end', async () => {
    /*
     * The point of the whole change. The catalogue agreeing on paper is not
     * the same as the create handler taking the order — it validates against
     * the table with an `is_active` filter and its own SELECT.
     */
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    const COMPANY = 'eeee1111-0000-0000-0000-0000000000e1';
    const STAFF = { email: 'draft-admin@test.invalid', password: 'DraftAdmin2026!' };
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [COMPANY]);
      await c.query(
        `insert into ocs.companies (id, name, email, status)
         values ($1,'Alpha Roofing','ana@alpha.test','active')`,
        [COMPANY],
      );
      await c.query('delete from ocs.app_users where email = $1', [STAFF.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [STAFF.email, STAFF.password],
      );
    } finally {
      await c.end();
    }

    process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
    process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
    const { buildServer } = await import('../src/index.js');
    const app = await buildServer();
    await app.ready();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: STAFF });
      expect(login.statusCode).toBe(200);
      const headers = { authorization: `Bearer ${JSON.parse(login.body).accessToken}` };

      for (const service of [
        'MECHANICAL_PLANS', 'ELECTRICAL_PLANS', 'PLUMBING_PLANS', 'LIFE_SAFETY_PLANS',
      ]) {
        const res = await app.inject({
          method: 'POST', url: '/api/drafting', headers,
          payload: {
            clientId: COMPANY,
            title: `${service} for the Bay Street job`,
            services: [service],
            brief: 'Test order',
          },
        });
        expect(
          res.statusCode,
          `ordering ${service} was refused: ${res.body.slice(0, 250)}`,
        ).toBe(201);
      }

      // And several at once, which is how an MEP job is actually ordered.
      const combined = await app.inject({
        method: 'POST', url: '/api/drafting', headers,
        payload: {
          clientId: COMPANY,
          title: 'Full MEP for the Bay Street job',
          services: ['MECHANICAL_PLANS', 'ELECTRICAL_PLANS', 'PLUMBING_PLANS'],
          brief: 'Test order',
        },
      });
      expect(combined.statusCode, combined.body.slice(0, 250)).toBe(201);
    } finally {
      await app.close();
    }
  }, 60_000);
});
