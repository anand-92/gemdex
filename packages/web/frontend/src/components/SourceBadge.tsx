import type { AgentSource } from '../data/memories';

const STYLES: Record<string, { chip: string; dot: string; short: string }> = {
  'Claude Code': {
    chip: 'border-edge-warn bg-warn/[0.08] text-warn',
    dot: 'bg-warn',
    short: 'claude',
  },
  Codex: {
    chip: 'border-edge-accent bg-accent/[0.10] text-accent',
    dot: 'bg-accent',
    short: 'codex',
  },
  Factory: {
    chip: 'border-iris/30 bg-iris/[0.10] text-iris',
    dot: 'bg-iris',
    short: 'factory',
  },
  Manual: {
    chip: 'border-edge bg-white/[0.04] text-ink-muted',
    dot: 'bg-ink-faint',
    short: 'manual',
  },
};

const DEFAULT_STYLE = {
  chip: 'border-edge bg-white/[0.04] text-ink-muted',
  dot: 'bg-ink-faint',
  short: 'ingested',
};

interface SourceBadgeProps {
  source: AgentSource;
  variant?: 'short' | 'full';
}

/** Sized to line up with the score / meta pills it sits beside. */
export function SourceBadge({ source, variant = 'short' }: SourceBadgeProps) {
  const style = STYLES[source] ?? {
    ...DEFAULT_STYLE,
    short: String(source).toLowerCase().slice(0, 8),
  };
  const isFull = variant === 'full';

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center rounded-pill border font-mono uppercase leading-none',
        isFull
          ? 'h-[22px] gap-1.5 px-2.5 text-[10.5px] tracking-[0.1em]'
          : 'h-[18px] gap-1.5 px-2 text-[9.5px] tracking-[0.12em]',
        style.chip,
      ].join(' ')}
    >
      <span aria-hidden="true" className={`h-1 w-1 shrink-0 rounded-full ${style.dot}`} />
      {isFull ? source : style.short}
    </span>
  );
}
