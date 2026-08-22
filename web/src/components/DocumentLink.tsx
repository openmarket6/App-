import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, get } from '../lib/api.ts';

/**
 * Opens a stored document.
 *
 * It asks the API where the file is, not for the file. `GET /documents/:id/download`
 * performs the authorization check and the audit entry, then returns a short-lived
 * signed URL straight to object storage — so a 200 MB plan set never travels
 * through Node, which is rule 3 of `services/storage.ts` and also the reason a
 * job-site upload does not time out.
 *
 * The earlier version fetched `/documents/:id/content`. That route does not
 * exist and never did: verified against production on 22 Aug 2026, it returns
 * `404 No route for GET /api/documents/:id/content`, which means every document
 * link and every photo thumbnail in the product was broken. It was recorded in
 * `tests/route-coverage.test.ts` as a known gap with the note that the fix
 * belonged here rather than in a new endpoint. This is that fix.
 */
interface DownloadTarget {
  url: string;
  fileName: string;
  expiresInSeconds: number;
}

const downloadPath = (documentId: string) => `/documents/${documentId}/download`;

export default function DocumentLink({
  documentId,
  children,
  className = 'link text-[13px]',
}: {
  documentId: string;
  children: ReactNode;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setError(null);
    setLoading(true);
    try {
      // Fetched at click time, never cached: the signed URL is deliberately
      // short-lived, and a stale one fails in a way that reads as "the file is
      // gone" rather than "the link expired".
      const target = await get<DownloadTarget>(downloadPath(documentId));
      window.open(target.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open that file');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={open} disabled={loading}>
        {loading ? 'Opening…' : children}
      </button>
      {error && <span className="ml-2 text-[12px] text-danger">{error}</span>}
    </>
  );
}

/**
 * Thumbnail for an uploaded image.
 *
 * Same route, and the signed URL goes straight into `src` — the browser
 * fetches the bytes from storage itself. No bearer token is involved, so
 * nothing lands in browser history or a referrer header, and the API is not
 * asked to proxy an image.
 */
export function DocumentImage({
  documentId,
  alt,
  className = '',
}: {
  documentId: string;
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);

    get<DownloadTarget>(downloadPath(documentId))
      .then((target) => {
        if (!cancelled) setSrc(target.url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (failed) {
    return (
      <div className={`grid place-items-center bg-page text-[11px] text-ink-mute ${className}`}>
        Preview unavailable
      </div>
    );
  }

  if (!src) {
    return <div className={`bg-page animate-pulse ${className}`} aria-hidden />;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
