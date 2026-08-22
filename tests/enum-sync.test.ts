/**
 * Postgres enums and the TypeScript unions that name their values.
 *
 * These are two halves of one fact, maintained in two files, and they drift in
 * a particularly nasty way: adding a value to the union alone compiles fine and
 * fails at runtime with `invalid input value for enum`, which surfaces as a 500
 * on whatever action happened to use it first. The reverse — a value in the
 * database that no code knows about — is harmless but usually means somebody
 * abandoned a feature halfway.
 *
 * So the union is read out of the source and compared against what the database
 * actually has. Reading the real enum rather than a second hard-coded list is
 * the point; a third copy would just be a third thing to drift.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const describeIfDb = dbConfigured ? describe : describe.skip;

/** The string-literal members of a `export type X = 'a' | 'b';` declaration. */
async function unionMembers(file: string, typeName: string): Promise<string[]> {
  const src = await readFile(join(ROOT, file), 'utf8');
  const decl = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`).exec(src);
  if (!decl) throw new Error(`no exported type ${typeName} in ${file}`);
  return [...decl[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

async function enumValues(name: string): Promise<string[]> {
  const c = client(ownerUrl!);
  await c.connect();
  try {
    const { rows } = await c.query<{ value: string }>(
      `select e.enumlabel as value
         from pg_enum e
         join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'ocs' and t.typname = $1
        order by e.enumsortorder`,
      [name],
    );
    return rows.map((r) => r.value).sort();
  } finally {
    await c.end();
  }
}

const PAIRS: Array<{ file: string; type: string; enum: string }> = [
  {
    file: 'src/services/notifications.ts',
    type: 'NotificationKind',
    enum: 'notification_kind',
  },
];

describeIfDb('enums and the unions that name them', () => {
  for (const pair of PAIRS) {
    it(`${pair.type} matches ocs.${pair.enum}`, async () => {
      await applyMigrations();
      const inCode = await unionMembers(pair.file, pair.type);
      const inDb = await enumValues(pair.enum);

      const onlyInCode = inCode.filter((v) => !inDb.includes(v));
      const onlyInDb = inDb.filter((v) => !inCode.includes(v));

      expect(
        onlyInCode,
        `${pair.type} declares values ocs.${pair.enum} does not have: ` +
          `${onlyInCode.join(', ')}. This compiles and then fails at runtime with ` +
          '"invalid input value for enum". Add them in a migration.',
      ).toEqual([]);

      expect(
        onlyInDb,
        `ocs.${pair.enum} has values ${pair.type} does not: ${onlyInDb.join(', ')}. ` +
          'Harmless at runtime, but usually a half-finished feature — either use ' +
          'them or say in the migration why they are reserved.',
      ).toEqual([]);
    });
  }
});
