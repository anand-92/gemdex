import React from 'react';
import { motion } from 'framer-motion';

interface PageShellProps {
  title: string;
  eyebrow: string;
  /** Optional element pinned to the right of the 56px top rail. */
  actions?: React.ReactNode;
  maxWidth?: number;
  children: React.ReactNode;
}

/**
 * Every route shares the same 56px top rail as the memory pool columns, so the
 * sidebar, list, and content headers all sit on one horizontal line.
 */
export function PageShell({
  title,
  eyebrow,
  actions,
  maxWidth = 800,
  children
}: PageShellProps) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-edge px-6">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="display truncate text-[17px] leading-none text-ink">{title}</h1>
          <span className="shrink-0 font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-ink-faint">
            {eyebrow}
          </span>
        </div>
        {actions}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          style={{ maxWidth }}
          className="mx-auto flex w-full flex-col gap-6">
          
          {children}
        </motion.div>
      </div>
    </main>);

}