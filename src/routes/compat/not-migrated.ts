/**
 * Which product areas still answer 501, and why.
 *
 * This lives in a module of its own for one reason: tests/route-coverage.test.ts
 * needs it, and importing it from compat/api.ts drags in the whole route file,
 * which imports the database pool, which reads the environment. The result was
 * that the one static guard against a screen calling an address nobody serves
 * could not load without DATABASE_URL set -- so on any machine without a
 * database it did not fail, it simply never ran. A check that silently does
 * not run is worse than no check, because the green suite says it did.
 */
export const NOT_MIGRATED_AREAS = [
  'connectors',
  /*
   * Google Drive is not "not yet" — it is not happening.
   *
   * The connector was dropped from the product, and its screen and route are
   * gone with it. The 501 stays so anything still pointing here gets a clear
   * answer rather than a 404, but nobody should port this expecting it is
   * wanted: it is a decision, not a backlog item.
   */
  'google',
];
