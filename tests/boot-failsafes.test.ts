/**
 * Failsafes against silent failure.
 *
 * The worst outage this system has had was not an error. The background worker
 * crashed on boot because a required-config list demanded AUTH_JWT_SECRET from
 * a process that issues no tokens. Render reported the deploy "live" -- the
 * BUILD had succeeded -- and eleven scheduled jobs did not run for seventeen
 * hours. Every health check stayed green. Nothing anywhere said a word.
 *
 * These tests pin the three things that would each have caught it.
 */
import { describe, it, expect } from 'vitest';
import { missingIntegrations, assertApiConfig } from '../src/config/env.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

describe('required configuration belongs to the process that needs it', () => {
  it('does not demand auth secrets from every process', () => {
    /*
     * The exact bug. The shared boot check must not name the auth secrets:
     * the worker has no HTTP surface, issues no tokens, and has no health
     * check to reveal that it died refusing to start without them.
     */
    const env = readFileSync(join(SRC, 'config/env.ts'), 'utf8');
    const sharedCheck = env.slice(
      env.indexOf("if (env.NODE_ENV === 'production')"),
      env.indexOf('export function assertApiConfig'),
    );
    expect(sharedCheck).not.toContain("'AUTH_JWT_SECRET'");
    expect(sharedCheck).not.toContain("'AUTH_REFRESH_SECRET'");
  });

  it('still demands them of the API', () => {
    // Moving a requirement must not quietly delete it.
    const env = readFileSync(join(SRC, 'config/env.ts'), 'utf8');
    const apiCheck = env.slice(env.indexOf('export function assertApiConfig'));
    expect(apiCheck).toContain("'AUTH_JWT_SECRET'");
    expect(apiCheck).toContain("'AUTH_REFRESH_SECRET'");
  });

  it('is called by the API entrypoint and not by the worker', () => {
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).toContain('assertApiConfig()');
    expect(readFileSync(join(SRC, 'worker.ts'), 'utf8')).not.toContain('assertApiConfig()');
  });

  it('passes outside production without any secrets set', () => {
    // Tests run with NODE_ENV=test; this must not throw, or every test file
    // that imports src/ dies for a reason unrelated to what it is testing.
    expect(() => assertApiConfig()).not.toThrow();
  });
});

describe('an unconfigured integration announces itself', () => {
  it('names each one in words, not as a flag', () => {
    /*
     * An absent integration is the quietest degradation there is: nothing
     * errors, the feature simply never happens, and the first person to notice
     * is a customer who did not get their invitation.
     */
    const gaps = missingIntegrations();
    expect(Array.isArray(gaps)).toBe(true);
    for (const gap of gaps) {
      // Every line must say what stops working, not just what is missing.
      expect(gap, gap).toMatch(/—/);
      expect(gap.length, gap).toBeGreaterThan(40);
    }
  });

  it('covers email, payments, mail and the return address', () => {
    // Tests configure none of these, so all four must appear. A gap that stops
    // being reported when it is still missing is worse than no report.
    const gaps = missingIntegrations().join('\n');
    expect(gaps).toContain('RESEND_API_KEY');
    expect(gaps).toContain('STRIPE_SECRET_KEY');
    expect(gaps).toContain('LOB_API_KEY');
    expect(gaps).toContain('MAIL_RETURN_');
  });

  it('is announced at boot by both processes', () => {
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).toContain('missingIntegrations');
    expect(readFileSync(join(SRC, 'worker.ts'), 'utf8')).toContain('missingIntegrations');
  });
});

describe('background work is visible where somebody looks', () => {
  it('reports worker liveness and overdue schedules on the admin page', () => {
    /*
     * /healthz/queue said all of this and returned 503 for seventeen hours.
     * It was correct and nobody read it. A health endpoint nobody opens is not
     * a failsafe.
     */
    const admin = readFileSync(join(SRC, 'routes/compat/admin.ts'), 'utf8');
    expect(admin).toContain('worker_is_alive');
    expect(admin).toContain('overdueSchedules');
  });

  it('treats an alive worker with overdue schedules as a problem', () => {
    // The case /healthz/queue cannot see: checking in happily, running nothing.
    const admin = readFileSync(join(SRC, 'routes/compat/admin.ts'), 'utf8');
    expect(admin).toContain('running and not doing its work');
  });
});
