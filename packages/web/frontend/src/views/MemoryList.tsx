import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError, type MemoryPage, type RecallResult } from '../api';
import { displayTitle, relativeAge } from '../format';
import { href } from '../router';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 200;

type Mode = 'filter' | 'recall';

/**
 * The landing view: newest-first memories with a search box.
 *
 * Two search modes, because the pool supports two genuinely different
 * questions and collapsing them would hide one:
 *
 * - **filter** — literal substring over title and preview, server-side. The
 *   same semantics as the `list_memories` MCP tool's `filter`.
 * - **recall** — semantic/embedding search, the relevance-ranked path.
 */
export function MemoryList(): React.JSX.Element {
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<Mode>('filter');
    const [page, setPage] = useState<MemoryPage | null>(null);
    const [recalled, setRecalled] = useState<RecallResult[] | null>(null);
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Guards against a slow earlier request overwriting a newer one's results —
    // easy to hit while typing, and it shows up as the list flickering back to
    // stale matches.
    const requestId = useRef(0);

    const runFilter = useCallback(async (needle: string, nextOffset: number): Promise<void> => {
        const id = ++requestId.current;
        setLoading(true);
        setError(null);
        try {
            const result = await api.listMemories({ q: needle, offset: nextOffset, limit: PAGE_SIZE });
            if (id !== requestId.current) return;
            setPage(result);
            setRecalled(null);
        } catch (cause) {
            if (id !== requestId.current) return;
            setError(cause instanceof ApiError ? cause.message : 'Could not load memories.');
        } finally {
            if (id === requestId.current) setLoading(false);
        }
    }, []);

    const runRecall = useCallback(async (needle: string): Promise<void> => {
        const id = ++requestId.current;
        setLoading(true);
        setError(null);
        try {
            const result = await api.recall(needle, 20);
            if (id !== requestId.current) return;
            setRecalled(result.results);
        } catch (cause) {
            if (id !== requestId.current) return;
            setError(cause instanceof ApiError ? cause.message : 'Recall failed.');
        } finally {
            if (id === requestId.current) setLoading(false);
        }
    }, []);

    // Filter mode searches as you type (debounced); recall mode waits for
    // submit, because each recall embeds the query — that is a real cost per
    // keystroke, not just a wasted round trip.
    useEffect(() => {
        if (mode !== 'filter') return;
        const timer = setTimeout(() => void runFilter(query, offset), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, offset, mode, runFilter]);

    const onSubmit = (event: React.FormEvent): void => {
        event.preventDefault();
        if (mode === 'recall' && query.trim()) void runRecall(query.trim());
    };

    const switchMode = (next: Mode): void => {
        setMode(next);
        setOffset(0);
        setRecalled(null);
        if (next === 'filter') void runFilter(query, 0);
    };

    const results = recalled;
    const showing = results ?? page?.memories ?? [];

    return (
        <section>
            <form className="toolbar" onSubmit={onSubmit} role="search">
                <input
                    className="search"
                    type="search"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setOffset(0);
                    }}
                    placeholder={mode === 'filter' ? 'Filter by title or preview…' : 'Describe what you need…'}
                    aria-label={mode === 'filter' ? 'Filter memories' : 'Recall memories'}
                />
                <div className="mode-toggle" role="group" aria-label="Search mode">
                    <button
                        type="button"
                        className={mode === 'filter' ? 'active' : ''}
                        onClick={() => switchMode('filter')}
                        title="Literal substring match over title and preview"
                    >
                        Filter
                    </button>
                    <button
                        type="button"
                        className={mode === 'recall' ? 'active' : ''}
                        onClick={() => switchMode('recall')}
                        title="Semantic search — finds related meaning, not exact words"
                    >
                        Recall
                    </button>
                </div>
                {mode === 'recall' && (
                    <button type="submit" className="primary" disabled={!query.trim()}>
                        Search
                    </button>
                )}
            </form>

            {error !== null && <p className="error" role="alert">{error}</p>}

            <p className="meta count">
                {loading && showing.length === 0
                    ? 'Loading…'
                    : results !== null
                      ? `${results.length} semantic ${results.length === 1 ? 'match' : 'matches'}`
                      : page
                        ? query.trim()
                          ? `${page.total} of ${page.poolTotal} match`
                          : `${page.poolTotal} memories`
                        : ''}
            </p>

            {!loading && showing.length === 0 && (
                <p className="empty">
                    {query.trim() ? 'Nothing matched.' : 'No memories yet.'}{' '}
                    <a href={href.create()}>Create one</a>.
                </p>
            )}

            <ul className="memory-list">
                {showing.map((entry) => {
                    const summary = 'memory' in entry ? entry.memory : entry;
                    if (!summary) return null;
                    const score = 'score' in entry ? entry.score?.fused : undefined;
                    return (
                        <li key={summary.id}>
                            <a className="memory-card" href={href.detail(summary.id)}>
                                <span className="memory-title">
                                    {displayTitle(summary.title, summary.preview)}
                                </span>
                                <span className="memory-preview">{summary.preview}</span>
                                <span className="meta memory-meta">
                                    <span>updated {relativeAge(summary.updatedAt)}</span>
                                    {summary.attachmentCount > 0 && (
                                        <span>
                                            {summary.attachmentCount} attachment
                                            {summary.attachmentCount === 1 ? '' : 's'}
                                        </span>
                                    )}
                                    {score !== undefined && <span>score {score.toFixed(3)}</span>}
                                </span>
                            </a>
                        </li>
                    );
                })}
            </ul>

            {/* Recall returns a fixed-size ranked set, so paging it would be meaningless. */}
            {results === null && page !== null && page.total > PAGE_SIZE && (
                <nav className="pager">
                    <button
                        type="button"
                        disabled={offset === 0 || loading}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    >
                        ← Newer
                    </button>
                    <span className="meta">
                        {offset + 1}–{Math.min(offset + PAGE_SIZE, page.total)} of {page.total}
                    </span>
                    <button
                        type="button"
                        disabled={offset + PAGE_SIZE >= page.total || loading}
                        onClick={() => setOffset(offset + PAGE_SIZE)}
                    >
                        Older →
                    </button>
                </nav>
            )}
        </section>
    );
}
