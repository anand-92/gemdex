import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClockIcon, SquareTerminalIcon, TriangleAlertIcon } from 'lucide-react';
import type { HygieneStatus, IngestHistoryPage } from '../api';
import { api } from '../api';
import { PageShell } from '../components/PageShell';
import { SourceBadge } from '../components/SourceBadge';
import { formatCount, relativeTime, truncatePath } from '../lib/format';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
      {children}
    </h2>
  );
}

export function IngestHistory() {
  const [data, setData] = useState<IngestHistoryPage | null>(null);
  const [hygiene, setHygiene] = useState<HygieneStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [historyRes, hygieneRes] = await Promise.all([
          api.ingestHistory({ limit: 100 }),
          api.hygieneStatus(),
        ]);
        if (active) {
          setData(historyRes);
          setHygiene(hygieneRes);
        }
      } catch (err) {
        console.error('Failed to load ingest history:', err);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const totalIngested = data?.total ?? 0;
  const poolTotal = data?.poolTotal ?? 0;
  const sessions = data?.sessions ?? [];
  const sources = data?.sources ?? [];
  const repos = data?.repos ?? [];
  const repoMax = repos[0]?.sessions ?? 1;

  return (
    <PageShell title="History" eyebrow="Provenance" maxWidth={840}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          <span className="tabular font-mono text-ink">
            {formatCount(totalIngested)}
          </span>{' '}
          of{' '}
          <span className="tabular font-mono text-ink">{formatCount(poolTotal)}</span>{' '}
          memories came from ingested coding sessions.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => (
            <span
              key={s.source}
              className="surface flex h-7 items-center gap-2 rounded-pill border border-edge px-3 text-[11.5px] leading-none text-ink-muted shadow-card"
            >
              {s.label}
              <span className="tabular font-mono text-[11.5px] font-semibold text-ink">
                {s.sessions}
              </span>
            </span>
          ))}
        </div>
      </div>

      <p className="flex items-start gap-2.5 rounded-card border border-edge bg-white/[0.02] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-muted">
        <ClockIcon size={13} aria-hidden="true" className="mt-[3px] shrink-0 text-accent" />
        {data?.timestampMeaning ||
          'Times are when the coding session itself happened, not when it was ingested.'}
      </p>

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Busiest repos</SectionLabel>
        {repos.length === 0 ? (
          <p className="surface-soft rounded-card border border-edge px-4 py-3 text-[12px] text-ink-faint">
            {loading ? 'Loading repos…' : 'No repo history recorded.'}
          </p>
        ) : (
          <ul className="surface divide-y divide-edge overflow-hidden rounded-card border border-edge shadow-card">
            {repos.map((r) => (
              <li
                key={r.repo}
                className="flex h-10 items-center gap-4 px-4 transition-colors hover:bg-white/[0.02]"
              >
                <code
                  title={r.repo}
                  className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim"
                >
                  {truncatePath(r.repo, 46)}
                </code>
                <span
                  aria-hidden="true"
                  className="hidden h-1 w-28 shrink-0 overflow-hidden rounded-pill bg-white/[0.06] sm:block"
                >
                  <span
                    className="block h-full rounded-pill bg-accent"
                    style={{ width: `${Math.max(8, (r.sessions / repoMax) * 100)}%` }}
                  />
                </span>
                <span className="tabular w-5 shrink-0 text-right font-mono text-[11px] text-ink-muted">
                  {r.sessions}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Sessions</SectionLabel>
        {sessions.length === 0 ? (
          <p className="surface-soft rounded-card border border-dashed border-edge px-4 py-8 text-center text-[12.5px] text-ink-muted">
            {loading ? (
              'Loading sessions…'
            ) : (
              <>
                No ingested sessions yet. Upload transcripts on the{' '}
                <Link to="/upload" className="text-accent hover:underline">
                  upload page
                </Link>
                , or run{' '}
                <code className="font-mono text-ink-dim">npx gemdex sync-history</code>.
              </>
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sessions.map((session) => (
              <li key={session.memoryId}>
                <Link
                  to="/"
                  className="surface group flex flex-col gap-1.5 rounded-card border border-edge px-3.5 py-2.5 shadow-card transition-colors hover:border-edge-strong"
                >
                  <span className="flex items-center gap-2">
                    <SourceBadge source={session.sourceLabel} />
                    <span className="tabular ml-auto shrink-0 font-mono text-[10px] leading-none text-ink-faint">
                      {session.lastActiveAt
                        ? `active ${relativeTime(session.lastActiveAt)}`
                        : ''}
                    </span>
                  </span>
                  <span className="truncate text-[13px] font-medium leading-snug text-ink-dim group-hover:text-ink">
                    {session.title || 'Untitled session'}
                  </span>
                  <span className="truncate font-mono text-[10.5px] leading-none text-ink-faint">
                    {session.repo ? `${session.repo}${session.branch ? ` (${session.branch})` : ''}` : 'No repo context'}
                    {session.hasTranscript ? ' · transcript saved' : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4 border-t border-edge pt-6">
        <div className="flex items-baseline gap-2.5">
          <h2 className="display text-[17px] leading-none text-ink">Memory hygiene</h2>
          <span className="font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-ink-faint">
            Maintenance
          </span>
        </div>

        <p className="flex items-start gap-2.5 rounded-card border border-edge-warn bg-warn/[0.05] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-muted">
          <TriangleAlertIcon
            size={13}
            aria-hidden="true"
            className="mt-[3px] shrink-0 text-warn"
          />
          {hygiene?.reason ||
            'Hygiene clustering reads per-memory vectors directly from a local store. Run a pass locally instead.'}
        </p>

        {hygiene?.protections && hygiene.protections.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <SectionLabel>What protects this pool today</SectionLabel>
            <ul className="grid gap-1.5 sm:grid-cols-3">
              {hygiene.protections.map((item) => (
                <li
                  key={item.title}
                  className="surface flex flex-col gap-2 rounded-card border border-edge px-3.5 py-3 shadow-card"
                >
                  <span
                    className={[
                      'flex h-[18px] w-fit items-center rounded-pill border px-2 font-mono text-[9.5px] uppercase leading-none tracking-[0.12em]',
                      item.state === 'active' || item.state === 'active on save'
                        ? 'border-edge-ok bg-ok/[0.08] text-ok'
                        : 'border-edge bg-white/[0.04] text-ink-muted',
                    ].join(' ')}
                  >
                    {item.state}
                  </span>
                  <span className="text-[12.5px] font-medium leading-snug text-ink">
                    {item.title}
                  </span>
                  <span className="text-[11px] leading-relaxed text-ink-muted">
                    {item.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {hygiene?.howToRun?.options && hygiene.howToRun.options.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <SectionLabel>Running a hygiene pass</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {hygiene.howToRun.options.map((option) => (
                <div
                  key={option.label}
                  className="surface flex flex-col gap-2 rounded-card border border-edge px-3.5 py-3 shadow-card"
                >
                  <span className="text-[12.5px] leading-snug text-ink-dim">
                    {option.label}: {option.detail}
                  </span>
                  {option.command && (
                    <pre className="flex h-9 items-center gap-2 overflow-x-auto rounded-[10px] border border-edge bg-black/50 px-3 font-mono text-[11.5px] text-accent">
                      <SquareTerminalIcon size={12} aria-hidden="true" className="shrink-0" />
                      <code>{option.command}</code>
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </PageShell>
  );
}
