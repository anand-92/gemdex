import { useRef, useState } from 'react';
import { FileJson2Icon, HardDriveUploadIcon, XIcon } from 'lucide-react';
import { api } from '../api';
import { PageShell } from '../components/PageShell';
import { formatBytes, pluralize } from '../lib/format';

interface QueuedFile {
  id: string;
  file: File;
  name: string;
  size: number;
}

type ResultStatus = 'saved' | 'skipped' | 'failed';

interface UploadResult {
  name: string;
  status: ResultStatus;
  detail: string;
}

const STATUS_STYLES: Record<ResultStatus, string> = {
  saved: 'border-edge-ok bg-ok/[0.08] text-ok',
  skipped: 'border-edge bg-white/[0.04] text-ink-muted',
  failed: 'border-danger/30 bg-danger/[0.08] text-danger',
};

export function UploadSessions() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files).map((file, index) => ({
      id: `${file.name}-${index}-${Date.now()}`,
      file,
      name: file.name,
      size: file.size,
    }));
    setQueue((current) => [...current, ...next]);
    setResults(null);
    setError(null);
  };

  const upload = async () => {
    if (!queue.length) return;
    setDigesting(true);
    setError(null);
    try {
      const fileObjects = queue.map((q) => q.file);
      const res = await api.uploadSessions(fileObjects);
      const mappedResults: UploadResult[] = res.results.map((r) => {
        let status: ResultStatus = 'saved';
        if (r.status === 'skipped') status = 'skipped';
        if (r.status === 'failed') status = 'failed';
        return {
          name: r.filename || 'unknown',
          status,
          detail: r.detail || (r.status === 'ingested' ? 'Digested into a new memory' : r.status),
        };
      });
      setResults(mappedResults);
      setQueue([]);
    } catch (err) {
      console.error('Failed to upload sessions:', err);
      setError(err instanceof Error ? err.message : 'Failed to upload sessions');
    } finally {
      setDigesting(false);
    }
  };

  const counts = results
    ? results.reduce<Record<ResultStatus, number>>(
        (acc, result) => ({ ...acc, [result.status]: acc[result.status] + 1 }),
        { saved: 0, skipped: 0, failed: 0 }
      )
    : null;

  return (
    <PageShell title="Upload sessions" eyebrow="Ingest" maxWidth={760}>
      <p className="max-w-[64ch] text-[13px] leading-relaxed text-ink-muted">
        Drop agent transcripts here and the deployment digests each one into a memory, so
        past sessions become recallable from every machine.
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        className={[
          'relative flex flex-col items-center gap-2.5 overflow-hidden rounded-card border border-dashed px-6 py-10 text-center transition-all duration-200',
          dragging
            ? 'border-edge-accent bg-accent/[0.07] shadow-glow'
            : 'surface-soft border-edge',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="absolute -top-24 left-1/2 h-48 w-72 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(108,140,255,0.14),transparent_65%)]"
        />

        <span
          aria-hidden="true"
          className="relative flex h-11 w-11 items-center justify-center rounded-card border border-edge-accent bg-accent/[0.10] text-accent shadow-glow-sm"
        >
          <HardDriveUploadIcon size={18} />
        </span>
        <p className="relative text-[13.5px] leading-none text-ink">
          Drop session files here
        </p>
        <p className="relative font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-ink-faint">
          .jsonl or .zip
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="relative mt-1 flex h-8 items-center rounded-pill border border-edge bg-white/[0.04] px-3.5 text-[12px] leading-none text-ink-dim transition-colors hover:border-edge-accent hover:text-accent"
        >
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jsonl,.zip"
          className="hidden"
          onChange={(event) => addFiles(event.target.files)}
        />
      </div>

      {queue.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {queue.map((file) => (
            <div
              key={file.id}
              className="surface flex h-11 items-center gap-3 rounded-card border border-edge px-3 shadow-card"
            >
              <FileJson2Icon
                size={14}
                aria-hidden="true"
                className="shrink-0 text-ink-faint"
              />
              <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
                {file.name}
              </code>
              <span className="tabular shrink-0 font-mono text-[10.5px] text-ink-faint">
                {formatBytes(file.size)}
              </span>
              <button
                type="button"
                onClick={() =>
                  setQueue((current) => current.filter((item) => item.id !== file.id))
                }
                aria-label={`Remove ${file.name}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-edge text-ink-muted transition-colors hover:border-danger/40 hover:text-danger"
              >
                <XIcon size={11} aria-hidden="true" />
              </button>
            </div>
          ))}

          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={upload}
              disabled={digesting}
              className="flex h-9 items-center rounded-card bg-accent px-4 text-[13px] font-semibold leading-none text-canvas shadow-glow transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {digesting ? 'Digesting…' : `Upload ${pluralize(queue.length, 'session')}`}
            </button>
            <button
              type="button"
              onClick={() => setQueue([])}
              className="flex h-9 items-center rounded-card border border-edge px-4 text-[13px] leading-none text-ink-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {digesting && (
        <p
          aria-live="polite"
          className="flex items-center gap-2.5 rounded-card border border-edge-warn bg-warn/[0.06] px-3.5 py-2.5 text-[12px] text-warn"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 animate-pulse-ring rounded-full bg-warn"
          />
          Digesting sessions — one model call each, so this can take a while…
        </p>
      )}

      {error && (
        <p className="rounded-card border border-danger/30 bg-danger/[0.08] px-3.5 py-2.5 text-[12px] text-danger">
          {error}
        </p>
      )}

      {results && counts && (
        <section className="flex flex-col gap-2.5">
          <h2 className="display text-[15px] leading-none text-ink">
            {counts.saved} ingested, {counts.skipped} skipped, {counts.failed} failed
          </h2>
          <ul className="flex flex-col gap-1.5">
            {results.map((result) => (
              <li
                key={result.name}
                className={[
                  'surface flex h-11 items-center gap-3 rounded-card border px-3 shadow-card',
                  result.status === 'failed' ? 'border-danger/30' : 'border-edge',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-[18px] shrink-0 items-center rounded-pill border px-2 font-mono text-[9.5px] uppercase leading-none tracking-[0.12em]',
                    STATUS_STYLES[result.status],
                  ].join(' ')}
                >
                  {result.status}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
                  {result.name}
                </code>
                <span className="hidden shrink-0 text-[11px] text-ink-faint sm:block">
                  {result.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11.5px] leading-relaxed text-ink-faint">
        Transcripts usually live in{' '}
        <code className="font-mono text-ink-muted">~/.claude/projects</code>,{' '}
        <code className="font-mono text-ink-muted">~/.codex/sessions</code>, and{' '}
        <code className="font-mono text-ink-muted">~/.factory/sessions</code>.
      </p>
    </PageShell>
  );
}
