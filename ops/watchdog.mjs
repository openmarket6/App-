#!/usr/bin/env node
/**
 * External watchdog for One Contractor Solutions.
 *
 * The premise: a system cannot be trusted to report on its own health. Three
 * things went undetected here precisely because the only observer was inside
 * the thing being observed --
 *
 *   1. Netlify's SPA fallback answers `/healthz` with HTML and HTTP 200, so an
 *      uptime monitor aimed at the app domain reports green during an outage.
 *   2. A failed Render build leaves the PREVIOUS deploy running with `/readyz`
 *      green, so "up" and "current" are different questions.
 *   3. The worker heartbeat was fresh while nothing had actually run for hours.
 *
 * So this runs somewhere else -- GitHub Actions, a Render cron, a scheduled
 * Cowork session -- and asks questions the system cannot answer about itself.
 *
 *   node ops/watchdog.mjs                     # human-readable
 *   node ops/watchdog.mjs --json              # machine-readable
 *
 * Exit codes: 0 clean, 1 critical findings, 2 the watchdog itself failed.
 *
 * Environment (all optional except the first two):
 *   API_ORIGIN       https://ocs-api-i654.onrender.com
 *   APP_ORIGIN       https://1contractorapp.netlify.app
 *   GITHUB_REPO      openmarket6/App-
 *   GITHUB_BRANCH    claude/ocs-migration-audit-phase-0-03a8qm
 *   GITHUB_TOKEN     raises the API rate limit; not required for a public repo
 *   DATABASE_SERVICE_URL  enables the direct database checks
 */

const API = (process.env.API_ORIGIN ?? 'https://ocs-api-i654.onrender.com').replace(/\/$/, '');
const APP = (process.env.APP_ORIGIN ?? 'https://1contractorapp.netlify.app').replace(/\/$/, '');
const REPO = process.env.GITHUB_REPO ?? 'openmarket6/App-';
const BRANCH = process.env.GITHUB_BRANCH ?? 'claude/ocs-migration-audit-phase-0-03a8qm';
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS ?? 20_000);

const findings = [];
const add = (severity, code, message, detail) =>
  findings.push({ severity, code, message, ...(detail ? { detail } : {}) });

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'ocs-watchdog', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON -- that is itself a signal, see checkProxyHonesty */
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, json };
}

/** Is the API up, and is it serving the commit we think it is? */
async function checkDeployFreshness() {
  let version;
  try {
    version = await get(`${API}/version`);
  } catch (err) {
    add('critical', 'api_unreachable', `${API}/version did not respond`, { error: String(err) });
    return null;
  }
  if (version.status !== 200 || !version.json?.commit) {
    add('critical', 'api_version_bad', `/version returned ${version.status}`, {
      body: version.text.slice(0, 200),
    });
    return null;
  }

  const tipUrl = `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`;
  try {
    const headers = process.env.GITHUB_TOKEN
      ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {};
    const tip = await get(tipUrl, headers);
    if (tip.status === 200 && tip.json?.sha) {
      if (tip.json.sha !== version.json.commit) {
        // This is the failure a green health check hides: the build failed and
        // the previous deploy is still serving, perfectly healthily.
        add('critical', 'deploy_stale', 'the API is not serving the branch tip', {
          serving: version.json.commit.slice(0, 12),
          branchTip: tip.json.sha.slice(0, 12),
          branch: BRANCH,
        });
      }
    } else {
      add('warn', 'github_unreachable', `could not read the branch tip (${tip.status})`);
    }
  } catch (err) {
    add('warn', 'github_unreachable', 'could not read the branch tip', { error: String(err) });
  }
  return version.json;
}

/** Does the public domain tell the truth about the backend? */
async function checkProxyHonesty() {
  for (const path of ['/version', '/readyz']) {
    try {
      const res = await get(`${APP}${path}`);
      if (!res.json) {
        add('critical', 'proxy_broken', `${APP}${path} is not reaching the API`, {
          status: res.status,
          contentType: res.contentType,
        });
      }
    } catch (err) {
      add('critical', 'proxy_broken', `${APP}${path} failed`, { error: String(err) });
    }
  }

  // Paths that are NOT proxied come back as the SPA shell with HTTP 200. Any
  // monitor pointed at them is permanently, silently green.
  for (const path of ['/healthz', '/healthz/queue', '/healthz/deep']) {
    try {
      const res = await get(`${APP}${path}`);
      if (res.status === 200 && res.contentType.includes('text/html')) {
        add(
          'warn',
          'monitor_trap',
          `${APP}${path} returns HTML 200 -- a monitor here would never alert`,
          { fix: 'add a Netlify proxy rule for /healthz* or point monitors at API_ORIGIN' },
        );
      }
    } catch {
      /* unreachable is fine here -- it is the false 200 we are hunting */
    }
  }
}

/** Is background work actually draining, or merely alive? */
async function checkWorker(apiVersion) {
  let deep;
  try {
    deep = await get(`${API}/healthz/deep`);
  } catch (err) {
    add('critical', 'deep_health_unreachable', '/healthz/deep did not respond', {
      error: String(err),
    });
    return;
  }

  if (deep.status === 404) {
    // Older deploys do not have it. Fall back rather than reporting a fault
    // that is really a version skew.
    const queue = await get(`${API}/healthz/queue`).catch(() => null);
    if (queue?.json && queue.json.worker?.alive !== true) {
      add('critical', 'worker_down', 'no worker is processing background jobs', queue.json.worker);
    }
    add('warn', 'watchdog_degraded', '/healthz/deep is not deployed yet; ran shallow checks only');
    return;
  }

  if (!deep.json) {
    add('critical', 'deep_health_bad', `/healthz/deep returned ${deep.status}`);
    return;
  }

  for (const alert of deep.json.alerts ?? []) {
    add(alert.severity === 'critical' ? 'critical' : 'warn', alert.code, describe(alert), alert.detail);
  }

  for (const s of deep.json.schedules ?? []) {
    if (s.overdue) {
      add('critical', 'schedule_overdue', `schedule "${s.name}" is past due`, {
        lastRunAt: s.last_run_at,
        nextRunAt: s.next_run_at,
        lastStatus: s.last_status,
      });
    } else if (s.last_status === 'deduped' && s.consecutive_failures >= 2) {
      add('critical', 'schedule_wedged', `schedule "${s.name}" cannot enqueue -- a previous run never finished`, {
        consecutiveFailures: s.consecutive_failures,
      });
    } else if (s.last_status === 'no_handler') {
      add('warn', 'schedule_no_handler', `schedule "${s.name}" has no registered handler and was disabled`);
    }
  }

  // API and worker are separate services on the same repo. They deploy
  // independently, so they can and do diverge -- and a worker running older
  // code against a newer schema is how a migration takes something down.
  if (apiVersion?.commit && deep.json.commit && deep.json.commit !== apiVersion.commit) {
    add('warn', 'commit_skew', 'API and deep-health commit disagree', {
      api: apiVersion.commit.slice(0, 12),
      health: String(deep.json.commit).slice(0, 12),
    });
  }
}

function describe(alert) {
  const d = alert.detail ?? {};
  switch (alert.code) {
    case 'worker_silent':
      return `the worker has not checked in since ${d.lastSeenAt ?? 'ever'}`;
    case 'jobs_stuck':
      return `${d.count} job(s) hold an expired lock (oldest ${d.oldestLockedFor})`;
    case 'jobs_dead':
      return `${d.count} job(s) exhausted their retries in the last 24h`;
    case 'permits_unchecked':
      return `${d.count} open permit(s) have not been checked against their agency in over 3 days`;
    case 'test_accounts_live':
      return `test accounts can still sign in: ${(d.emails ?? []).join(', ')}`;
    case 'invoice_payment_mismatch':
      return `${d.count} invoice(s) disagree with their recorded payments`;
    case 'uploads_abandoned':
      return `${d.count} upload(s) were started and never completed`;
    case 'refresh_tokens_bloat':
      return `${d.reclaimable} of ${d.total} refresh tokens are dead and uncollected`;
    case 'invites_stale':
      return `${d.count} invitation(s) older than 7 days are still redeemable`;
    default:
      return alert.code;
  }
}

/** Direct database checks, for the case where the API itself is the problem. */
async function checkDatabase() {
  const url = process.env.DATABASE_SERVICE_URL;
  if (!url) return;
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    add('warn', 'db_check_skipped', 'the pg package is not installed; skipped direct DB checks');
    return;
  }
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: true },
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query('select severity, code, detail from ocs.ops_alerts()');
    for (const r of rows) {
      add(r.severity === 'critical' ? 'critical' : 'warn', `db:${r.code}`, describe(r), r.detail);
    }
    // The one check that must not go through the API: does the app role still
    // lack RLS bypass? If DATABASE_URL is ever repointed at the superuser,
    // every row-level policy in the schema becomes decorative and nothing
    // else in the system would notice.
    const { rows: roles } = await client.query(
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('ocs_app','ocs_service')`,
    );
    for (const r of roles) {
      if (r.rolsuper || r.rolbypassrls) {
        add('critical', 'rls_bypassed', `role ${r.rolname} can bypass row-level security`);
      }
    }
  } catch (err) {
    add('warn', 'db_check_failed', 'direct database checks failed', { error: String(err) });
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const version = await checkDeployFreshness();
  await Promise.all([checkProxyHonesty(), checkWorker(version), checkDatabase()]);

  const critical = findings.filter((f) => f.severity === 'critical');
  const warn = findings.filter((f) => f.severity === 'warn');
  const report = {
    checkedAt: new Date().toISOString(),
    api: API,
    app: APP,
    serving: version?.commit ?? null,
    status: critical.length ? 'critical' : warn.length ? 'warn' : 'ok',
    findings,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`watchdog ${report.status.toUpperCase()}  ${report.checkedAt}`);
    console.log(`  serving ${report.serving?.slice(0, 12) ?? 'unknown'} on ${API}`);
    if (!findings.length) console.log('  no findings');
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
      if (f.detail) console.log(`      ${JSON.stringify(f.detail)}`);
    }
  }
  process.exit(critical.length ? 1 : 0);
}

main().catch((err) => {
  console.error('watchdog failed to run:', err);
  process.exit(2);
});
