import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type MemoryDetail as Memory } from '../api';
import { absoluteDate, displayTitle, formatBytes, relativeAge } from '../format';
import { href, navigate } from '../router';

interface Props {
    id: string;
}

/** View, edit, and delete one memory, plus download its attachments. */
export function MemoryDetail({ id }: Props): React.JSX.Element {
    const [memory, setMemory] = useState<Memory | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [editing, setEditing] = useState(false);
    const [draftTitle, setDraftTitle] = useState('');
    const [draftContent, setDraftContent] = useState('');
    const [saving, setSaving] = useState(false);

    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
            const { memory: loaded } = await api.getMemory(id);
            setMemory(loaded);
            setDraftTitle(loaded.title ?? '');
            setDraftContent(loaded.content ?? '');
        } catch (cause) {
            setError(
                cause instanceof ApiError && cause.status === 404
                    ? 'That memory no longer exists.'
                    : 'Could not load this memory.',
            );
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    const save = async (): Promise<void> => {
        if (!memory) return;
        // Send only what actually changed, so a title fix does not resend the
        // body and trigger a needless re-embed of the whole memory.
        const patch: { title?: string; content?: string } = {};
        if (draftTitle !== (memory.title ?? '')) patch.title = draftTitle;
        if (draftContent !== (memory.content ?? '')) patch.content = draftContent;

        if (Object.keys(patch).length === 0) {
            setEditing(false);
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const { memory: updated } = await api.updateMemory(memory.id, patch);
            setMemory(updated);
            setDraftTitle(updated.title ?? '');
            setDraftContent(updated.content ?? '');
            setEditing(false);
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : 'Could not save changes.');
        } finally {
            setSaving(false);
        }
    };

    const cancelEdit = (): void => {
        setDraftTitle(memory?.title ?? '');
        setDraftContent(memory?.content ?? '');
        setEditing(false);
        setError(null);
    };

    const remove = async (): Promise<void> => {
        if (!memory) return;
        setDeleting(true);
        setError(null);
        try {
            await api.deleteMemory(memory.id);
            navigate(href.list());
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : 'Could not delete this memory.');
            setDeleting(false);
            setConfirmingDelete(false);
        }
    };

    if (loading) return <p className="meta">Loading…</p>;

    if (error !== null && memory === null) {
        return (
            <section>
                <p className="error" role="alert">{error}</p>
                <a href={href.list()}>← Back to all memories</a>
            </section>
        );
    }

    if (!memory) return <p className="meta">Not found.</p>;

    return (
        <section className="detail">
            <a className="back" href={href.list()}>← All memories</a>

            {error !== null && <p className="error" role="alert">{error}</p>}

            {editing ? (
                <>
                    <label className="field">
                        <span>Title</span>
                        <input
                            value={draftTitle}
                            onChange={(event) => setDraftTitle(event.target.value)}
                            placeholder="Untitled"
                        />
                    </label>
                    <label className="field">
                        <span>Content</span>
                        <textarea
                            value={draftContent}
                            onChange={(event) => setDraftContent(event.target.value)}
                            rows={18}
                        />
                    </label>
                    <div className="actions">
                        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" onClick={cancelEdit} disabled={saving}>
                            Cancel
                        </button>
                    </div>
                    <p className="meta hint">
                        Editing content re-embeds the memory, which changes how it is recalled.
                    </p>
                </>
            ) : (
                <>
                    <header className="detail-header">
                        <h2>{displayTitle(memory.title, memory.preview)}</h2>
                        <div className="actions">
                            <button type="button" onClick={() => setEditing(true)}>
                                Edit
                            </button>
                            <button
                                type="button"
                                className="danger"
                                onClick={() => setConfirmingDelete(true)}
                            >
                                Delete
                            </button>
                        </div>
                    </header>

                    <p className="meta">
                        updated {relativeAge(memory.updatedAt)} · created {absoluteDate(memory.createdAt)}
                        <br />
                        <code className="id">{memory.id}</code>
                    </p>

                    <pre className="content">{memory.content}</pre>
                </>
            )}

            {memory.attachments.length > 0 && (
                <section className="attachments">
                    <h3>Attachments</h3>
                    <ul>
                        {memory.attachments.map((attachment) => (
                            <li key={attachment.id}>
                                <span className="attachment-name">
                                    {attachment.caption ?? attachment.kind ?? 'attachment'}
                                    <span className="meta">
                                        {' '}
                                        {attachment.mimeType} {formatBytes(attachment.byteSize)}
                                    </span>
                                </span>
                                <span className="actions">
                                    {/* Opens in a new tab; the BFF decides inline vs download by
                                        mime type, so an unsafe type cannot render in this origin. */}
                                    <a
                                        href={api.attachmentUrl(memory.id, attachment.id)}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                    >
                                        View
                                    </a>
                                    <a href={api.attachmentUrl(memory.id, attachment.id, true)} download>
                                        Download
                                    </a>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {confirmingDelete && (
                <ConfirmDelete
                    title={displayTitle(memory.title, memory.preview)}
                    busy={deleting}
                    onCancel={() => setConfirmingDelete(false)}
                    onConfirm={() => void remove()}
                />
            )}
        </section>
    );
}

interface ConfirmProps {
    title: string;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * Explicit confirmation for the one irreversible action in Gemdex.
 *
 * Deletion is deliberately absent from the agent-facing MCP tools; it exists
 * here because a human asked for it, so it should be hard to do by accident —
 * hence a modal with a non-default destructive button rather than an
 * undo-less one-click.
 */
function ConfirmDelete({ title, busy, onCancel, onConfirm }: ConfirmProps): React.JSX.Element {
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="modal">
                <h3 id="confirm-title">Delete this memory?</h3>
                <p>
                    <strong>{title}</strong>
                </p>
                <p className="meta">
                    This cannot be undone. The memory and its attachments are removed from the pool for
                    every agent and every machine.
                </p>
                <div className="actions">
                    <button type="button" onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
                        {busy ? 'Deleting…' : 'Delete permanently'}
                    </button>
                </div>
            </div>
        </div>
    );
}
