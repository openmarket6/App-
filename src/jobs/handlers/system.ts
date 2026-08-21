/**
 * Housekeeping jobs: reaping, cleanup, webhook retries, reconciliation and
 * document purging.
 *
 * Unglamorous, and the reason the system stays correct over months rather than
 * days. Each one addresses a way state quietly rots: work abandoned by a dead
 * worker, tables that grow forever, webhooks that failed once and were never
 * looked at again, payments nobody matched to a bank statement.
 */
import { withServiceContext } from '../../db/tenant.js';
import { reapStuckJobs, enqueue } from '../queue.js';
import { registerHandler } from '../runner.js';
import { deleteObject } from '../../services/storage.js';
import { storageConfigured, env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

async function reap(): Promise<unknown> {
  const reaped = await reapStuckJobs();
  return { reaped };
}

async function cleanupIdempotency(): Promise<unknown> {
  return withServiceContext(
    async (tx) => {
      const res = await tx.query(
        `delete from ocs.idempotency_keys where expires_at < now()`,
      );
      return { deleted: res.rowCount ?? 0 };
    },
    { reason: 'cleanup_idempotency' },
  );
}

/**
 * Re-drive webhooks that failed to process.
 *
 * A Stripe event we received but could not apply means our records disagree
 * with the provider's -- an invoice may be paid in Stripe and unpaid here.
 * Stripe stops retrying after a while, so this is our own safety net.
 */
async function retryFailedWebhooks(): Promise<unknown> {
  const stuck = await withServiceContext(
    async (tx) =>
      tx.many<{ id: string; provider: string; event_type: string; attempts: number }>(
        `select id, provider, event_type, attempts
           from ocs.webhook_events
          where status = 'failed'
            and attempts < 10
            and received_at > now() - interval '7 days'
          order by received_at asc
          limit 50`,
      ),
    { reason: 'find_failed_webhooks' },
  );

  let requeued = 0;
  for (const event of stuck) {
    await withServiceContext(
      async (tx) => {
        const id = await enqueue(tx, {
          jobType: 'payments.process_webhook',
          payload: { webhookEventId: event.id },
          dedupeKey: `webhook:${event.id}`,
          maxAttempts: 3,
        });
        if (id) requeued++;
      },
      { reason: 'requeue_webhook' },
    );
  }

  if (stuck.length > 0) {
    logger.warn({ failed: stuck.length, requeued }, 'requeued failed webhook events');
  }
  return { failed: stuck.length, requeued };
}

/**
 * Flag succeeded payments that were never reconciled.
 *
 * This does not reconcile automatically -- matching a payout to a bank
 * statement needs a person and the bank's own data. What it does is make the
 * gap visible, so unreconciled money cannot sit unnoticed for months.
 */
async function reconcilePayments(): Promise<unknown> {
  return withServiceContext(
    async (tx) => {
      const rows = await tx.many<{ count: string; oldest: string | null }>(
        `select count(*)::text,
                min(succeeded_at)::text as oldest
           from ocs.payments
          where status = 'succeeded'
            and reconciled_at is null
            and succeeded_at < now() - interval '7 days'`,
      );

      const first = rows[0];
      const count = Number(first?.count ?? 0);

      if (count > 0) {
        logger.warn(
          { unreconciled: count, oldest: first?.oldest },
          'payments awaiting reconciliation for more than 7 days',
        );
      }
      return { unreconciled: count, oldest: first?.oldest ?? null };
    },
    { reason: 'reconcile_payments' },
  );
}

/**
 * Hard-delete storage objects for documents past their retention window.
 *
 * Deleting the storage object FIRST, then the row, is the deliberate ordering.
 * If the storage call fails we keep the row and try again next run; the object
 * is orphaned only briefly. The reverse order would lose the key on failure and
 * leave a file nobody can find or delete, forever.
 */
async function purgeDeletedDocuments(): Promise<unknown> {
  if (!storageConfigured) {
    logger.info('storage not configured; skipping document purge');
    return { skipped: true };
  }

  const expired = await withServiceContext(
    async (tx) =>
      tx.many<{ document_id: string; version_id: string; storage_key: string }>(
        `select d.id as document_id, v.id as version_id, v.storage_key
           from ocs.documents d
           join ocs.document_versions v on v.document_id = d.id
          where d.deleted_at is not null
            and d.purge_after is not null
            and d.purge_after < now()
          limit 200`,
      ),
    { reason: 'find_purgeable_documents' },
  );

  let purged = 0;
  let failed = 0;

  for (const item of expired) {
    const ok = await deleteObject(item.storage_key);
    if (!ok) {
      failed++;
      continue;
    }

    await withServiceContext(
      async (tx) => {
        await tx.query(`delete from ocs.document_versions where id = $1`, [item.version_id]);
        // Remove the document row only once its last version is gone.
        await tx.query(
          `delete from ocs.documents d
            where d.id = $1
              and not exists (select 1 from ocs.document_versions v where v.document_id = d.id)`,
          [item.document_id],
        );
      },
      { reason: 'purge_document' },
    );
    purged++;
  }

  if (purged > 0 || failed > 0) {
    logger.info({ purged, failed, retentionDays: env.DOCUMENT_RETENTION_DAYS }, 'document purge complete');
  }
  return { purged, failed };
}

export function register(): void {
  registerHandler('system.reap_stuck_jobs', reap);
  registerHandler('system.cleanup_idempotency', cleanupIdempotency);
  registerHandler('system.retry_failed_webhooks', retryFailedWebhooks);
  registerHandler('payments.reconcile', reconcilePayments);
  registerHandler('documents.purge_expired', purgeDeletedDocuments);
}
