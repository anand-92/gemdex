import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MemoryDetail, MemorySummary } from '../api';
import { api } from '../api';
import type { AgentSource, Memory } from '../data/memories';

export type ScannerState = 'idle' | 'scanning' | 'done';

export function summaryToMemory(s: MemorySummary | MemoryDetail, detail?: MemoryDetail): Memory {
  let source: AgentSource = 'Manual';
  let repo: string | null = null;
  let branch: string | null = null;
  let sessionId: string | null = null;

  if (s.id.startsWith('chat:claude:')) {
    source = 'Claude Code';
    sessionId = s.id.replace('chat:claude:', '');
  } else if (s.id.startsWith('chat:codex:')) {
    source = 'Codex';
    sessionId = s.id.replace('chat:codex:', '');
  } else if (s.id.startsWith('chat:factory:')) {
    source = 'Factory';
    sessionId = s.id.replace('chat:factory:', '');
  } else if (s.id.startsWith('chat:')) {
    const parts = s.id.split(':');
    source = parts[1] ? (parts[1].charAt(0).toUpperCase() + parts[1].slice(1)) : 'Ingested';
    sessionId = parts.slice(2).join(':') || null;
  }

  const contentStr = detail?.content ?? ('content' in s && typeof s.content === 'string' ? s.content : null) ?? s.preview ?? '';

  if (s.preview) {
    const repoMatch = s.preview.match(/Repo:\s*([^\s(]+)(?:\s*\(([^)]+)\))?/);
    if (repoMatch) {
      repo = repoMatch[1] ?? null;
      branch = repoMatch[2] ?? null;
    }
  }

  const rawAttachments = detail?.attachments || ('attachments' in s && Array.isArray(s.attachments) ? s.attachments : []);

  return {
    id: s.id,
    title: s.title,
    preview: s.preview,
    content: contentStr,
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? Date.now(),
    source,
    repo,
    branch,
    sessionId,
    attachments: rawAttachments.map((a) => ({
      id: a.id,
      kind: a.kind ?? 'file',
      caption: a.caption ?? a.id,
      mimeType: a.mimeType ?? 'application/octet-stream',
      byteSize: a.byteSize ?? 0,
    })),
  };
}

interface PoolContextValue {
  memories: Memory[];
  poolTotal: number;
  scanner: ScannerState;
  scanFound: number;
  loading: boolean;
  error: string | null;
  startScan: () => void;
  createMemory: (input: { title: string; content: string }) => Promise<Memory>;
  updateMemory: (id: string, input: { title: string; content: string }) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  fetchMemories: (q?: string) => Promise<void>;
  fetchRecall: (query: string) => Promise<void>;
  fetchDetail: (id: string) => Promise<void>;
}

const PoolContext = createContext<PoolContextValue | null>(null);

export function PoolProvider({ children }: { children: React.ReactNode }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [poolTotal, setPoolTotal] = useState(0);
  const [scanner, setScanner] = useState<ScannerState>('idle');
  const [scanFound, setScanFound] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const fetchMemories = useCallback(async (q?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMemories(q ? { q, limit: 100 } : { limit: 100 });
      const mapped = res.memories.map((m) => summaryToMemory(m));
      setMemories(mapped);
      setPoolTotal(res.poolTotal);
    } catch (err) {
      console.error('Failed to fetch memories:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch memories');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRecall = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.recall(query, 20);
      const mapped = res.results
        .filter((r) => r.memory !== null)
        .map((r) => {
          const mem = summaryToMemory(r.memory!);
          if (r.score?.fused !== undefined) {
            mem.score = r.score.fused;
          }
          return mem;
        });
      setMemories(mapped);
    } catch (err) {
      console.error('Failed to recall memories:', err);
      setError(err instanceof Error ? err.message : 'Failed to recall memories');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const res = await api.getMemory(id);
      if (res.memory) {
        setMemories((current) =>
          current.map((m) => {
            if (m.id === id) {
              const full = summaryToMemory(m, res.memory);
              if (m.score !== undefined) full.score = m.score;
              return full;
            }
            return m;
          })
        );
      }
    } catch (err) {
      console.error('Failed to fetch detail for memory:', id, err);
    }
  }, []);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const startScan = useCallback(() => {
    setScanner((current) => {
      if (current === 'scanning') return current;
      timers.current.push(
        window.setTimeout(() => {
          setScanFound(0);
          setScanner('done');
        }, 1600),
        window.setTimeout(() => setScanner('idle'), 5200)
      );
      return 'scanning';
    });
  }, []);

  const createMemory = useCallback(
    async ({ title, content }: { title: string; content: string }) => {
      const res = await api.createMemory({ title, content });
      const created = summaryToMemory(res.memory, res.memory);
      setMemories((current) => [created, ...current]);
      setPoolTotal((current) => current + 1);
      return created;
    },
    []
  );

  const updateMemory = useCallback(
    async (id: string, { title, content }: { title: string; content: string }) => {
      const res = await api.updateMemory(id, { title, content });
      const updated = summaryToMemory(res.memory, res.memory);
      setMemories((current) =>
        current.map((m) => (m.id === id ? { ...m, ...updated } : m))
      );
    },
    []
  );

  const deleteMemory = useCallback(async (id: string) => {
    await api.deleteMemory(id);
    setMemories((current) => current.filter((memory) => memory.id !== id));
    setPoolTotal((current) => Math.max(0, current - 1));
  }, []);

  const value = useMemo<PoolContextValue>(
    () => ({
      memories,
      poolTotal,
      scanner,
      scanFound,
      loading,
      error,
      startScan,
      createMemory,
      updateMemory,
      deleteMemory,
      fetchMemories,
      fetchRecall,
      fetchDetail,
    }),
    [
      memories,
      poolTotal,
      scanner,
      scanFound,
      loading,
      error,
      startScan,
      createMemory,
      updateMemory,
      deleteMemory,
      fetchMemories,
      fetchRecall,
      fetchDetail,
    ]
  );

  return <PoolContext.Provider value={value}>{children}</PoolContext.Provider>;
}

export function usePool(): PoolContextValue {
  const context = useContext(PoolContext);
  if (!context) throw new Error('usePool must be used inside a PoolProvider');
  return context;
}
