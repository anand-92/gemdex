import { useRef, useState } from 'react';

import { api, ApiError, type SessionUploadResult, type SessionUploadSummary } from '../api';
import { href } from '../router';

/**
 * Upload coding-agent chat sessions for the deployment to digest.
 *
 * This is the browser half of "history path B". Path A is `gemdex sync-history`
 * on a laptop, which digests locally with the developer's own Gemini key and
 * pushes finished records. Here the human hands over raw transcripts and the
 * *deployment* does the cleaning and digesting — which is what makes a machine
 * that never ran the CLI, or a transcript someone else exported, ingestible.
 *
 * Both paths produce the same `chat:<source>:<sessionId>` memory, so uploading a
 * session that was already synced updates it instead of duplicating it. The UI
 * says so, because "will this double my memories?" is the first question anyone
 * has before dragging a folder of sessions in.
 *
 * Two deliberate UI choices:
 *
 * - **The result list is per file, always.** A digest costs a Gemini call, so a
 *   batch where two files failed and eight succeeded must show eight successes
 *   and name the two — not a single red error that hides work already paid for.
 * - **No progress bar.** Digesting is one model call per session with no
 *   incremental signal to report, so an indeterminate "working" state that names
 *   the file count is honest where a percentage would be invented.
 */
export function UploadSessions(): React.JSX.Element {
    const [files, setFiles] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    const [summary, setSummary] = useState<SessionUploadSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const addFiles = (incoming: FileList | null): void => {
        if (!incoming || incoming.length === 0) return;
        setSummary(null);
        setError(null);
        setFiles((current) => {
            // De-duplicate by name+size: picking twice, or dropping a folder that
            // overlaps a previous drop, should not queue the same session twice
            // (it would be two Gemini calls for one identical result).
            const seen = new Set(current.map((file) => `${file.name}:${file.size}`));
            const added = Array.from(incoming).filter((file) => !seen.has(`${file.name}:${file.size}`));
            return [...current, ...added];
        });
    };

    const submit = async (): Promise<void> => {
        if (files.length === 0) return;
        setUploading(true);
        setError(null);
        setSummary(null);
        try {
            setSummary(await api.uploadSessions(files));
            setFiles([]);
            if (inputRef.current) inputRef.current.value = '';
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : 'Could not upload these sessions.');
        } finally {
            setUploading(false);
        }
    };

    return (
        <section className="detail">
            <a className="back" href={href.list()}>← All memories</a>
            <h2>Upload chat sessions</h2>

            <p className="meta">
                Hand over raw agent session transcripts (<code>.jsonl</code>, or a <code>.zip</code> of
                them) and this deployment will clean each one, write a structured digest, and save it as a
                recallable memory with the full transcript attached.
            </p>

            {error !== null && <p className="error" role="alert">{error}</p>}

            <div
                className={`dropzone${dragging ? ' dragging' : ''}`}
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
            >
                <p>Drop session files here</p>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    // Browsers cannot portably upload a directory, and agents keep
                    // sessions in per-project folders, so a zip is the practical
                    // way to hand over a whole history at once.
                    accept=".jsonl,.zip"
                    onChange={(event) => addFiles(event.target.files)}
                    disabled={uploading}
                />
            </div>

            {files.length > 0 && (
                <ul className="upload-queue">
                    {files.map((file) => (
                        <li key={`${file.name}:${file.size}`}>
                            <code>{file.name}</code>
                            <span className="meta">{formatBytes(file.size)}</span>
                            <button
                                type="button"
                                className="link"
                                disabled={uploading}
                                onClick={() =>
                                    setFiles((current) => current.filter((queued) => queued !== file))
                                }
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="actions">
                <button
                    type="button"
                    className="primary"
                    disabled={uploading || files.length === 0}
                    onClick={() => void submit()}
                >
                    {uploadLabel(files.length, uploading)}
                </button>
                {files.length > 0 && !uploading && (
                    <button type="button" className="link" onClick={() => setFiles([])}>
                        Clear
                    </button>
                )}
            </div>

            {uploading && (
                <p className="meta hint" role="status">
                    Digesting {files.length} session{files.length === 1 ? '' : 's'} — one model call each,
                    so this can take a while. Leaving this page cancels nothing already sent, but you will
                    not see the results.
                </p>
            )}

            {summary !== null && <UploadSummary summary={summary} />}

            <p className="meta hint">
                Where to find transcripts: <code>~/.claude/projects</code>,{' '}
                <code>~/.codex/sessions</code>, <code>~/.factory/sessions</code>. Uploading a session that
                was already ingested updates that memory rather than adding a second one, so re-uploading
                is safe.
            </p>
        </section>
    );
}

function uploadLabel(count: number, uploading: boolean): string {
    if (uploading) return 'Digesting…';
    // The count is omitted while the queue is empty, when the button is disabled
    // anyway and "Upload 0 sessions" would read as a broken template.
    if (count === 0) return 'Upload sessions';
    return `Upload ${count} session${count === 1 ? '' : 's'}`;
}

function UploadSummary({ summary }: { summary: SessionUploadSummary }): React.JSX.Element {
    const { ingested, skipped, failed, results } = summary;
    return (
        <div className="upload-summary">
            <h3>
                {ingested} ingested
                {skipped > 0 && `, ${skipped} skipped`}
                {failed > 0 && `, ${failed} failed`}
            </h3>
            {ingested === 0 && failed === 0 && skipped > 0 && (
                <p className="meta">
                    Nothing was ingested. Skipped files cost nothing — check that these are agent session
                    transcripts.
                </p>
            )}
            <ul className="upload-results">
                {results.map((result, index) => (
                    <li key={`${result.filename ?? 'file'}:${index}`} className={result.status}>
                        <Result result={result} />
                    </li>
                ))}
            </ul>
        </div>
    );
}

function Result({ result }: { result: SessionUploadResult }): React.JSX.Element {
    const name = result.filename ?? 'unnamed file';
    if (result.status === 'ingested' && result.memoryId) {
        return (
            <>
                <span className="badge ok">saved</span>
                {/* Straight to the memory: the point of uploading is to get a
                    recallable digest, and reading it is how you confirm it. */}
                <a href={href.detail(result.memoryId)}>{result.title ?? result.memoryId}</a>
                <span className="meta">
                    {name}
                    {result.source ? ` · ${result.source}` : ''}
                </span>
            </>
        );
    }
    return (
        <>
            <span className={`badge ${result.status === 'failed' ? 'bad' : 'warn'}`}>{result.status}</span>
            <code>{name}</code>
            <span className="meta">{result.detail ?? ''}</span>
        </>
    );
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
