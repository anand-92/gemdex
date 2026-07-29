import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, BrainCircuitIcon } from 'lucide-react';
import { PageShell } from '../components/PageShell';
import { usePool } from '../lib/pool';

export function CreateMemory() {
  const navigate = useNavigate();
  const { createMemory } = usePool();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createMemory({ title, content });
      navigate('/');
    } catch (err) {
      console.error('Failed to create memory:', err);
      setError(err instanceof Error ? err.message : 'Failed to create memory');
      setSaving(false);
    }
  };

  return (
    <PageShell
      title="New memory"
      eyebrow="Write to the pool"
      maxWidth={680}
      actions={
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-pill border border-edge bg-white/[0.03] px-2.5 text-[11.5px] leading-none text-ink-muted transition-colors hover:border-edge-strong hover:text-ink"
        >
          <ArrowLeftIcon size={12} aria-hidden="true" />
          All memories
        </button>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <p className="rounded-card border border-danger/30 bg-danger/[0.08] px-3.5 py-2.5 text-[12px] text-danger">
            {error}
          </p>
        )}

        <label className="flex flex-col gap-2">
          <span className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
            Title (optional)
          </span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Derived from the content when left blank"
            className="surface h-10 rounded-card border border-edge px-3.5 text-[13.5px] text-ink shadow-card outline-none transition-shadow placeholder:text-ink-faint focus:border-edge-accent focus:shadow-glow"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
            Content
          </span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={16}
            required
            placeholder="What should be remembered across every repo, session, and machine?"
            className="surface resize-none rounded-card border border-edge p-4 font-mono text-[12px] leading-[1.75] text-ink-dim shadow-card outline-none transition-shadow placeholder:text-ink-faint focus:border-edge-accent focus:shadow-glow"
          />
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={!content.trim() || saving}
            className="flex h-9 items-center gap-2 rounded-card bg-accent px-4 text-[13px] font-semibold leading-none text-canvas shadow-glow transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:shadow-none"
          >
            <BrainCircuitIcon size={14} aria-hidden="true" />
            {saving ? 'Embedding…' : 'Save memory'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex h-9 items-center rounded-card border border-edge px-4 text-[13px] leading-none text-ink-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
          >
            Cancel
          </button>
        </div>

        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          Saving embeds the content, so it becomes recallable by meaning as well as by
          text.
        </p>
      </form>
    </PageShell>
  );
}
