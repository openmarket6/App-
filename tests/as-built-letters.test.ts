/**
 * As-built letters, one per trade.
 *
 * A letter is not a plan set, and the distinction is the thing most likely to
 * be got wrong by whoever maintains this next. An as-built PLAN SET is the
 * approved drawings revised to show what was built, sealed by the design
 * professional — that is the AS_BUILT drafting service. A LETTER is a page in
 * which the licensed trade contractor certifies, over their licence number,
 * that what they installed matches the approved plans and the code edition the
 * permit was issued under. A department asking for one will not accept the
 * other.
 *
 * On sourcing: Florida has no single statewide form. The requirement and its
 * wording come from each department's closeout checklist. What is common to
 * the published ones — the permit, the property, who certifies and under which
 * licence, what was installed, against which approved set and code edition, a
 * signature and optionally a notary — is what these assert.
 */
import { describe, it, expect } from 'vitest';
import {
  generateDocument, validateDocument, DOCUMENT_KINDS,
  AS_BUILT_TRADES, AS_BUILT_TRADE_LABELS, AS_BUILT_TRADE_SPEC,
} from '../src/domain/documents/index.js';
import { DOCUMENT_FIELDS } from '../src/domain/documents/fields.js';
import { esc } from '../src/domain/documents/render.js';

const AT = { generatedAt: '2026-03-01T12:00:00.000Z' };

const COMPLETE = {
  trade: 'ROOFING' as const,
  permitNumber: 'BLD-2026-004182',
  propertyAddress: '1200 Bay Street, Tampa, FL 33606',
  parcelId: 'A-12-29-18-3RM-000007-00004.0',
  contractorName: 'Alpha Roofing LLC',
  contractorLicenseNumber: 'CCC1330000',
  contractorAddress: '88 Industrial Way, Tampa, FL 33619',
  qualifierName: 'Ana Reyes',
  scopeDescription: 'Removal of existing shingle roof and installation of 34 squares of architectural shingle over synthetic underlayment.',
  codeEdition: '2023 Florida Building Code, 8th Edition',
  completedOn: '2026-02-20',
  deviations: 'None.',
};

describe('an as-built letter', () => {
  it('is a document kind of its own, separate from the as-built plan set', () => {
    expect(DOCUMENT_KINDS).toContain('AS_BUILT_LETTER');
    expect(DOCUMENT_FIELDS['AS_BUILT_LETTER'].length).toBeGreaterThan(5);
  });

  it('offers the trade as a dropdown, with every trade in it', () => {
    const trade = DOCUMENT_FIELDS['AS_BUILT_LETTER'].find((f) => f.name === 'trade');
    expect(trade, 'no trade field').toBeTruthy();
    expect(trade!.type).toBe('select');
    expect(trade!.required).toBe(true);
    expect(trade!.options?.map((o) => o.value).sort()).toEqual([...AS_BUILT_TRADES].sort());
  });

  it('generates for every trade, and says what that trade certifies', () => {
    for (const trade of AS_BUILT_TRADES) {
      const result = generateDocument('AS_BUILT_LETTER', { ...COMPLETE, trade }, AT);
      expect(result.ok, `${trade} did not generate`).toBe(true);
      if (!result.ok) continue;

      /*
       * Escaped, because the renderer escapes — "Windows & doors" reaches the
       * page as "Windows &amp; doors". Asserting the raw label would fail on
       * the one trade whose name contains an ampersand, which is exactly the
       * kind of thing that gets an assertion loosened instead of understood.
       */
      expect(result.html).toContain(esc(AS_BUILT_TRADE_LABELS[trade]));
      /*
       * The operative sentence, per trade. A generic "installed per plans"
       * across all seven would be a letter a plans examiner cannot check —
       * which is the reason these are separate at all.
       */
      const opening = esc(AS_BUILT_TRADE_SPEC[trade].certifies.slice(0, 40));
      expect(result.html, `${trade} does not carry its own certification`)
        .toContain(opening);
    }
  });

  it('carries what a department files it against', () => {
    const result = generateDocument('AS_BUILT_LETTER', COMPLETE, AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [what, value] of [
      ['permit number', COMPLETE.permitNumber],
      ['address', COMPLETE.propertyAddress],
      ['parcel', COMPLETE.parcelId],
      ['licence number', COMPLETE.contractorLicenseNumber],
      ['code edition', COMPLETE.codeEdition],
      ['signer', COMPLETE.qualifierName],
    ] as const) {
      expect(result.html, `the letter does not carry the ${what}`).toContain(value);
    }
  });

  it('refuses one that cannot be filed against a permit', () => {
    for (const missing of [
      'permitNumber', 'contractorLicenseNumber', 'contractorName', 'codeEdition',
    ]) {
      const input: Record<string, unknown> = { ...COMPLETE };
      delete input[missing];
      const problems = validateDocument('AS_BUILT_LETTER', input);
      expect(
        problems.some((p) => p.field === missing && p.severity === 'blocking'),
        `a letter with no ${missing} was allowed`,
      ).toBe(true);
    }
  });

  it('refuses a trade nobody offers', () => {
    const problems = validateDocument('AS_BUILT_LETTER', { ...COMPLETE, trade: 'LANDSCAPING' });
    expect(problems.some((p) => p.field === 'trade' && p.severity === 'blocking')).toBe(true);
  });

  it('states plainly that there were no deviations, rather than staying silent', () => {
    /*
     * A blank field left silent reads as an oversight. Printed as "none" it is
     * the contractor asserting there were none — which is what a reviewer is
     * actually relying on. Warned, not blocked: on most jobs there genuinely
     * are none, and refusing would teach people to type "n/a".
     */
    const { deviations: _drop, ...withoutDeviations } = COMPLETE;
    const problems = validateDocument('AS_BUILT_LETTER', withoutDeviations);
    const warned = problems.find((p) => p.field === 'deviations');
    expect(warned?.severity).toBe('warning');

    const result = generateDocument('AS_BUILT_LETTER', withoutDeviations, AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('None. The work as installed matches the approved plans.');
  });

  it('adds a notary block only when asked for one', () => {
    // Not every department wants it sworn, and a notary block on a letter that
    // does not need one is a signature somebody has to chase.
    const plain = generateDocument('AS_BUILT_LETTER', COMPLETE, AT);
    const sworn = generateDocument('AS_BUILT_LETTER', { ...COMPLETE, notaryBlock: true }, AT);
    expect(plain.ok && sworn.ok).toBe(true);
    if (!plain.ok || !sworn.ok) return;
    expect(plain.html).not.toContain('Notary Public');
    expect(sworn.html).toContain('Notary Public, State of Florida');
    expect(sworn.html).toContain('Sworn to and subscribed');
  });

  it('renders the same bytes twice, so the stored hash means something', () => {
    const a = generateDocument('AS_BUILT_LETTER', COMPLETE, AT);
    const b = generateDocument('AS_BUILT_LETTER', COMPLETE, AT);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.html).toBe(b.html);
  });

  it('is offered and produced over the API, dropdown options included', async () => {
    /*
     * The end that actually matters. The screen builds its form from
     * /api/generated-documents/kinds, and a select field with no options
     * reaching it renders an empty dropdown — a field nobody can answer.
     */
    const { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } =
      await import('./helpers/db.js');
    if (!dbConfigured) return;
    await applyMigrations();

    const STAFF = { email: 'letter-tech@test.invalid', password: 'LetterTech2026!' };
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
      await c.query('delete from ocs.app_users where email = $1', [STAFF.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Tech','PERMIT_TECH',true, crypt($2, gen_salt('bf',10)))`,
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

      const kinds = JSON.parse(
        (await app.inject({
          method: 'GET', url: '/api/generated-documents/kinds', headers,
        })).body,
      );
      const letter = kinds.kinds.find((k: { kind: string }) => k.kind === 'AS_BUILT_LETTER');
      expect(letter, 'the letter is not offered on the generate screen').toBeTruthy();

      const tradeField = letter.fields.find((f: { name: string }) => f.name === 'trade');
      expect(tradeField?.type).toBe('select');
      expect(
        tradeField?.options?.length,
        'the dropdown reaches the screen with no options in it',
      ).toBe(AS_BUILT_TRADES.length);

      // And one of each trade actually produces a document.
      for (const trade of ['ROOFING', 'ELECTRICAL', 'WINDOWS_AND_DOORS']) {
        const res = await app.inject({
          method: 'POST', url: '/api/generated-documents', headers,
          payload: {
            clientId: ALPHA, kind: 'AS_BUILT_LETTER',
            input: { ...COMPLETE, trade }, permitId: null,
          },
        });
        expect(res.statusCode, `${trade}: ${res.body.slice(0, 250)}`).toBe(201);
        expect(JSON.parse(res.body).sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});
