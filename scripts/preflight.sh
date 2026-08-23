#!/usr/bin/env bash
#
# Everything that must be true before this ships.
#
# Written because "the tests pass" has not once been the whole story on this
# project. A stylesheet was deleted while its own build still referenced it and
# pushed; a type error shipped because the web app had no typechecker at all;
# a schema check reported a clean bill of health while Postgres was down and it
# had read an empty schema. Each of those passed `npm test`.
#
# So this runs the checks in the order that catches the most for the least
# waiting, and it FAILS LOUDLY rather than skipping. A check that cannot run is
# reported as a failure, never as a pass — that distinction is the whole point.
#
#   npm run preflight
#
set -uo pipefail

cd "$(dirname "$0")/.."

FAILED=()
run() {
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m  ✓ %s\033[0m\n' "$name"
  else
    printf '\033[31m  ✗ %s\033[0m\n' "$name"
    FAILED+=("$name")
  fi
}

# --- 1. Does it compile, on both sides of the wire? ----------------------------
run "server typecheck" npm run --silent typecheck
run "web typecheck"    npm run --silent typecheck --prefix web

# --- 2. Is a database actually reachable? -------------------------------------
# Asked separately and up front, because the suite SKIPS its database tests when
# the connection variables are absent and still reports success. A green run
# that silently tested none of the routes is the worst outcome here.
check_db() {
  if [ -z "${TEST_DATABASE_URL:-}" ]; then
    echo "  TEST_DATABASE_URL is not set, so every database-backed test would" >&2
    echo "  SKIP and the suite would still report success. Set it, or run" >&2
    echo "  preflight through the harness that does." >&2
    return 1
  fi
  node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    c.connect()
      .then(() => c.query("select count(*)::int as n from information_schema.tables where table_schema=$1", ["ocs"]))
      .then((r) => {
        const n = r.rows[0].n;
        if (n < 10) throw new Error(`only ${n} tables in schema ocs — migrations have not been applied`);
        console.log(`  ${n} tables in schema ocs`);
        return c.end();
      })
      .catch((e) => { console.error("  " + e.message); process.exit(1); });
  '
}
run "database reachable and migrated" check_db

# --- 3. The suite --------------------------------------------------------------
run "tests" npm run --silent test

# --- 4. Build, then check the shell against what the build wrote ----------------
# In that order. The build rewrites app.html with new content hashes, so
# checking integrity first would check the previous build's answer.
run "web build" npm run --silent build --prefix web
run "app shell references files that exist" node -e '
  const fs = require("fs");
  const html = fs.readFileSync("public/app.html", "utf8");
  const refs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
  if (refs.length === 0) throw new Error("app.html references no assets at all");
  const missing = refs.filter((r) => !fs.existsSync("public/" + r));
  if (missing.length) throw new Error("app.html points at missing files: " + missing.join(", "));
  console.log("  " + refs.join(", "));
'

# --- 5. Say what is not configured, without ever reading a value ---------------
# Read from the SOURCE via tsx, not from dist/. The first version imported
# ./dist/config/env.js and swallowed the failure with "build dist/ first;
# skipping" — a step that reports success while having checked nothing, which
# is the exact failure this whole script exists to prevent.
config_gaps() {
  # DATABASE_URL only so src/config/env.ts will load; the value is never read
  # or printed by this step. Preflight already proved the connection above.
  DATABASE_URL="${DATABASE_URL:-${TEST_DATABASE_URL:-}}" npx --yes tsx scripts/config-gaps.ts
}
run "configuration gaps" config_gaps

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32m\033[1mpreflight passed\033[0m\n'
  exit 0
fi
printf '\033[31m\033[1mpreflight FAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
