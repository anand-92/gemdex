import { useEffect, useState } from 'react';

import { api, type StatusInfo } from '../api';
import { href } from '../router';

/**
 * Connection / status page: is the backend reachable, what version, how is this
 * app gated.
 *
 * Reports the *running* configuration rather than what a config file says, so
 * an operator can confirm from the app itself that (for example) `dev` mode is
 * not live in a deployment that should require login.
 *
 * Ingest and hygiene status live on the History page instead of here: both are
 * about the *contents* of the pool, and this page is about whether the pieces
 * are wired up. What does belong here is the capability check below — whether
 * the connected server is new enough to accept uploads at all.
 */
export function Status(): React.JSX.Element {
    const [status, setStatus] = useState<StatusInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void (async () => {
            try {
                setStatus(await api.status());
            } catch {
                setError('Could not load status.');
            }
        })();
    }, []);

    if (error !== null) return <p className="error" role="alert">{error}</p>;
    if (!status) return <p className="meta">Loading…</p>;

    const { byoi, web } = status;

    return (
        <section className="detail">
            <a className="back" href={href.list()}>← All memories</a>
            <h2>Status</h2>

            <h3>Memory backend</h3>
            <dl className="status-grid">
                <dt>Connection</dt>
                <dd className={byoi.reachable ? 'ok' : 'bad'}>
                    {byoi.reachable ? 'Reachable' : 'Unreachable'}
                </dd>

                <dt>URL</dt>
                <dd>
                    <code>{byoi.url}</code>
                </dd>

                {byoi.error !== undefined && (
                    <>
                        <dt>Error</dt>
                        <dd className="bad">{byoi.error}</dd>
                    </>
                )}

                {byoi.reachable && (
                    <>
                        <dt>Server</dt>
                        <dd>
                            {byoi.name} {byoi.serverVersion}
                        </dd>

                        <dt>API</dt>
                        <dd>
                            {byoi.apiVersion} (protocol {byoi.protocolVersion}, min client{' '}
                            {byoi.minClientVersion})
                        </dd>

                        <dt>Storage mode</dt>
                        {/* BYOI = "bring your own infrastructure": server-side
                            embedding against Postgres/pgvector, which is the only
                            mode this UI can talk to. */}
                        <dd>BYOI — server-side embedding, Postgres/pgvector</dd>

                        <dt>Capabilities</dt>
                        <dd>{formatCapabilities(byoi.capabilities)}</dd>

                        <dt>Session upload</dt>
                        {/* Called out separately from the capability list
                            because it is the one capability with a user-visible
                            page behind it: an older server has no
                            /v1/sessions/ingest, and the upload form would fail
                            at submit time with no explanation. */}
                        <dd className={supportsSessionIngest(byoi.capabilities) ? 'ok' : 'warn'}>
                            {supportsSessionIngest(byoi.capabilities)
                                ? 'Supported — transcripts are digested server-side'
                                : 'Not supported by this server version — upgrade to use the upload page'}
                        </dd>

                        <dt>Digest model key</dt>
                        {/* Operators reliably look for this in the wrong place:
                            digesting happens inside the server container, so the
                            key belongs to it, not to this web app. */}
                        <dd>
                            <code>GEMINI_API_KEY</code> on the memory backend, not on this web app
                        </dd>
                    </>
                )}
            </dl>

            <h3>This app</h3>
            <dl className="status-grid">
                <dt>Login</dt>
                <dd className={web.authMode === 'google' ? 'ok' : 'warn'}>
                    {web.authMode === 'google'
                        ? 'Google, single account'
                        : 'Disabled (dev mode — loopback only)'}
                </dd>

                {web.allowedEmail !== null && (
                    <>
                        <dt>Allowed account</dt>
                        <dd>{web.allowedEmail}</dd>
                    </>
                )}

                <dt>Session lifetime</dt>
                <dd>{Math.round(web.sessionTtlSeconds / 3600)} hours</dd>
            </dl>

            <p className="meta hint">
                The memory backend token stays on the server. This browser never receives it.
            </p>
        </section>
    );
}

function supportsSessionIngest(capabilities: Record<string, unknown> | null | undefined): boolean {
    return capabilities?.sessionIngest === true;
}

function formatCapabilities(capabilities: Record<string, unknown> | null | undefined): string {
    if (!capabilities) return 'unknown';
    const enabled = Object.entries(capabilities)
        .filter(([, value]) => value === true)
        .map(([key]) => key);
    return enabled.length > 0 ? enabled.join(', ') : 'none reported';
}
