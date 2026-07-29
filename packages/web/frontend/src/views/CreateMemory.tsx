import { useState } from 'react';

import { api, ApiError } from '../api';
import { href, navigate } from '../router';

/**
 * Create a text memory by hand.
 *
 * Text-only, deliberately: the file-bearing path is *session* upload
 * (`UploadSessions`), where transcripts are digested into memories rather than
 * attached to one the user is typing. Adding a generic attachment picker here
 * would give two ways to put a file in the pool with different semantics.
 */
export function CreateMemory(): React.JSX.Element {
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        if (!content.trim()) {
            setError('Content is required.');
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const payload = title.trim() ? { content, title: title.trim() } : { content };
            const { memory } = await api.createMemory(payload);
            navigate(href.detail(memory.id));
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : 'Could not save this memory.');
            setSaving(false);
        }
    };

    return (
        <section className="detail">
            <a className="back" href={href.list()}>← All memories</a>
            <h2>New memory</h2>

            {error !== null && <p className="error" role="alert">{error}</p>}

            <form onSubmit={(event) => void submit(event)}>
                <label className="field">
                    <span>Title (optional)</span>
                    <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Derived from the content when left blank"
                    />
                </label>
                <label className="field">
                    <span>Content</span>
                    <textarea
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        rows={16}
                        placeholder="What should be remembered across every repo, session, and machine?"
                        autoFocus
                    />
                </label>
                <div className="actions">
                    <button type="submit" className="primary" disabled={saving || !content.trim()}>
                        {saving ? 'Saving…' : 'Save memory'}
                    </button>
                    <a className="button-link" href={href.list()}>
                        Cancel
                    </a>
                </div>
                <p className="meta hint">
                    Saving embeds the content, so it becomes recallable by meaning as well as by text.
                </p>
            </form>
        </section>
    );
}
