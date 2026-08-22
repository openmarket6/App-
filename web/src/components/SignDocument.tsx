import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SIGNABLE_LABELS, type SignableKind } from '@flph/shared';
import { get, post } from '../lib/api.ts';
import Drawer from './Drawer.tsx';
import ErrorState from './ErrorState.tsx';
import { LoadingPanel } from './Spinner.tsx';

/**
 * Where a contractor actually signs.
 *
 * Everything else about signing existed -- the templates, the verdict, the
 * staff screen that sends the request -- and there was nowhere for the person
 * being asked to sign to do it. The portal listed "waiting for your signature"
 * and linked to a page with no signing on it.
 *
 * The shape of this drawer is dictated by what has to be provable afterwards.
 * E-SIGN and Florida's UETA make an electronic signature as enforceable as ink
 * if you can show intent, presentment, and integrity, and each of the three is
 * a piece of UI here rather than a checkbox on the server:
 *
 *   PRESENTMENT is why the document text is fetched and rendered in full
 *   rather than summarised or linked. Fetching it is also what records that it
 *   was opened, at the moment it was opened.
 *
 *   ...AND why the signing controls stay disabled until the reader reaches the
 *   end of the text. A signature applied to a document the signer never
 *   scrolled through is the weakest kind of evidence, and the scroll listener
 *   costs nothing.
 *
 *   INTENT is the typed name plus an unticked consent box. Both are deliberate
 *   acts. Pre-ticking the consent would make it worthless -- E-SIGN requires
 *   consent to transact electronically be affirmative.
 *
 *   INTEGRITY is the server's job: it re-hashes the stored text at the moment
 *   of signing. Nothing here can affect it, which is the point.
 */
interface SignatureDetail {
  id: string;
  kind: SignableKind;
  status: string;
  renderedBody: string;
  renderedHash: string;
  signerEmail: string;
  signedAt: string | null;
}

export default function SignDocument({
  requestId,
  open,
  onClose,
}: {
  requestId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [typedName, setTypedName] = useState('');
  const [consent, setConsent] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);

  const detailQ = useQuery({
    queryKey: ['signing', 'request', requestId],
    // Fetching is what records presentment, so it must not be cached across
    // opens: a stale hit would mean the document was never actually served.
    gcTime: 0,
    staleTime: 0,
    enabled: open && !!requestId,
    queryFn: () => get<SignatureDetail>(`/signing/requests/${requestId}`),
  });

  // A fresh drawer is a fresh act of signing. Carrying a typed name or a
  // ticked consent from the previous document over to this one would attach
  // somebody's deliberate act to a document they have not looked at.
  useEffect(() => {
    if (!open) return;
    setTypedName('');
    setConsent(false);
    setReadToEnd(false);
  }, [open, requestId]);

  /*
   * A document short enough to need no scrolling has already been read to the
   * end the moment it renders. Without this the controls would stay disabled
   * with no way for the signer to enable them.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el || !detailQ.data) return;
    if (el.scrollHeight - el.clientHeight <= 8) setReadToEnd(true);
  }, [detailQ.data]);

  const sign = useMutation({
    mutationFn: () =>
      post(`/signing/requests/${requestId}/sign`, {
        typedName: typedName.trim(),
        consentToElectronicSignature: true,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['signing'] });
      onClose();
    },
  });

  const doc = detailQ.data;
  const alreadySigned = doc?.status === 'SIGNED';
  const ready = readToEnd && consent && typedName.trim().length >= 2 && !alreadySigned;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="760px"
      title={doc ? SIGNABLE_LABELS[doc.kind] : 'Agreement'}
      subtitle={
        alreadySigned
          ? `Signed ${doc?.signedAt ? new Date(doc.signedAt).toLocaleDateString() : ''}`
          : 'Read the whole agreement, then sign at the bottom.'
      }
    >
      {detailQ.isLoading && <LoadingPanel label="Loading the agreement…" rows={6} />}
      {detailQ.isError && (
        <ErrorState
          error={detailQ.error}
          onRetry={() => void detailQ.refetch()}
          title="Could not load the agreement"
        />
      )}

      {doc && (
        <div className="space-y-4">
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReadToEnd(true);
            }}
            className="max-h-[46vh] overflow-y-auto rounded-md border border-line bg-white px-4 py-3 text-[13px] leading-relaxed"
            /*
             * The body is HTML this system rendered from a template in our own
             * source tree -- it is not user input and never has been. It is
             * inserted rather than iframed so the text is selectable, printable
             * and searchable, which a signer reading an agreement will want.
             */
            dangerouslySetInnerHTML={{ __html: doc.renderedBody }}
          />

          {!readToEnd && !alreadySigned && (
            <p className="text-[12px] text-ink-mute">
              Scroll to the end of the agreement to enable signing.
            </p>
          )}

          {alreadySigned ? (
            <p className="text-[13px] text-ink-soft">
              This agreement has been signed. A copy stays on your account.
            </p>
          ) : (
            <div className="space-y-3 border-t border-line pt-4">
              <label className="flex items-start gap-2 text-[13px] leading-snug">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  disabled={!readToEnd}
                />
                <span>
                  I agree to sign this document electronically, and I understand that my
                  electronic signature has the same legal effect as a handwritten one.
                </span>
              </label>

              <div>
                <label className="block text-[12px] text-ink-soft mb-1" htmlFor="typed-name">
                  Type your full legal name to sign
                </label>
                <input
                  id="typed-name"
                  className="input w-full"
                  value={typedName}
                  disabled={!readToEnd}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder="Your full name"
                  autoComplete="off"
                />
              </div>

              {sign.isError && (
                <ErrorState error={sign.error} compact title="Could not record your signature" />
              )}

              <div className="flex items-center justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!ready || sign.isPending}
                  onClick={() => sign.mutate()}
                >
                  {sign.isPending ? 'Signing…' : 'Sign agreement'}
                </button>
              </div>

              <p className="text-[11px] text-ink-mute leading-snug">
                Your name, the date and time, your IP address and a fingerprint of this exact
                document are recorded with the signature. That fingerprint is what lets either
                side show later that the wording has not changed.
              </p>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
