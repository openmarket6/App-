/**
 * Audit trail writes.
 *
 * Always called with the SAME transaction as the change being recorded. That is
 * the whole point: if the permit update commits, its audit row commits with it,
 * and if the update rolls back the audit row goes too. An audit log written on
 * a separate connection eventually disagrees with reality, and a log you cannot
 * trust is worse than none.
 *
 * ocs.audit_log grants only SELECT and INSERT (0008_rls.sql), so nothing in the
 * application can rewrite an entry after the fact.
 */
import type { Tx } from '../db/tenant.js';
import { logger } from './logger.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  actorUserId?: string | null;
  actorEmail?: string | null;
  companyId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Fields that must never be written into before/after snapshots, even though
 * they legitimately exist on the rows being audited.
 */
const SENSITIVE_KEYS = new Set([
  'secret_encrypted',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'secret',
  'card_number',
  'cvv',
]);

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  try {
    await tx.query(
      `insert into ocs.audit_log
         (company_id, actor_user_id, actor_email, action, entity_type, entity_id,
          summary, before_data, after_data, request_id, ip_address, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.companyId ?? null,
        entry.actorUserId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.summary ?? null,
        entry.before === undefined ? null : JSON.stringify(scrub(entry.before)),
        entry.after === undefined ? null : JSON.stringify(scrub(entry.after)),
        entry.requestId ?? null,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
      ],
    );
  } catch (err) {
    // Rethrow: a lost audit entry for a consequential action is itself a
    // problem, and the caller's transaction should fail rather than commit a
    // change nobody can later account for.
    logger.error({ err, action: entry.action }, 'failed to write audit entry');
    throw err;
  }
}
