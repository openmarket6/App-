/**
 * Posting an instrument, and being able to prove it went.
 *
 * For a Notice to Owner, service IS the point: a notice written perfectly and
 * produced perfectly is worth nothing if nobody can show it was served. So the
 * tests below are mostly about refusing to let that quietly not happen —
 * refusing a weaker mail class than the statute wants, refusing to record a
 * letter as delivered without a date, refusing to post a voided instrument.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  REQUIRED_MAIL_CLASS, MAIL_CLASS_LABELS, EXPECTED_COST_CENTS,
  resolveMailClass, validateAddress, validateMailRequest, canMail,
} from '../src/domain/mailing.js';
import { mapEventType, verifyWebhookSignature } from '../src/services/mail.js';
import { DOCUMENT_KINDS } from '../src/domain/documents/index.js';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const GOOD = {
  name: 'Marta Delgado',
  line1: '1200 Bay Street',
  city: 'Tampa',
  state: 'FL',
  postalCode: '33606',
};

describe('how an instrument goes out', () => {
  it('sends a Notice to Owner certified, with a return receipt', () => {
    /*
     * The rule the whole module exists for. 713.06 puts the burden of showing
     * service on the claimant, and the green card is the cheapest way to carry
     * it.
     */
    expect(REQUIRED_MAIL_CLASS.NTO).toBe('certified_return_receipt');
  });

  it('does not send an NOC certified', () => {
    // An NOC is recorded with the clerk and posted on the site. Nothing turns
    // on proof of delivery, so certified would be theatre at ten dollars a go.
    expect(REQUIRED_MAIL_CLASS.NOC).toBe('first_class');
  });

  it('refuses to downgrade below what the statute wants', () => {
    // The trade is a few dollars against a lien. Not one a form should offer.
    const r = resolveMailClass('NTO', 'first_class');
    expect(r.mailClass).toBe('certified_return_receipt');
    expect(r.downgradeRefused).toBe(true);
  });

  it('allows an upgrade', () => {
    // Sending an agreement certified because a particular contractor disputes
    // everything is a legitimate business call.
    const r = resolveMailClass('CONTRACTOR_AGREEMENT', 'certified');
    expect(r.mailClass).toBe('certified');
    expect(r.downgradeRefused).toBe(false);
  });

  it('has a class and a price for every kind of document', () => {
    for (const kind of DOCUMENT_KINDS) {
      const cls = REQUIRED_MAIL_CLASS[kind];
      expect(MAIL_CLASS_LABELS[cls], kind).toBeTruthy();
      expect(EXPECTED_COST_CENTS[cls], kind).toBeGreaterThan(0);
    }
  });

  it('prices certified above first class', () => {
    // Not a tautology: a wrong table here would quote somebody a dollar for a
    // ten-dollar letter, and they would find out on the invoice.
    expect(EXPECTED_COST_CENTS.certified_return_receipt)
      .toBeGreaterThan(EXPECTED_COST_CENTS.certified);
    expect(EXPECTED_COST_CENTS.certified).toBeGreaterThan(EXPECTED_COST_CENTS.first_class);
  });

  it('will not post a voided instrument', () => {
    const r = canMail('void');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/voided/i);
  });

  it('will post a draft', () => {
    // Producing and posting are one motion for a permit tech. Forcing an
    // "issue" click in between only teaches people to click without reading.
    expect(canMail('draft').ok).toBe(true);
  });
});

describe('the address', () => {
  it('accepts a good one', () => {
    expect(validateAddress(GOOD)).toHaveLength(0);
  });

  it('rejects a three-letter state', () => {
    // "FLA" is a returned letter.
    const p = validateAddress({ ...GOOD, state: 'FLA' });
    expect(p.map((x) => x.field)).toContain('address.state');
  });

  it('rejects a malformed ZIP', () => {
    expect(validateAddress({ ...GOOD, postalCode: '336' }).length).toBeGreaterThan(0);
  });

  it('accepts ZIP+4', () => {
    expect(validateAddress({ ...GOOD, postalCode: '33606-1234' })).toHaveLength(0);
  });

  it('rejects a recipient with no name', () => {
    const p = validateAddress({ ...GOOD, name: '   ' });
    expect(p.map((x) => x.field)).toContain('address.name');
  });

  it('insists on a return address for certified mail', () => {
    /*
     * Not a formality. The green card and the return-to-sender both come back
     * to it, and those two pieces of paper ARE the proof of service. A letter
     * with a bad return address can be delivered perfectly and prove nothing.
     */
    const problems = validateMailRequest({
      documentKind: 'NTO',
      to: GOOD,
      from: { name: 'OCS' },
      role: 'owner',
    });
    expect(problems.some((p) => p.field === 'from')).toBe(true);
  });
});

describe('what the provider tells us', () => {
  it('maps delivery to delivered', () => {
    expect(mapEventType('letter.delivered')).toBe('delivered');
  });

  it('maps a return to sender, which on an NTO is a failed service', () => {
    expect(mapEventType('letter.returned_to_sender')).toBe('returned');
  });

  it('ignores an event type it does not know', () => {
    // A provider adding an event must never silently move a letter into a
    // state this system reasons about.
    expect(mapEventType('letter.something_new')).toBeNull();
  });

  it('refuses a webhook with no signature', () => {
    expect(verifyWebhookSignature(Buffer.from('{}'), undefined, undefined)).toBe(false);
  });

  it('refuses a replayed signature', () => {
    /*
     * The timestamp is part of the signed material precisely so an old, genuine
     * delivery notice cannot be posted again later. A forged "delivered" is the
     * worst thing this table could hold.
     */
    const old = String(Date.now() - 60 * 60_000);
    expect(verifyWebhookSignature(Buffer.from('{}'), old, 'a'.repeat(64))).toBe(false);
  });
});

// -----------------------------------------------------------------------------

describeIfDb('what the database will not record', () => {
  let documentId = '';

  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(`insert into ocs.companies (id, name) values ($1, 'Alpha Roofing LLC')`, [ALPHA]);
      const d = await c.query(
        `insert into ocs.generated_documents
           (company_id, kind, title, input_snapshot, rendered_html, content_sha256)
         values ($1, 'NTO', 'Notice to Owner', '{}'::jsonb, '<html></html>', repeat('a',64))
         returning id`,
        [ALPHA],
      );
      documentId = d.rows[0].id;
    } finally {
      await c.end();
    }
  });

  const insert = async (cols: string, vals: string, params: unknown[] = []) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      return await c.query(
        `insert into ocs.document_mailings
           (company_id, generated_document_id, mail_class, expected_cost_cents,
            to_name, to_line1, to_city, to_state, to_postal_code,
            from_name, from_line1, from_city, from_state, from_postal_code${cols})
         values ($1, $2, 'certified_return_receipt', 1003,
                 'Marta Delgado', '1200 Bay Street', 'Tampa', 'FL', '33606',
                 'OCS', '88 Industrial Way', 'Tampa', 'FL', '33619'${vals})`,
        [ALPHA, documentId, ...params],
      );
    } finally {
      await c.end();
    }
  };

  it('accepts an ordinary queued letter', async () => {
    await expect(insert('', '')).resolves.toBeTruthy();
  });

  it('refuses a submitted letter with no provider id', async () => {
    // A letter the provider has cannot claim to have no identifier. That state
    // only arises from a bug, and it would read as an ordinary row in a report.
    await expect(insert(', status', ", 'submitted'")).rejects.toThrow(/provider_id/);
  });

  it('refuses a delivered letter with no delivery date', async () => {
    // "Delivered" with no date is a proof of service that cannot say when.
    await expect(
      insert(', status, provider_id', ", 'delivered', 'ltr_1'"),
    ).rejects.toThrow(/delivered_has_a_date/);
  });

  it('refuses a returned letter with no return date', async () => {
    await expect(
      insert(', status, provider_id', ", 'returned', 'ltr_2'"),
    ).rejects.toThrow(/returned_has_a_date/);
  });

  it('refuses a three-letter state', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `insert into ocs.document_mailings
             (company_id, generated_document_id, mail_class, expected_cost_cents,
              to_name, to_line1, to_city, to_state, to_postal_code,
              from_name, from_line1, from_city, from_state, from_postal_code)
           values ($1,$2,'first_class',108,
                   'X','1 St','Tampa','FLA','33606',
                   'OCS','88 Way','Tampa','FL','33619')`,
          [ALPHA, documentId],
        ),
      ).rejects.toThrow(/to_state/);
    } finally {
      await c.end();
    }
  });

  it('records one letter per provider id, so a redelivery cannot duplicate it', async () => {
    await insert(', status, provider_id, submitted_at', ", 'submitted', 'ltr_unique', now()");
    await expect(
      insert(', status, provider_id, submitted_at', ", 'submitted', 'ltr_unique', now()"),
    ).rejects.toThrow(/provider_id_idx/);
  });

  it('keeps every event rather than only the latest', async () => {
    /*
     * "In transit, then delivered, then returned" is a story, and the dates it
     * turns on are exactly what a dispute asks about. Only the latest status
     * would throw them away.
     */
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const m = await c.query(
        `insert into ocs.document_mailings
           (company_id, generated_document_id, mail_class, expected_cost_cents,
            to_name, to_line1, to_city, to_state, to_postal_code,
            from_name, from_line1, from_city, from_state, from_postal_code,
            status, provider_id, submitted_at)
         values ($1,$2,'certified_return_receipt',1003,
                 'M','1 St','Tampa','FL','33606',
                 'OCS','88 Way','Tampa','FL','33619',
                 'submitted','ltr_events', now())
         returning id`,
        [ALPHA, documentId],
      );
      const id = m.rows[0].id;

      for (const s of ['in_transit', 'delivered']) {
        await c.query(
          `update ocs.document_mailings
              set events = events || $2::jsonb,
                  status = $3::ocs.mail_status,
                  delivered_at = case when $3 = 'delivered'
                                      then coalesce(delivered_at, now()) else delivered_at end
            where id = $1`,
          [id, JSON.stringify([{ at: new Date().toISOString(), status: s }]), s],
        );
      }

      const after = await c.query(
        'select events, status::text as status from ocs.document_mailings where id = $1',
        [id],
      );
      expect(after.rows[0].events).toHaveLength(2);
      expect(after.rows[0].status).toBe('delivered');
    } finally {
      await c.end();
    }
  });
});
