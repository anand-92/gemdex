/**
 * The single seam between the UI and the BFF.
 *
 * No component calls `fetch` directly: keeping it here means the 401 handling
 * below (redirect to login) exists in exactly one place, and the types describe
 * what *this* service returns rather than what the BYOI happens to return.
 */

export interface MemorySummary {
    id: string;
    title: string | null;
    preview: string | null;
    createdAt: number | null;
    updatedAt: number | null;
    attachmentCount: number;
}

export interface Attachment {
    id: string;
    kind: string | null;
    mimeType: string | null;
    byteSize: number | null;
    caption: string | null;
}

export interface MemoryDetail {
    id: string;
    title: string | null;
    content: string | null;
    preview: string | null;
    createdAt: number | null;
    updatedAt: number | null;
    attachments: Attachment[];
}

export interface MemoryPage {
    memories: MemorySummary[];
    /** How many matched the current filter — not the page length. */
    total: number;
    /** How many exist in total, so the UI can say "12 of 340". */
    poolTotal: number;
    offset: number;
    limit: number;
}

export interface RecallResult {
    /**
     * The BFF nests this, though `/v1/recall` returns hits flat — see
     * `_recall_result` in `routes.py`. Nesting keeps this identical in shape to
     * a `MemorySummary` from the list, so both render through one code path.
     */
    memory: MemorySummary | null;
    /** `fused` is what the BYOI reports today; the others are forward room. */
    score: { fused?: number; dense?: number; bm25?: number } | null;
}

export interface Session {
    authenticated: boolean;
    email: string | null;
    authMode: 'dev' | 'google';
    loginUrl: string;
}

export interface StatusInfo {
    byoi: {
        url: string;
        reachable: boolean;
        name?: string | null;
        serverVersion?: string | null;
        apiVersion?: string | null;
        minClientVersion?: string | null;
        protocolVersion?: number | null;
        capabilities?: Record<string, unknown> | null;
        error?: string;
    };
    web: {
        authMode: string;
        allowedEmail: string | null;
        sessionTtlSeconds: number;
    };
}

/** An API call failed. `status` is the HTTP status, when there was a response. */
export class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            ...init,
            // The session cookie is the credential; without this the browser
            // would omit it on cross-origin dev requests.
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
                ...init?.headers,
            },
        });
    } catch (cause) {
        // fetch rejects only on network failure, which for a same-origin app
        // means the server is down — worth distinguishing from an HTTP error.
        throw new ApiError('Could not reach the Gemdex web server.', 0);
    }

    if (response.status === 401) {
        // The session is gone or was never established. Full page navigation,
        // not fetch: the OAuth flow needs the browser to follow redirects to
        // Google, which a fetch cannot do.
        const loginUrl = response.headers.get('X-Gemdex-Login') ?? '/auth/login';
        window.location.href = `${loginUrl}?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        // Never settles — the navigation above ends this page's life. Returning
        // would make callers render an error flash before the redirect paints.
        return new Promise<never>(() => {});
    }

    if (!response.ok) {
        throw new ApiError(await errorDetail(response), response.status);
    }

    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
}

async function errorDetail(response: Response): Promise<string> {
    try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && 'detail' in body) {
            const detail = (body as { detail: unknown }).detail;
            if (typeof detail === 'string') return detail;
            // FastAPI validation errors arrive as an array of objects.
            if (Array.isArray(detail)) {
                const first: unknown = detail[0];
                if (first && typeof first === 'object' && 'msg' in first) {
                    return String((first as { msg: unknown }).msg);
                }
            }
        }
    } catch {
        // Fall through to the status-based message.
    }
    return `Request failed (HTTP ${response.status}).`;
}

export const api = {
    session: (): Promise<Session> => request<Session>('/api/session'),

    listMemories: (params: { q?: string; offset?: number; limit?: number } = {}): Promise<MemoryPage> => {
        const search = new URLSearchParams();
        if (params.q) search.set('q', params.q);
        if (params.offset !== undefined) search.set('offset', String(params.offset));
        if (params.limit !== undefined) search.set('limit', String(params.limit));
        const query = search.toString();
        return request<MemoryPage>(`/api/memories${query ? `?${query}` : ''}`);
    },

    getMemory: (id: string): Promise<{ memory: MemoryDetail }> =>
        request<{ memory: MemoryDetail }>(`/api/memories/${encodeURIComponent(id)}`),

    createMemory: (input: { content: string; title?: string }): Promise<{ memory: MemoryDetail }> =>
        request<{ memory: MemoryDetail }>('/api/memories', {
            method: 'POST',
            body: JSON.stringify(input),
        }),

    updateMemory: (id: string, input: { content?: string; title?: string }): Promise<{ memory: MemoryDetail }> =>
        request<{ memory: MemoryDetail }>(`/api/memories/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify(input),
        }),

    deleteMemory: (id: string): Promise<{ ok: boolean }> =>
        request<{ ok: boolean }>(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    recall: (query: string, limit = 10): Promise<{ results: RecallResult[] }> =>
        request<{ results: RecallResult[] }>('/api/recall', {
            method: 'POST',
            body: JSON.stringify({ query, limit }),
        }),

    status: (): Promise<StatusInfo> => request<StatusInfo>('/api/status'),

    logout: (): Promise<{ ok: boolean }> => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

    /** URL for an attachment. Used as an `href`/`src`, so it is not fetched here. */
    attachmentUrl: (memoryId: string, attachmentId: string, download = false): string =>
        `/api/memories/${encodeURIComponent(memoryId)}/attachments/${encodeURIComponent(attachmentId)}${
            download ? '?download=true' : ''
        }`,
};
