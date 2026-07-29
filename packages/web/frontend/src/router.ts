/**
 * A ~50-line hash router.
 *
 * Deliberately not `react-router`: this app has four routes and the dependency
 * would be larger than the app. Hash-based rather than History API so the BFF
 * never has to know the client-side route table — the server only ever serves
 * `/`, which also means a deep link cannot 404 after a deploy.
 *
 * **Extension point for GEM2-7 / GEM2-8:** add a variant to `Route` and a case
 * to `parseRoute`, then a branch in `App`. Nothing else needs to change.
 */

import { useEffect, useState } from 'react';

export type Route =
    | { name: 'list' }
    | { name: 'detail'; id: string }
    | { name: 'create' }
    | { name: 'status' };

export function parseRoute(hash: string): Route {
    const path = hash.replace(/^#\/?/, '');
    const [head, ...rest] = path.split('/');

    switch (head) {
        case 'new':
            return { name: 'create' };
        case 'status':
            return { name: 'status' };
        case 'memory': {
            const id = rest.join('/');
            // A detail route with no id is meaningless; fall back to the list
            // rather than rendering a broken page.
            return id ? { name: 'detail', id: decodeURIComponent(id) } : { name: 'list' };
        }
        default:
            return { name: 'list' };
    }
}

export function useRoute(): Route {
    const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

    useEffect(() => {
        const onChange = (): void => setRoute(parseRoute(window.location.hash));
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, []);

    return route;
}

export const href = {
    list: (): string => '#/',
    detail: (id: string): string => `#/memory/${encodeURIComponent(id)}`,
    create: (): string => '#/new',
    status: (): string => '#/status',
};

export function navigate(target: string): void {
    window.location.hash = target;
}
