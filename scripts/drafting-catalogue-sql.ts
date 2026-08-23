/**
 * Print the SQL that makes ocs.drafting_services match the catalogue in code.
 *
 * The screen renders its options from src/shared/drafting.ts. The create
 * handler validates against the TABLE — "Not a service we offer" comes from a
 * SELECT. So the two must agree, and with sixty-odd services no one is going
 * to keep two hand-written lists in step.
 *
 *   npx tsx scripts/drafting-catalogue-sql.ts > db/migrations/00NN_name.sql
 *
 * It prints; it does not execute. A migration is a reviewable artefact with a
 * checksum, and a script that silently reshaped the catalogue in production
 * would be a worse problem than the drift it fixed.
 *
 * Existing rows are left alone apart from their label, so a price edited in
 * Settings is not stamped back to the placeholder on the next deploy.
 */
import { DRAFTING_CATALOGUE } from '../src/shared/drafting.js';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const rows = DRAFTING_CATALOGUE.map((s, i) =>
  `  (${q(s.key)}, ${q(s.label)}, ${s.baseCents}, ${s.quoteRequired}, ` +
  `${s.turnaroundDays}, ${s.requiresSeal}, ${(i + 1) * 10})`,
).join(',\n');

process.stdout.write(`insert into ocs.drafting_services
  (service, label, base_cents, quote_required, typical_turnaround_days, requires_seal, sort_order)
values
${rows}
on conflict (service) do update
  set label = excluded.label,
      sort_order = excluded.sort_order;
`);
