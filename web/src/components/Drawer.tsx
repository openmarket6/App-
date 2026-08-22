import { useEffect, type ReactNode } from 'react';

/**
 * Right-hand slide-over. Used where opening a full page would lose the list
 * you were scanning — jurisdiction detail, permit preview, credential edit.
 */
export default function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = '620px',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-navy/30" onClick={onClose} aria-hidden />
      <div
        className="relative h-full bg-white border-l border-line shadow-xl flex flex-col max-w-full"
        style={{ width }}
      >
        <div className="flex items-start gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight truncate">{title}</div>
            {subtitle && <div className="mt-0.5 text-[13px] text-ink-soft truncate">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} className="btn-ghost shrink-0 px-2 py-1" aria-label="Close">
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3 bg-page">{footer}</div>}
      </div>
    </div>
  );
}
