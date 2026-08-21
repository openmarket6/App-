/**
 * Idempotency.
 *
 * These assert the property that stops a double-tapped Pay button from becoming
 * two charges: the same key runs the operation exactly once, however many times
 * it arrives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, seedTwoTenants, ALPHA, ALPHA_USER } from './helpers/db.js';
import { withTenant } from '../src/db/tenant.js';
import { withIdempotency } from '../src/lib/idempotency.js';
import { AppError } from '../src/lib/errors.js';

const describeIfDb = dbConfigured ? describe : describe.skip;
const ctx = { companyId: ALPHA, userId: ALPHA_USER, platformRole: 'none' as const };

describeIfDb('idempotency', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  it('runs the operation once and replays the stored response', async () => {
    const key = `test-${Date.now()}-a`;
    let executions = 0;

    const first = await withTenant(ctx, (tx) =>
      withIdempotency(
        tx,
        { companyId: ALPHA, endpoint: 'POST /test', key, body: { amount: 100 } },
        async () => {
          executions++;
          return { status: 201, body: { charged: true, id: 'pay_1' } };
        },
      ),
    );

    const second = await withTenant(ctx, (tx) =>
      withIdempotency(
        tx,
        { companyId: ALPHA, endpoint: 'POST /test', key, body: { amount: 100 } },
        async () => {
          executions++;
          return { status: 201, body: { charged: true, id: 'pay_2' } };
        },
      ),
    );

    // The operation ran once. The second call got the first result back
    // verbatim -- not a second charge, and not an error the client must handle.
    expect(executions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual({ charged: true, id: 'pay_1' });
  });

  it('rejects a key reused with a different body', async () => {
    const key = `test-${Date.now()}-b`;

    await withTenant(ctx, (tx) =>
      withIdempotency(
        tx,
        { companyId: ALPHA, endpoint: 'POST /test', key, body: { amount: 100 } },
        async () => ({ status: 201, body: { ok: true } }),
      ),
    );

    // Silently replaying here would hide a genuine client bug: the caller
    // thinks it sent a $500 charge and got back the result of a $100 one.
    await expect(
      withTenant(ctx, (tx) =>
        withIdempotency(
          tx,
          { companyId: ALPHA, endpoint: 'POST /test', key, body: { amount: 500 } },
          async () => ({ status: 201, body: { ok: true } }),
        ),
      ),
    ).rejects.toThrow(/already used with a different request body/i);
  });

  it('allows a retry after the operation failed', async () => {
    const key = `test-${Date.now()}-c`;
    let attempts = 0;

    await expect(
      withTenant(ctx, (tx) =>
        withIdempotency(
          tx,
          { companyId: ALPHA, endpoint: 'POST /test', key, body: { x: 1 } },
          async () => {
            attempts++;
            throw new AppError(500, 'boom', 'upstream failed');
          },
        ),
      ),
    ).rejects.toThrow();

    // A failed attempt must not permanently burn the key -- otherwise a
    // transient provider error leaves the customer unable to ever retry.
    const retry = await withTenant(ctx, (tx) =>
      withIdempotency(
        tx,
        { companyId: ALPHA, endpoint: 'POST /test', key, body: { x: 1 } },
        async () => {
          attempts++;
          return { status: 201, body: { ok: true } };
        },
      ),
    );

    expect(attempts).toBe(2);
    expect(retry.body).toEqual({ ok: true });
  });

  it('scopes keys per company', async () => {
    // Two tenants using the same key string must not collide -- keys are
    // client-chosen and "payment-1" is not exotic.
    const key = `shared-${Date.now()}`;
    let runs = 0;

    await withTenant(ctx, (tx) =>
      withIdempotency(
        tx,
        { companyId: ALPHA, endpoint: 'POST /test', key, body: {} },
        async () => {
          runs++;
          return { status: 201, body: { tenant: 'alpha' } };
        },
      ),
    );

    const beta = await withTenant(
      { companyId: '22222222-2222-2222-2222-222222222222', userId: ALPHA_USER, platformRole: 'none' },
      (tx) =>
        withIdempotency(
          tx,
          {
            companyId: '22222222-2222-2222-2222-222222222222',
            endpoint: 'POST /test',
            key,
            body: {},
          },
          async () => {
            runs++;
            return { status: 201, body: { tenant: 'beta' } };
          },
        ),
    );

    expect(runs).toBe(2);
    expect(beta.replayed).toBe(false);
    expect(beta.body).toEqual({ tenant: 'beta' });
  });
});
