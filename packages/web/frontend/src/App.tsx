import { useEffect, useState } from 'react';

import { api, type Session } from './api';
import { href, useRoute } from './router';
import { CreateMemory } from './views/CreateMemory';
import { MemoryDetail } from './views/MemoryDetail';
import { MemoryList } from './views/MemoryList';
import { Status } from './views/Status';

/**
 * Shell: resolves the session once, then renders the active route.
 *
 * The session probe gates the first paint deliberately. Rendering the UI before
 * we know whether there is a session would flash a memory list that then
 * vanishes into a login redirect.
 */
export function App(): React.JSX.Element {
    const route = useRoute();
    const [session, setSession] = useState<Session | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        void (async () => {
            try {
                setSession(await api.session());
            } catch {
                setFailed(true);
            }
        })();
    }, []);

    if (failed) {
        return (
            <main className="centered">
                <p className="error">Could not reach the Gemdex web server.</p>
            </main>
        );
    }

    if (!session) return <main className="centered"><p className="meta">Loading…</p></main>;

    if (!session.authenticated) {
        return (
            <main className="centered">
                <div className="login-card">
                    <h1>Gemdex</h1>
                    <p className="meta">Sign in to manage your memory pool.</p>
                    <a className="primary button-link" href={session.loginUrl}>
                        Sign in with Google
                    </a>
                </div>
            </main>
        );
    }

    return (
        <>
            <header className="app-header">
                <a className="brand" href={href.list()}>
                    Gemdex
                </a>
                <nav>
                    <a href={href.create()}>New</a>
                    <a href={href.status()}>Status</a>
                    {session.authMode === 'google' ? (
                        <button
                            type="button"
                            className="link"
                            onClick={() => {
                                void api.logout().then(() => window.location.reload());
                            }}
                            title={session.email ?? undefined}
                        >
                            Sign out
                        </button>
                    ) : (
                        <span className="dev-badge" title="GEMDEX_WEB_AUTH=dev — no login required">
                            dev mode
                        </span>
                    )}
                </nav>
            </header>
            <main>{renderRoute(route)}</main>
        </>
    );
}

function renderRoute(route: ReturnType<typeof useRoute>): React.JSX.Element {
    switch (route.name) {
        case 'detail':
            // Keyed so switching between memories remounts with fresh state
            // instead of briefly showing the previous memory's draft.
            return <MemoryDetail key={route.id} id={route.id} />;
        case 'create':
            return <CreateMemory />;
        case 'status':
            return <Status />;
        case 'list':
            return <MemoryList />;
    }
}
