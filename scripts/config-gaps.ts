/**
 * What is not configured, in sentences.
 *
 * Prints the NAMES of missing settings and never a value. A script that echoes
 * secrets to a terminal — or into CI output — is its own problem.
 *
 * The import is dynamic and guarded because src/config/env.ts refuses to load
 * at all when a required variable is absent. That refusal is right: a server
 * that boots without a database is worse than one that will not boot. But a
 * script whose entire job is to report on configuration should report that,
 * not exit with a stack trace and leave whoever ran it guessing whether the
 * check passed.
 */
async function main(): Promise<void> {
  let env: typeof import('../src/config/env.js');
  try {
    env = await import('../src/config/env.js');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('  configuration could not be read at all:');
    for (const line of message.split('\n').slice(1)) {
      if (line.trim()) console.log(`  ${line.trim()}`);
    }
    console.log('  Nothing below this line was checked.');
    process.exitCode = 1;
    return;
  }

  const gaps = env.missingIntegrations();
  if (gaps.length === 0) {
    console.log('  nothing missing');
    return;
  }
  console.log('  unconfigured — not failures, but know them before go-live:');
  for (const gap of gaps) console.log(`    · ${gap}`);
}

void main();
