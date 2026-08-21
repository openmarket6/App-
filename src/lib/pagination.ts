/**
 * Keyset ("cursor") pagination.
 *
 * Offset pagination is wrong for feeds that change while being read: inserting
 * a row shifts every later page, so a client walking pages silently skips
 * records. Keyset paginates on (created_at, id), which is stable regardless of
 * concurrent writes.
 *
 * The cursor is opaque base64 -- not to hide anything, but so its shape can
 * change later without breaking clients that stored one.
 */
import { z } from 'zod';
import { badRequest } from './errors.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('malformed');
    }
    return parsed;
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Callers fetch limit+1 rows; the extra row is the "is there more" signal and
 * is trimmed here rather than requiring a second COUNT query.
 */
export function buildPage<T extends { id: string; created_at: string | Date }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            createdAt:
              last.created_at instanceof Date
                ? last.created_at.toISOString()
                : String(last.created_at),
            id: last.id,
          })
        : null,
  };
}
