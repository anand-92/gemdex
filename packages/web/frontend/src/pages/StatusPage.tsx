import { useEffect, useState } from 'react';
import { DatabaseZapIcon, KeyRoundIcon } from 'lucide-react';
import type { StatusInfo } from '../api';
import { api } from '../api';
import { PageShell } from '../components/PageShell';

interface StatusRow {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'muted' | 'mono';
}

const TONE_CLASSES: Record<string, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  muted: 'text-ink-muted',
  mono: 'font-mono text-[12px] text-ink-dim',
};

function StatusGrid({
  heading,
  icon: Icon,
  rows,
}: {
  heading: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  rows: StatusRow[];
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="flex items-center gap-2 font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
        <Icon size={12} aria-hidden="true" className="text-accent" />
        {heading}
      </h2>
      <dl className="surface divide-y divide-edge overflow-hidden rounded-card border border-edge shadow-card">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid gap-1 px-4 py-2.5 transition-colors hover:bg-white/[0.02] sm:grid-cols-[188px_minmax(0,1fr)] sm:items-baseline sm:gap-4"
          >
            <dt className="font-mono text-[10px] uppercase leading-none tracking-[0.12em] text-ink-faint">
              {row.label}
            </dt>
            <dd
              className={[
                'min-w-0 break-words text-[13px] leading-snug text-ink',
                row.tone ? TONE_CLASSES[row.tone] : '',
              ].join(' ')}
            >
              {row.tone === 'ok' ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-ok shadow-glow-ok"
                  />
                  {row.value}
                </span>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function StatusPage() {
  const [statusInfo, setStatusInfo] = useState<StatusInfo | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const info = await api.status();
        setStatusInfo(info);
      } catch (err) {
        console.error('Failed to fetch status:', err);
      }
    }
    load();
  }, []);

  const backendRows: StatusRow[] = statusInfo
    ? [
        {
          label: 'Connection',
          value: statusInfo.byoi.reachable ? 'Reachable' : 'Unreachable',
          tone: statusInfo.byoi.reachable ? 'ok' : 'warn',
        },
        { label: 'URL', value: statusInfo.byoi.url, tone: 'mono' },
        {
          label: 'Server',
          value: statusInfo.byoi.name
            ? `${statusInfo.byoi.name} ${statusInfo.byoi.serverVersion ?? ''}`
            : 'gemdex-server',
          tone: 'mono',
        },
        {
          label: 'API',
          value: `v${statusInfo.byoi.apiVersion ?? '1'} (protocol ${statusInfo.byoi.protocolVersion ?? 1})`,
          tone: 'mono',
        },
        {
          label: 'Storage mode',
          value: 'BYOI — server-side embedding, Postgres/pgvector',
        },
        {
          label: 'Capabilities',
          value: 'save · recall · delete · attachments · digest',
        },
      ]
    : [{ label: 'Connection', value: 'Loading status…', tone: 'muted' }];

  const appRows: StatusRow[] = statusInfo
    ? [
        {
          label: 'Login Mode',
          value: statusInfo.web.authMode,
          tone: statusInfo.web.authMode === 'dev' ? 'warn' : 'ok',
        },
        {
          label: 'Allowed Account',
          value: statusInfo.web.allowedEmail || 'None configured (dev / open)',
          tone: 'mono',
        },
        {
          label: 'Session Lifetime',
          value: `${Math.round(statusInfo.web.sessionTtlSeconds / 3600)} hours`,
        },
      ]
    : [{ label: 'Login Mode', value: 'Loading…', tone: 'muted' }];

  return (
    <PageShell title="Status" eyebrow="Deployment" maxWidth={760}>
      <StatusGrid heading="Memory backend" icon={DatabaseZapIcon} rows={backendRows} />
      <StatusGrid heading="This app" icon={KeyRoundIcon} rows={appRows} />
      <p className="text-[11.5px] leading-relaxed text-ink-faint">
        The memory backend token stays on the server. This browser never receives it.
      </p>
    </PageShell>
  );
}
