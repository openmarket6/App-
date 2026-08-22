/**
 * Notarization records.
 *
 * Unlike everything else in this system, the value of these rows is not in
 * serving a screen. It is in being correct and unaltered when somebody disputes
 * a lien or a Notice of Commencement years from now. A notarization that cannot
 * withstand that is worth nothing, so every rule below is enforced by the
 * database and tested there -- not in the route that happens to call it today.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const DOC = 'eeee1111-0000-0000-0000-000000000001';
const BETA_DOC = 'eeee2222-0000-0000-0000-000000000002';

const complete = (extra: Record<string, unknown> = {}) => ({
  type: 'ron',
  status: 'completed',
  notary_name: 'Jane Notary',
  notary_commission_number: 'GG123456',
  session_recording_ref: 'ron://session/1',
  ...extra,
});

describeIfDb('notarization records', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.documents where id in ($1,$2)`, [DOC, BETA_DOC]);
      await c.query(
        `insert into ocs.documents (id, company_id, name, category) values
           ($1, $2, 'Notice of Commencement', 'other'),
           ($3, $4, 'Beta NOC', 'other')`,
        [DOC, ALPHA, BETA_DOC, BETA],
      );
    } finally {
      await c.end();
    }
  });

  const insert = async (fields: Record<string, unknown>, documentId = DOC) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const cols = ['company_id', 'document_id', ...Object.keys(fields)];
      const vals = [ALPHA, documentId, ...Object.values(fields)];
      const params = vals.map((_, i) => `$${i + 1}`).join(',');
      const r = await c.query(
        `insert into ocs.notarizations (${cols.join(',')}) values (${params})
         returning id, retention_until, status::text as status`,
        vals,
      );
      return r.rows[0];
    } finally {
      await c.end();
    }
  };

  it('refuses a completed RON with no session recording', async () => {
    // Florida requires the audio-video recording to be retained ten years
    // (s.117.245). A completed record with no pointer to it is not a record --
    // it is a claim that an act happened with nothing to show for it.
    await expect(insert(complete({ session_recording_ref: null, completed_at: new Date() })))
      .rejects.toThrow(/notarizations_ron_needs_recording/i);
  });

  it('refuses a completed act that names no notary', async () => {
    await expect(
      insert(complete({ notary_name: null, notary_commission_number: null, completed_at: new Date() })),
    ).rejects.toThrow(/notarizations_completed_names_notary/i);
  });

  it('refuses an act dated after the commission expired', async () => {
    // A notarial act performed after the commission expired is VOID.
    // Discovering that in litigation years later costs far more than refusing
    // it now, which is why this is an error and not a warning.
    await expect(
      insert(complete({
        completed_at: new Date(),
        notary_commission_expires_at: '2020-01-01',
      })),
    ).rejects.toThrow(/commission expired/i);
  });

  it('computes the ten-year retention deadline itself', async () => {
    // Never accepted from a caller, for the same reason a supervision timestamp
    // is not: a deadline the caller can set is a deadline the caller can
    // shorten.
    const row = await insert(complete({
      completed_at: '2026-03-15T12:00:00Z',
      notary_commission_expires_at: '2030-01-01',
    }));
    expect(new Date(row.retention_until).toISOString().slice(0, 10)).toBe('2036-03-15');
  });

  it('ignores a retention date a caller tries to supply', async () => {
    const row = await insert(complete({
      completed_at: '2026-03-15T12:00:00Z',
      notary_commission_expires_at: '2030-01-01',
      retention_until: '2026-04-01T00:00:00Z',
    }));
    expect(new Date(row.retention_until).toISOString().slice(0, 10)).toBe('2036-03-15');
  });

  it('will not let a completed record be rewritten', async () => {
    const row = await insert(complete({
      completed_at: new Date(),
      notary_commission_expires_at: '2030-01-01',
    }));

    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(`update ocs.notarizations set notary_name = 'Someone Else' where id = $1`, [row.id]),
      ).rejects.toThrow(/finished record/i);
    } finally {
      await c.end();
    }
  });

  it('still allows the recording reference to be attached afterwards', async () => {
    // A RON provider often returns the recording reference minutes or hours
    // after the session ends. Freezing the whole row would make the evidence
    // impossible to attach.
    const row = await insert(complete({
      completed_at: new Date(),
      notary_commission_expires_at: '2030-01-01',
    }));

    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `update ocs.notarizations set journal_entry_ref = 'journal://42'
          where id = $1 returning journal_entry_ref`,
        [row.id],
      );
      expect(r.rows[0].journal_entry_ref).toBe('journal://42');
    } finally {
      await c.end();
    }
  });

  it('does not let the application delete a notarial record', async () => {
    // Retained for ten years by law. The ability to remove one should not exist
    // in the application at all, so there is no DELETE grant.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(`delete from ocs.notarizations`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('takes its tenant from the document, not the caller', async () => {
    // A notarization cannot be filed into a company that does not own the
    // document being notarized.
    const row = await insert(
      { type: 'in_person', status: 'requested' },
      BETA_DOC,
    );
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(`select company_id from ocs.notarizations where id = $1`, [row.id]);
      expect(r.rows[0].company_id).toBe(BETA);
    } finally {
      await c.end();
    }
  });

  it('keeps one contractor out of another contractor records', async () => {
    const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
      const r = await c.query(
        `select count(*)::int as n from ocs.notarizations where document_id = $1`,
        [DOC],
      );
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});
