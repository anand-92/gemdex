import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type HygieneStatus, type IngestHistoryPage } from '../api';
import { displayTitle, relativeAge } from '../format';
import { href } from '../router';

const PAGE_SIZE = 50;

/**
 * What chat history this pool has ingested, plus where hygiene can run.
 *
 * The two belong on one page because they answer one operator question — "is my
 * memory pool healthy and where did it come from?" — and because the honest
 * answer to the hygiene half is short.
 *
 * Both panels are deliberately plain about their limits: the timestamps are
 * session activity rather than ingest time (the host cannot know when a laptop
 * ran sync), and hygiene cannot run server-side at all. Surfacing those in the
 * UI rather than only in a docstring is the point of the page.
 */
export function IngestHistory(): React.JSX.Element {
    const [page, setPage] = useState<IngestHistoryPage | null>(null);
    const [hygiene, setHygiene] = useState<HygieneStatus | null>(null);
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (nextOffset: number): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
            setPage(await api.ingestHistory({ offset: nextOffset, limit: PAGE_SIZE }));
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : 'Could not load ingest history.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(offset);
    }, [load, offset]);

    // Independent of the history request: hygiene status is static config-shaped
    // data, and it should still render if the pool listing fails.
    useEffect(() => {
        void (async () => {
            try {
                setHygiene(await api.hygieneStatus());
            } catch {
                setHygiene(null);
            }
        })();
    }, []);

    return (
        <section className="detail">
            <a className="back" href={href.list()}>← All memories</a>
            <h2>Ingested chat history</h2>

            {error !== null && <p className="error" role="alert">{error}</p>}
            {loading && page === null && <p className="meta">Loading…</p>}

            {page !== null && (
                <>
                    <p className="meta">
                        <strong>{page.total.toLocaleString()}</strong> of{' '}
                        {page.poolTotal.toLocaleString()} memories came from ingested coding
                        sessions.
                    </p>

                    {page.sources.length > 0 && (
                        <div className="chip-row">
                            {page.sources.map((source) => (
                                <span className="chip" key={source.source}>
                                    {source.label}
                                    <b>{source.sessions.toLocaleString()}</b>
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Sent by the BFF rather than written here, so the caveat
                        cannot drift from the code that derives the numbers. */}
                    <p className="meta hint">{page.timestampMeaning}</p>

                    {page.repos.length > 0 && (
                        <>
                            <h3>Busiest repos</h3>
                            <p className="meta">
                                Sessions carry the repo they happened in — the closest thing to
                                "which machine did this come from", since the pool is never told a
                                hostname.
                            </p>
                            <ul className="repo-list">
                                {page.repos.map((repo) => (
                                    <li key={repo.repo}>
                                        <code>{repo.repo}</code>
                                        <span className="meta">{repo.sessions.toLocaleString()}</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}

                    <h3>Sessions</h3>
                    {page.sessions.length === 0 ? (
                        <p className="meta">
                            No ingested sessions yet. Upload transcripts on the{' '}
                            <a href={href.upload()}>upload page</a>, or run{' '}
                            <code>npx gemdex sync-history</code> on a machine with local chat
                            history.
                        </p>
                    ) : (
                        <ul className="session-list">
                            {page.sessions.map((session) => (
                                <li key={session.memoryId}>
                                    <a href={href.detail(session.memoryId)}>
                                        {displayTitle(session.title, null)}
                                    </a>
                                    <p className="meta">
                                        {session.sourceLabel}
                                        {session.repo !== null && (
                                            <>
                                                {' · '}
                                                <code>{session.repo}</code>
                                                {session.branch !== null && ` (${session.branch})`}
                                            </>
                                        )}
                                        {' · active '}
                                        {relativeAge(session.lastActiveAt)}
                                        {session.hasTranscript && ' · transcript saved'}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}

                    {page.total > PAGE_SIZE && (
                        <div className="pager">
                            <button
                                type="button"
                                disabled={offset === 0 || loading}
                                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                            >
                                ← Newer
                            </button>
                            <span className="meta">
                                {offset + 1}–{Math.min(offset + PAGE_SIZE, page.total)} of{' '}
                                {page.total.toLocaleString()}
                            </span>
                            <button
                                type="button"
                                disabled={offset + PAGE_SIZE >= page.total || loading}
                                onClick={() => setOffset(offset + PAGE_SIZE)}
                            >
                                Older →
                            </button>
                        </div>
                    )}
                </>
            )}

            {hygiene !== null && <HygienePanel hygiene={hygiene} />}
        </section>
    );
}

/**
 * Hygiene status.
 *
 * There is no scan button on purpose. Near-duplicate clustering reads per-memory
 * vectors from a local LanceDB store, which a Postgres-backed deployment cannot
 * provide — so this reports what genuinely protects the pool today and the exact
 * command for a real pass, instead of a control that would always fail.
 */
function HygienePanel({ hygiene }: { hygiene: HygieneStatus }): React.JSX.Element {
    return (
        <>
            <h2 className="section-break">Memory hygiene</h2>

            <p className={hygiene.available ? 'ok' : 'meta notice'}>
                {hygiene.available ? 'Available on this server.' : hygiene.reason}
            </p>

            <h3>What protects this pool today</h3>
            <ul className="protection-list">
                {hygiene.protections.map((protection) => (
                    <li key={protection.title}>
                        <strong>{protection.title}</strong>
                        <span className={`badge badge-${protection.state}`}>
                            {protection.state === 'active' ? 'active' : 'by design'}
                        </span>
                        <p className="meta">{protection.detail}</p>
                    </li>
                ))}
            </ul>

            <h3>Running a hygiene pass</h3>
            <p className="meta">{hygiene.howToRun.summary}</p>
            <ul className="protection-list">
                {hygiene.howToRun.options.map((option) => (
                    <li key={option.label}>
                        <strong>{option.label}</strong>
                        <p className="meta">{option.detail}</p>
                        {option.command !== undefined && <pre><code>{option.command}</code></pre>}
                    </li>
                ))}
            </ul>
            <p className="meta hint">{hygiene.howToRun.caveat}</p>
        </>
    );
}
