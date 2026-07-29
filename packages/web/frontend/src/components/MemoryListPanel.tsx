import React from 'react';
import {
  FolderSearchIcon,
  ListFilterIcon,
  PaperclipIcon,
  ScanSearchIcon,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { Memory } from '../data/memories';
import { memoryTitle } from '../data/memories';
import { SourceBadge } from './SourceBadge';
import { formatCount, relativeTime } from '../lib/format';

export type SearchMode = 'filter' | 'recall';

interface MemoryListPanelProps {
  memories: Memory[];
  mode: SearchMode;
  query: string;
  poolTotal: number;
  loadedTotal: number;
  selectedId: string | null;
  isRecalling: boolean;
  scanning: boolean;
  onModeChange: (mode: SearchMode) => void;
  onQueryChange: (query: string) => void;
  onRecall: () => void;
  onSelect: (id: string) => void;
  onScan: () => void;
  onCreate: () => void;
  listRef: React.RefObject<HTMLUListElement | null>;
}

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  {
    value: 'filter',
    label: 'Filter',
    hint: 'Literal substring match over title and preview',
  },
  {
    value: 'recall',
    label: 'Recall',
    hint: 'Semantic search — finds related meaning, not exact words',
  },
];

export function MemoryListPanel({
  memories,
  mode,
  query,
  poolTotal,
  loadedTotal,
  selectedId,
  isRecalling,
  scanning,
  onModeChange,
  onQueryChange,
  onRecall,
  onSelect,
  onScan,
  onCreate,
  listRef,
}: MemoryListPanelProps) {
  const isRecall = mode === 'recall';
  const hasQuery = query.trim().length > 0;
  const remaining = Math.max(0, poolTotal - loadedTotal);

  const countLine = () => {
    if (isRecall && memories.length && hasQuery) {
      return `${memories.length} semantic ${memories.length === 1 ? 'match' : 'matches'}`;
    }
    if (hasQuery) {
      return `${formatCount(memories.length)} of ${formatCount(poolTotal)} match`;
    }
    return `${formatCount(poolTotal)} memories`;
  };

  return (
    <section
      aria-label="Memory pool"
      className="flex h-full w-[384px] shrink-0 flex-col border-r border-edge"
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-edge px-5">
        <h1 className="display truncate text-[17px] leading-none text-ink">
          Memory pool
        </h1>
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          title="Look for new agent sessions on this machine to digest"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-pill border border-edge bg-white/[0.03] px-2.5 text-[11.5px] leading-none text-ink-muted transition-colors hover:border-edge-accent hover:bg-accent/[0.08] hover:text-accent disabled:opacity-60"
        >
          <FolderSearchIcon
            size={12}
            aria-hidden="true"
            className={scanning ? 'animate-pulse text-accent' : undefined}
          />
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
        <div
          role="radiogroup"
          aria-label="Search mode"
          className="flex h-8 items-center gap-1 self-start rounded-pill border border-edge bg-black/40 p-[3px]"
        >
          {MODES.map(({ value, label, hint }) => {
            const active = mode === value;
            const Icon = value === 'filter' ? ListFilterIcon : ScanSearchIcon;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onModeChange(value)}
                title={hint}
                className="relative flex h-full items-center rounded-pill px-3"
              >
                {active && (
                  <motion.span
                    layoutId="mode-pill"
                    transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                    className="absolute inset-0 rounded-pill bg-accent shadow-glow-sm"
                  />
                )}
                <span
                  className={[
                    'relative z-10 flex items-center gap-1.5 text-[12px] font-medium leading-none',
                    active ? 'text-canvas' : 'text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  <Icon size={12} aria-hidden="true" />
                  {label}
                </span>
              </button>
            );
          })}
        </div>

        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (isRecall) onRecall();
          }}
          className="flex flex-col gap-2"
        >
          <div className="surface flex h-10 items-center gap-2.5 rounded-card border border-edge px-3 shadow-card transition-shadow focus-within:border-edge-accent focus-within:shadow-glow">
            {isRecall ? (
              <ScanSearchIcon
                size={14}
                aria-hidden="true"
                className="shrink-0 text-accent"
              />
            ) : (
              <ListFilterIcon
                size={14}
                aria-hidden="true"
                className="shrink-0 text-ink-faint"
              />
            )}
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              aria-label={isRecall ? 'Recall memories' : 'Filter memories'}
              placeholder={
                isRecall ? 'Describe what you need…' : 'Filter by title or preview…'
              }
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />

            {!hasQuery && (
              <kbd className="shrink-0 rounded-[6px] border border-edge bg-white/[0.04] px-1.5 py-[1px] font-mono text-[10px] leading-[1.4] text-ink-faint">
                /
              </kbd>
            )}
          </div>
          {isRecall && (
            <button
              type="submit"
              disabled={!hasQuery || isRecalling}
              className="flex h-8 items-center self-start rounded-card bg-accent px-3.5 text-[12px] font-semibold leading-none text-canvas shadow-glow-sm transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:shadow-none"
            >
              {isRecalling ? 'Embedding query…' : 'Recall'}
            </button>
          )}
        </form>

        <div className="flex items-center justify-between gap-2">
          <p
            aria-live="polite"
            className="tabular font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-ink-faint"
          >
            {countLine()}
          </p>
          <span
            className={[
              'font-mono text-[10px] uppercase leading-none tracking-[0.14em]',
              isRecall ? 'text-iris' : 'text-ink-faint',
            ].join(' ')}
          >
            {isRecall ? 'vector' : 'literal'}
          </span>
        </div>

        {memories.length === 0 ? (
          <div className="surface-soft flex flex-col items-center gap-3 rounded-card border border-dashed border-edge px-5 py-8 text-center">
            <p className="text-[13px] text-ink-dim">
              {hasQuery ? 'Nothing matched.' : 'No memories yet.'}
            </p>
            <button
              type="button"
              onClick={onCreate}
              className="flex h-7 items-center rounded-pill border border-edge-accent bg-accent/[0.08] px-3 text-[12px] leading-none text-accent transition-colors hover:bg-accent/[0.16]"
            >
              Create one
            </button>
          </div>
        ) : (
          <ul
            ref={listRef}
            className="-mr-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-2"
          >
            {memories.map((memory, index) => {
              const selected = memory.id === selectedId;
              return (
                <motion.li
                  key={memory.id}
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(index * 0.016, 0.12) }}
                >
                  <button
                    type="button"
                    data-memory-row={memory.id}
                    onClick={() => onSelect(memory.id)}
                    aria-current={selected}
                    className={[
                      'group relative w-full overflow-hidden rounded-card border px-3 py-2.5 text-left transition-all duration-200',
                      selected
                        ? 'surface border-edge-accent shadow-glow'
                        : 'border-edge bg-white/[0.02] hover:border-edge-strong hover:bg-white/[0.04]',
                    ].join(' ')}
                  >
                    {selected && (
                      <>
                        <motion.span
                          layoutId="row-marker"
                          transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                          className="absolute bottom-2 left-0 top-2 w-[2px] rounded-pill bg-accent shadow-glow-sm"
                        />
                        <span
                          aria-hidden="true"
                          className="absolute -right-10 -top-10 h-24 w-24 rounded-full bg-[radial-gradient(circle,rgba(108,140,255,0.2),transparent_65%)]"
                        />
                      </>
                    )}

                    <div className="relative flex items-center gap-2">
                      <SourceBadge source={memory.source} />
                      <span className="tabular ml-auto shrink-0 font-mono text-[10px] leading-none text-ink-faint">
                        {relativeTime(memory.updatedAt)}
                      </span>
                    </div>

                    <p
                      className={[
                        'relative mt-2 truncate text-[13px] font-medium leading-snug',
                        selected ? 'text-ink' : 'text-ink-dim group-hover:text-ink',
                      ].join(' ')}
                    >
                      {memoryTitle(memory)}
                    </p>
                    <p className="relative mt-1 truncate font-mono text-[10.5px] leading-snug text-ink-faint">
                      {memory.preview ?? '—'}
                    </p>

                    {(memory.attachments.length > 0 ||
                      typeof memory.score === 'number') && (
                      <div className="relative mt-2 flex items-center gap-1.5">
                        {typeof memory.score === 'number' && (
                          <span className="tabular flex h-[18px] items-center rounded-pill border border-edge-ok bg-ok/[0.08] px-1.5 font-mono text-[10px] leading-none text-ok">
                            {memory.score.toFixed(3)}
                          </span>
                        )}
                        {memory.attachments.length > 0 && (
                          <span className="tabular flex h-[18px] items-center gap-1 rounded-pill border border-edge bg-white/[0.03] px-1.5 font-mono text-[10px] leading-none text-ink-muted">
                            <PaperclipIcon size={9} aria-hidden="true" />
                            {memory.attachments.length}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                </motion.li>
              );
            })}
          </ul>
        )}

        {memories.length > 0 && remaining > 0 && !hasQuery && (
          <div className="shrink-0">
            <div className="hairline mb-2" />
            <p className="tabular text-center font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-ink-faint">
              <span className="text-accent">{formatCount(remaining)}</span> more in the
              pool
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
