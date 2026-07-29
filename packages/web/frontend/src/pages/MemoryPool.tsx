import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeleteMemoryDialog } from '../components/DeleteMemoryDialog';
import { MemoryDetailPanel } from '../components/MemoryDetailPanel';
import type { SearchMode } from '../components/MemoryListPanel';
import { MemoryListPanel } from '../components/MemoryListPanel';
import type { Memory } from '../data/memories';
import { memoryTitle } from '../data/memories';
import { usePool } from '../lib/pool';

export function MemoryPool() {
  const navigate = useNavigate();
  const {
    memories,
    poolTotal,
    scanner,
    startScan,
    updateMemory,
    deleteMemory,
    fetchMemories,
    fetchRecall,
    fetchDetail,
  } = usePool();

  const [mode, setMode] = useState<SearchMode>('filter');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isRecalling, setIsRecalling] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (mode === 'filter') {
      fetchMemories(debouncedQuery.trim() || undefined);
    }
  }, [mode, debouncedQuery, fetchMemories]);

  useEffect(() => {
    if (!memories.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !memories.some((memory) => memory.id === selectedId)) {
      if (memories[0]) {
        setSelectedId(memories[0].id);
      }
    }
  }, [memories, selectedId]);

  useEffect(() => {
    if (selectedId) {
      fetchDetail(selectedId);
    }
  }, [selectedId, fetchDetail]);

  const selected = memories.find((memory) => memory.id === selectedId) ?? null;

  const moveSelection = (delta: number) => {
    if (!memories.length) return;
    const index = memories.findIndex((memory) => memory.id === selectedId);
    const next = Math.min(
      memories.length - 1,
      Math.max(0, (index === -1 ? 0 : index) + delta)
    );
    const nextMem = memories[next];
    if (nextMem) {
      const nextId = nextMem.id;
      setSelectedId(nextId);
      listRef.current
        ?.querySelector(`[data-memory-row="${nextId}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (typing || pendingDelete) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const runRecall = async () => {
    if (!query.trim()) return;
    setIsRecalling(true);
    try {
      await fetchRecall(query.trim());
    } finally {
      setIsRecalling(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteMemory(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      console.error('Failed to delete memory:', err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1">
      <MemoryListPanel
        memories={memories}
        mode={mode}
        query={query}
        poolTotal={poolTotal}
        loadedTotal={memories.length}
        selectedId={selectedId}
        isRecalling={isRecalling}
        scanning={scanner === 'scanning'}
        onModeChange={(next) => {
          setMode(next);
          if (next === 'filter') {
            fetchMemories(query.trim() || undefined);
          }
        }}
        onQueryChange={setQuery}
        onRecall={runRecall}
        onSelect={setSelectedId}
        onScan={startScan}
        onCreate={() => navigate('/new')}
        listRef={listRef}
      />

      <MemoryDetailPanel
        memory={selected}
        poolTotal={poolTotal}
        onRequestDelete={() => selected && setPendingDelete(selected)}
        onSave={(input) => selected && updateMemory(selected.id, input)}
      />

      <DeleteMemoryDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete ? memoryTitle(pendingDelete) : ''}
        deleting={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
