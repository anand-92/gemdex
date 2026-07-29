import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ShieldAlertIcon } from 'lucide-react';

interface DeleteMemoryDialogProps {
  open: boolean;
  title: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteMemoryDialog({
  open,
  title,
  deleting,
  onCancel,
  onConfirm,
}: DeleteMemoryDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-md"
          onClick={onCancel}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-memory-heading"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
            className="surface relative w-full max-w-[420px] overflow-hidden rounded-card border border-edge p-5 shadow-modal"
          >
            <span
              aria-hidden="true"
              className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-[radial-gradient(circle,rgba(255,93,93,0.18),transparent_65%)]"
            />

            <div className="relative flex items-start gap-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-danger/30 bg-danger/[0.10] text-danger"
              >
                <ShieldAlertIcon size={17} />
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <h2
                  id="delete-memory-heading"
                  className="display text-[17px] leading-none text-ink"
                >
                  Delete this memory?
                </h2>
                <p className="truncate font-mono text-[11.5px] leading-none text-ink-dim">
                  {title}
                </p>
              </div>
            </div>

            <p className="relative mt-3.5 text-[12.5px] leading-relaxed text-ink-muted">
              This cannot be undone. The memory and its attachments are removed from the
              pool for every agent and every machine.
            </p>

            <div className="relative mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="flex h-9 items-center rounded-card border border-edge bg-white/[0.03] px-4 text-[12.5px] leading-none text-ink-muted transition-colors hover:bg-white/[0.07] hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={onConfirm}
                disabled={deleting}
                className="flex h-9 items-center rounded-card bg-danger px-4 text-[12.5px] font-semibold leading-none text-canvas shadow-glow-danger transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
