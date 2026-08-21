/**
 * Supabase Storage.
 *
 * Design rules, and why:
 *
 *  1. Buckets are PRIVATE. Nothing is served from a public URL. Approved plans,
 *     licenses and site photos are customer property; a public bucket means a
 *     guessed or leaked path is a permanent, unauthenticated download.
 *
 *  2. The database stores (bucket, key) -- never a URL. URLs are minted per
 *     request and expire in minutes, so access is re-authorised every time
 *     instead of being frozen into a row that outlives the permission.
 *
 *  3. Uploads go browser -> Supabase directly via a signed upload URL. Large
 *     drawing sets never stream through this API, so a 200 MB upload cannot
 *     occupy an API process or blow its memory.
 *
 *  4. Every object key begins with the owning company id. If a key is ever
 *     mishandled, it is at least attributable, and a storage-level policy can
 *     enforce the prefix as a second line of defence.
 */
import { env, storageConfigured } from '../config/env.js';
import { requestWithRetry } from '../lib/http.js';
import { serviceUnavailable, badRequest, internalError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const BUCKET = env.SUPABASE_STORAGE_BUCKET;

function base(): string {
  if (!storageConfigured || !env.SUPABASE_URL) {
    throw serviceUnavailable('File storage is not configured on this server');
  }
  return `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1`;
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    'content-type': 'application/json',
  };
}

/**
 * Strip anything that could escape the intended prefix or confuse the storage
 * backend. Path traversal in an object key is how one tenant's upload lands in
 * another tenant's prefix.
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^\w.\- ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : 'file';
}

export function buildStorageKey(params: {
  companyId: string;
  documentId: string;
  versionNumber: number;
  fileName: string;
}): string {
  return [
    params.companyId,
    params.documentId,
    String(params.versionNumber),
    sanitizeFileName(params.fileName),
  ].join('/');
}

export interface SignedUpload {
  bucket: string;
  key: string;
  /** Absolute URL the browser PUTs the file to. */
  uploadUrl: string;
  token: string;
  expiresInSeconds: number;
}

export async function createSignedUploadUrl(key: string): Promise<SignedUpload> {
  const res = await requestWithRetry(
    `${base()}/object/upload/sign/${BUCKET}/${encodeURI(key)}`,
    { method: 'POST', headers: headers(), body: JSON.stringify({}) },
    // Safe to retry: signing is idempotent and creates no object.
    { retryUnsafeMethod: true, attempts: 3, timeoutMs: 10_000, label: 'storage.sign_upload' },
  );

  if (!res.ok) {
    logger.error({ status: res.status, key }, 'failed to create signed upload url');
    throw internalError({ status: res.status });
  }

  const parsed = JSON.parse(res.body) as { url?: string; token?: string };
  if (!parsed.url) throw internalError('storage did not return an upload url');

  const url = parsed.url.startsWith('http') ? parsed.url : `${base()}${parsed.url}`;
  const token = parsed.token ?? new URL(url).searchParams.get('token') ?? '';

  return { bucket: BUCKET, key, uploadUrl: url, token, expiresInSeconds: 3600 };
}

/**
 * Short-lived download URL.
 *
 * Default 300s: long enough to click through and download, short enough that a
 * link pasted into a chat or logged by a proxy is dead before it is useful.
 */
export async function createSignedDownloadUrl(
  key: string,
  opts: { expiresInSeconds?: number; downloadAs?: string } = {},
): Promise<{ url: string; expiresInSeconds: number }> {
  const expiresIn = Math.min(opts.expiresInSeconds ?? 300, 3600);

  const body: Record<string, unknown> = { expiresIn };
  if (opts.downloadAs) body['transform'] = undefined;

  const res = await requestWithRetry(
    `${base()}/object/sign/${BUCKET}/${encodeURI(key)}`,
    { method: 'POST', headers: headers(), body: JSON.stringify(body) },
    { retryUnsafeMethod: true, attempts: 3, timeoutMs: 10_000, label: 'storage.sign_download' },
  );

  if (res.status === 404) throw badRequest('Stored file is missing');
  if (!res.ok) {
    logger.error({ status: res.status, key }, 'failed to create signed download url');
    throw internalError({ status: res.status });
  }

  const parsed = JSON.parse(res.body) as { signedURL?: string; signedUrl?: string };
  const signed = parsed.signedURL ?? parsed.signedUrl;
  if (!signed) throw internalError('storage did not return a signed url');

  let url = signed.startsWith('http') ? signed : `${base()}${signed}`;
  if (opts.downloadAs) {
    url += `${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(opts.downloadAs)}`;
  }

  return { url, expiresInSeconds: expiresIn };
}

export interface ObjectInfo {
  size: number;
  contentType: string;
  lastModified: string | null;
}

/**
 * Confirm an object really landed, and how big it actually is.
 *
 * The client tells us the size it intends to upload, but the client is not
 * trustworthy about it. This is the authoritative reading, taken after upload,
 * and it is what gets written to document_versions.byte_size.
 */
export async function headObject(key: string): Promise<ObjectInfo | null> {
  const res = await requestWithRetry(
    `${base()}/object/info/${BUCKET}/${encodeURI(key)}`,
    { method: 'GET', headers: headers() },
    { attempts: 3, timeoutMs: 10_000, label: 'storage.head' },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    logger.warn({ status: res.status, key }, 'object info lookup failed');
    return null;
  }

  const parsed = JSON.parse(res.body) as {
    size?: number;
    contentType?: string;
    mimetype?: string;
    updated_at?: string;
    lastModified?: string;
  };

  return {
    size: parsed.size ?? 0,
    contentType: parsed.contentType ?? parsed.mimetype ?? 'application/octet-stream',
    lastModified: parsed.updated_at ?? parsed.lastModified ?? null,
  };
}

export async function deleteObject(key: string): Promise<boolean> {
  const res = await requestWithRetry(
    `${base()}/object/${BUCKET}/${encodeURI(key)}`,
    { method: 'DELETE', headers: headers() },
    // Deleting an already-deleted object is a no-op, so retrying is safe.
    { retryUnsafeMethod: true, attempts: 3, timeoutMs: 10_000, label: 'storage.delete' },
  );

  if (res.status === 404) return true;
  if (!res.ok) {
    logger.error({ status: res.status, key }, 'failed to delete storage object');
    return false;
  }
  return true;
}

/**
 * Content types accepted for upload.
 *
 * An allow-list, not a block-list: enumerating what construction documents
 * actually are is finite and reviewable, whereas enumerating every dangerous
 * type is a game you lose. Note this is a guard rail, not a security boundary --
 * the client declares the type, so malware scanning still applies.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
  'application/zip',
  'image/vnd.dwg',
  'application/acad',
  'application/dxf',
  'image/vnd.dxf',
]);

export function assertAllowedContentType(contentType: string): void {
  if (!ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase())) {
    throw badRequest(`Files of type "${contentType}" are not accepted`);
  }
}
