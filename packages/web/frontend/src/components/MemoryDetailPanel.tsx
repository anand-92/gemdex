import React, { useEffect, useState } from 'react';
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileJson2Icon,
  FolderGit2Icon,
  GitBranchIcon,
  PencilLineIcon,
  TargetIcon,
  Trash2Icon,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from '../api';
import type { Memory } from '../data/memories';
import { memoryTitle } from '../data/memories';
import { GemdexMark } from './GemdexMark';
import { SourceBadge } from './SourceBadge';
import { formatBytes, formatCount, fullDate, relativeTime } from '../lib/format';

interface MemoryDetailPanelProps {
  memory: Memory | null;
  poolTotal: number;
  onRequestDelete: () => void;
  onSave: (input: { title: string; content: string }) => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
      {children}
    </h3>
  );
}

function MetaTile({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="surface flex min-w-0 items-center gap-2.5 rounded-card border border-edge px-3 py-2.5 shadow-card">
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-edge bg-white/[0.04] text-ink-muted"
      >
        <Icon size={13} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
          {label}
        </span>
        <span
          className="truncate font-mono text-[11.5px] leading-none text-ink-dim"
          title={value}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

export function MemoryDetailPanel({
  memory,
  poolTotal,
  onRequestDelete,
  onSave,
}: MemoryDetailPanelProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setCopied(false);
  }, [memory?.id]);

  if (!memory) {
    return (
      <section className="flex h-full min-w-0 flex-1 flex-col">
        <div className="h-14 shrink-0 border-b border-edge" />
        <div className="flex flex-1 items-center justify-center px-8">
          <div className="flex max-w-[280px] flex-col items-center gap-3 text-center">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-card border border-edge bg-white/[0.03] text-ink-faint"
            >
              <GemdexMark size={20} />
            </span>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Select a memory to read it here, or press{' '}
              <span className="font-mono text-ink-dim">↑↓</span> to browse the pool.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const startEditing = () => {
    setDraftTitle(memory.title ?? '');
    setDraftContent(memory.content);
    setEditing(true);
  };

  const submitEdit = () => {
    setSaving(true);
    onSave({ title: draftTitle, content: draftContent });
    setSaving(false);
    setEditing(false);
  };

  const copyId = () => {
    navigator.clipboard?.writeText(memory.id).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section aria-label="Memory detail" className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-edge px-6">
        <button
          type="button"
          onClick={copyId}
          title="Copy memory id"
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-pill border border-edge bg-white/[0.02] px-2.5 font-mono text-[10.5px] leading-none text-ink-faint transition-colors hover:border-edge-strong hover:text-ink-muted"
        >
          {copied ? (
            <CheckIcon size={11} aria-hidden="true" className="shrink-0 text-ok" />
          ) : (
            <CopyIcon size={11} aria-hidden="true" className="shrink-0" />
          )}
          <span className="truncate">{memory.id}</span>
        </button>

        {!editing && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={startEditing}
              className="flex h-7 items-center gap-1.5 rounded-pill border border-edge bg-white/[0.03] px-2.5 text-[11.5px] leading-none text-ink-muted transition-colors hover:border-edge-strong hover:bg-white/[0.06] hover:text-ink"
            >
              <PencilLineIcon size={12} aria-hidden="true" />
              Edit
            </button>
            <button
              type="button"
              onClick={onRequestDelete}
              className="flex h-7 items-center gap-1.5 rounded-pill border border-danger/30 bg-danger/[0.08] px-2.5 text-[11.5px] leading-none text-danger transition-all hover:bg-danger/[0.16] hover:shadow-glow-danger"
            >
              <Trash2Icon size={12} aria-hidden="true" />
              Delete
            </button>
          </div>
        )}
      </div>

      <motion.div
        key={memory.id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-6 py-5"
      >
        <header className="flex shrink-0 flex-col gap-3">
          {editing ? (
            <label className="flex flex-col gap-2">
              <SectionLabel>Title</SectionLabel>
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="surface w-full rounded-card border border-edge px-3.5 py-2.5 text-[19px] font-semibold text-ink outline-none transition-shadow focus:border-edge-accent focus:shadow-glow"
              />
            </label>
          ) : (
            <h2 className="display text-[26px] leading-[1.2] text-ink">
              {memoryTitle(memory)}
            </h2>
          )}

          {!editing && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceBadge source={memory.source} variant="full" />
                {typeof memory.score === 'number' && (
                  <span className="tabular flex h-[22px] items-center gap-1.5 rounded-pill border border-edge-ok bg-ok/[0.08] px-2.5 font-mono text-[10.5px] leading-none text-ok">
                    <TargetIcon size={10} aria-hidden="true" />
                    {memory.score.toFixed(3)}
                  </span>
                )}
                <span className="flex h-[22px] items-center rounded-pill border border-edge bg-white/[0.03] px-2.5 font-mono text-[10.5px] leading-none text-ink-muted">
                  updated {relativeTime(memory.updatedAt)}
                </span>
                <span className="flex h-[22px] items-center rounded-pill border border-edge bg-white/[0.03] px-2.5 font-mono text-[10.5px] leading-none text-ink-muted">
                  created {fullDate(memory.createdAt)}
                </span>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <MetaTile icon={BotIcon} label="agent" value={memory.source} />
                <MetaTile
                  icon={FolderGit2Icon}
                  label="repo"
                  value={memory.repo ?? '—'}
                />
                <MetaTile
                  icon={GitBranchIcon}
                  label="branch"
                  value={memory.branch ?? '—'}
                />
              </div>
            </>
          )}
        </header>

        {editing ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <SectionLabel>Content</SectionLabel>
            <textarea
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              aria-label="Content"
              className="surface min-h-[200px] flex-1 resize-none rounded-card border border-edge p-4 font-mono text-[12px] leading-[1.75] text-ink-dim outline-none transition-shadow focus:border-edge-accent focus:shadow-glow"
            />

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={submitEdit}
                disabled={saving}
                className="flex h-8 items-center rounded-card bg-accent px-3.5 text-[12.5px] font-semibold leading-none text-canvas shadow-glow-sm transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {saving ? 'Re-embedding…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="flex h-8 items-center rounded-card border border-edge px-3.5 text-[12.5px] leading-none text-ink-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
              >
                Cancel
              </button>
              <p className="text-[11px] text-ink-faint">
                Editing content re-embeds the memory, which changes how it is recalled.
              </p>
            </div>
          </div>
        ) : (
          <div className="surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-edge shadow-card">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-edge px-4">
              <SectionLabel>Content</SectionLabel>
              <span className="tabular font-mono text-[9.5px] uppercase leading-none tracking-[0.14em] text-ink-faint">
                {formatCount(memory.content.length)} chars · embedded
              </span>
            </div>
            <pre className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 font-mono text-[12px] leading-[1.75] text-ink-dim whitespace-pre-wrap">
              {memory.content}
            </pre>
          </div>
        )}

        {!editing && memory.attachments.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2">
            <SectionLabel>Attachments</SectionLabel>
            <ul className="flex flex-col gap-1.5">
              {memory.attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="surface flex items-center gap-3 rounded-card border border-edge px-3 py-2.5 shadow-card transition-colors hover:border-edge-strong"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-edge-warn bg-warn/[0.10] text-warn"
                  >
                    <FileJson2Icon size={13} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate font-mono text-[11.5px] leading-none text-ink-dim">
                      {attachment.caption}
                    </span>
                    <span className="tabular truncate font-mono text-[10px] leading-none text-ink-faint">
                      {attachment.kind} · {attachment.mimeType} ·{' '}
                      {formatBytes(attachment.byteSize)}
                    </span>
                  </span>
                  <a
                    href={api.attachmentUrl(memory.id, attachment.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-7 shrink-0 items-center rounded-pill border border-edge bg-white/[0.03] px-2.5 text-[11.5px] leading-none text-ink-muted transition-colors hover:border-edge-accent hover:text-accent"
                  >
                    View
                  </a>
                  <a
                    href={api.attachmentUrl(memory.id, attachment.id, true)}
                    download
                    aria-label={`Download ${attachment.caption}`}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill border border-edge bg-white/[0.03] text-ink-muted transition-colors hover:border-edge-accent hover:text-accent"
                  >
                    <DownloadIcon size={13} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!editing && (
          <p className="shrink-0 font-mono text-[9.5px] uppercase leading-none tracking-[0.14em] text-ink-faint">
            selected from {formatCount(poolTotal)} memories · ↑↓ to browse
          </p>
        )}
      </motion.div>
    </section>
  );
}
