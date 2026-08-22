import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, getBlobUrl } from '../lib/api.ts';

/**
 * Opens a stored document.
 *
 * Not an `<a href>`: the content route authenticates with a bearer token, and
 * a plain link sends none, so it would 401 for everybody. The bytes are pulled
 * through the API client and handed to the browser as an object URL, which
 * also means a shared cache never sees one contractor's file.
 */
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
  const urls = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );

  async function open() {
    setError(null);
    setLoading(true);
    try {
      const url = await getBlobUrl(`/documents/${documentId}/content`);
      urls.current.push(url);
      window.open(url, '_blank', 'noopener');
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
 * Thumbnail for an uploaded image. Same reasoning as above — the src has to be
 * an object URL, because an authenticated GET is the only way to these bytes.
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
    let created: string | null = null;

    getBlobUrl(`/documents/${documentId}/content`)
      .then((url) => {
        created = url;
        if (cancelled) URL.revokeObjectURL(url);
        else setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
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

  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
