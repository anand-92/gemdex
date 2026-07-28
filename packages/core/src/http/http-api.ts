import * as http from 'http';
import { SUPPORTED_MIME_TYPES } from '../memory/attachment-validator';
import type { MemoryBackend } from '../memory/backend';

/**
 * Build CORS response headers for a given request context. When an
 * `allowedOrigin` is configured the `Access-Control-Allow-Origin` header is
 * set to that specific origin only; otherwise we fall back to the wildcard so
 * the server still works when run stand-alone (e.g. in tests that don't pass a
 * token/origin, or when invoked directly from the CLI without the desktop app).
 */
export function buildCorsHeaders(allowedOrigin: string | undefined): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': allowedOrigin ?? '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Gemdex-Token',
        // Do not reflect credentials — the token header is the auth mechanism.
        'Access-Control-Allow-Credentials': 'false',
    };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, corsHeaders: Record<string, string>): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...corsHeaders,
    });
    res.end(payload);
}

/** Stream raw attachment bytes back to the WebView with their real content type. */
export function sendBytes(
    res: http.ServerResponse,
    status: number,
    buf: Buffer,
    contentType: string,
    corsHeaders: Record<string, string>,
    extraHeaders: Record<string, string> = {},
): void {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': buf.length,
        ...corsHeaders,
        ...extraHeaders,
    });
    res.end(buf);
}

// Default JSON body ceiling. Routes that accept inline base64 attachments pass
// a larger limit (ATTACHMENT_BODY_LIMIT) since media payloads are much bigger.
export const DEFAULT_BODY_LIMIT = 50 * 1024 * 1024; // 50 MiB
export const ATTACHMENT_BODY_LIMIT = 100 * 1024 * 1024; // 100 MiB for create/update/import with media
const METHOD_ALLOW_HEADER = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const HEADER_ALLOW_HEADER = 'Content-Type, X-Gemdex-Token';
const SAFE_INLINE_ATTACHMENT_MIME_TYPES = new Set([...SUPPORTED_MIME_TYPES, 'text/plain']);

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidOptionalString(body: Record<string, unknown>, field: string): string | null {
    return body[field] !== undefined && typeof body[field] !== 'string'
        ? `'${field}' must be a string when provided`
        : null;
}

function validateImportRecord(record: unknown, index: number): string | null {
    if (!isJsonObject(record)) return `record #${index + 1} must be an object`;
    for (const field of ['id', 'title', 'content'] as const) {
        if (typeof record[field] !== 'string') {
            return `record #${index + 1} requires a string '${field}'`;
        }
    }
    for (const field of ['createdAt', 'updatedAt'] as const) {
        if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) {
            return `record #${index + 1} requires a finite numeric '${field}'`;
        }
    }
    if (record.attachments !== undefined && !Array.isArray(record.attachments)) {
        return `record #${index + 1} 'attachments' must be an array when provided`;
    }
    return null;
}

function attachmentResponseHeaders(mimeType: string): { contentType: string; headers: Record<string, string> } {
    const normalized = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
    const headers: Record<string, string> = {
        'X-Content-Type-Options': 'nosniff',
    };
    if (SAFE_INLINE_ATTACHMENT_MIME_TYPES.has(normalized)) {
        return { contentType: normalized, headers };
    }
    return {
        contentType: 'application/octet-stream',
        headers: {
            ...headers,
            'Content-Disposition': 'attachment',
        },
    };
}

function sendPreflight(res: http.ServerResponse, corsHeaders: Record<string, string>): void {
    res.writeHead(204, {
        'Allow': METHOD_ALLOW_HEADER,
        'Access-Control-Allow-Methods': METHOD_ALLOW_HEADER,
        'Access-Control-Allow-Headers': HEADER_ALLOW_HEADER,
        ...corsHeaders,
    });
    res.end();
}

export function readBody(req: http.IncomingMessage, maxBytes: number = DEFAULT_BODY_LIMIT): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;

        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('close', onClose);
            fn();
        };
        const fail = (error: Error): void => finish(() => reject(error));
        const onData = (chunk: Buffer): void => {
            size += chunk.length;
            if (size > maxBytes) {
                fail(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = (): void => {
            finish(() => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                if (raw.trim().length === 0) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch (error) {
                    reject(new Error('Invalid JSON body'));
                }
            });
        };
        const onError = (error: Error): void => fail(error);
        const onClose = (): void => {
            if (!req.complete) {
                fail(new Error('Connection closed prematurely'));
            }
        };

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('close', onClose);
    });
}

export interface MemoryApiHandlerOptions {
    store: MemoryBackend;
    corsHeaders?: Record<string, string>;
}

/**
 * Handle the reusable Gemdex memory HTTP API routes. This intentionally
 * excludes runtime-specific concerns such as listen/bind addresses, CORS
 * policy, authentication, and desktop-only /config setup. Callers own those
 * controls and pass any response headers they want applied. Returns false
 * when the request path is not part of the shared API surface.
 */
export async function handleMemoryApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: MemoryApiHandlerOptions,
): Promise<boolean> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const corsHeaders = options.corsHeaders ?? {};
    const store = options.store;

    try {
        // GET /memories — list summaries (sorted by updatedAt desc)
        if (method === 'GET' && pathname === '/memories') {
            const memories = await store.list();
            sendJson(res, 200, { memories }, corsHeaders);
            return true;
        }

        // POST /memories — create (text and/or inline media attachments)
        if (method === 'POST' && pathname === '/memories') {
            const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
            if (!isJsonObject(body)) {
                sendJson(res, 400, { error: 'Request body must be a JSON object' }, corsHeaders);
                return true;
            }
            const contentError = invalidOptionalString(body, 'content');
            const titleError = invalidOptionalString(body, 'title');
            if (contentError || titleError) {
                sendJson(res, 400, { error: contentError ?? titleError }, corsHeaders);
                return true;
            }
            if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                sendJson(res, 400, { error: "'attachments' must be an array" }, corsHeaders);
                return true;
            }
            const content = typeof body?.content === 'string' ? body.content : '';
            const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
            const hasAttachments = (attachments?.length ?? 0) > 0;
            if (content.trim().length === 0 && !hasAttachments) {
                sendJson(res, 400, { error: "'content' or at least one attachment is required" }, corsHeaders);
                return true;
            }
            try {
                const title = typeof body.title === 'string' ? body.title : undefined;
                const memory = await store.save({ content, title, ...(attachments && { attachments }) });
                sendJson(res, 201, { memory }, corsHeaders);
            } catch (error: any) {
                sendJson(res, 400, { error: error?.message ?? 'Failed to save memory' }, corsHeaders);
            }
            return true;
        }

        // GET /export — dump all memories as JSONL records
        if (method === 'GET' && pathname === '/export') {
            const records = await store.exportAll();
            sendJson(res, 200, { records }, corsHeaders);
            return true;
        }

        // POST /import — restore/merge (upsert by id, per-record fault tolerance:
        // 200 carries { imported, failed, errors } so one bad record can't abort the batch)
        if (method === 'POST' && pathname === '/import') {
            const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
            if (!Array.isArray(body?.records)) {
                sendJson(res, 400, { error: "Invalid payload: 'records' must be an array" }, corsHeaders);
                return true;
            }
            for (let i = 0; i < body.records.length; i++) {
                const validationError = validateImportRecord(body.records[i], i);
                if (validationError) {
                    sendJson(res, 400, { error: validationError }, corsHeaders);
                    return true;
                }
            }
            try {
                const result = await store.importRecords(body.records);
                sendJson(res, 200, result, corsHeaders);
            } catch (error: any) {
                sendJson(res, 400, { error: error?.message ?? 'Import failed' }, corsHeaders);
            }
            return true;
        }

        // POST /recall — relevance search by text and/or inline media.
        // Powers the app's semantic free-text search (query) as well as
        // recall-by-example (an attachment lifted from an existing memory);
        // at least one of query or attachments is required.
        if (method === 'POST' && pathname === '/recall') {
            const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
            if (!isJsonObject(body)) {
                sendJson(res, 400, { error: 'Request body must be a JSON object' }, corsHeaders);
                return true;
            }
            const queryError = invalidOptionalString(body, 'query');
            if (queryError) {
                sendJson(res, 400, { error: queryError }, corsHeaders);
                return true;
            }
            if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                sendJson(res, 400, { error: "'attachments' must be an array" }, corsHeaders);
                return true;
            }
            const query = typeof body?.query === 'string' ? body.query : '';
            const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
            if (
                body.limit !== undefined &&
                (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50)
            ) {
                sendJson(res, 400, { error: "'limit' must be an integer between 1 and 50" }, corsHeaders);
                return true;
            }
            const limit = typeof body.limit === 'number' ? body.limit : 10;
            const hasAttachments = (attachments?.length ?? 0) > 0;
            if (query.trim().length === 0 && !hasAttachments) {
                sendJson(res, 400, { error: "'query' or at least one attachment is required" }, corsHeaders);
                return true;
            }
            try {
                const results = await store.recall(query, limit, hasAttachments ? attachments : undefined);
                sendJson(res, 200, { results }, corsHeaders);
            } catch (error: any) {
                sendJson(res, 400, { error: error?.message ?? 'Recall failed' }, corsHeaders);
            }
            return true;
        }

        // GET /memories/:id/attachments/:attachmentId — raw attachment bytes.
        // Matched BEFORE the greedy /memories/:id detail route below.
        const attachmentMatch = pathname.match(/^\/memories\/([^/]+)\/attachments\/([^/]+)$/);
        if (attachmentMatch) {
            if (method !== 'GET') {
                sendJson(res, 405, { error: `Method ${method} not allowed on attachment` }, corsHeaders);
                return true;
            }
            const memoryId = decodeURIComponent(attachmentMatch[1]);
            const attachmentId = decodeURIComponent(attachmentMatch[2]);
            const blob = await store.readAttachment(memoryId, attachmentId);
            if (!blob) {
                sendJson(res, 404, { error: 'Attachment not found' }, corsHeaders);
                return true;
            }
            const attachmentResponse = attachmentResponseHeaders(blob.mimeType);
            sendBytes(res, 200, blob.data, attachmentResponse.contentType, corsHeaders, attachmentResponse.headers);
            return true;
        }

        // PATCH /memories/:id/attachments — caption-only edit (no re-embed).
        // Matched BEFORE the greedy /memories/:id detail route below.
        const captionsMatch = pathname.match(/^\/memories\/([^/]+)\/attachments$/);
        if (captionsMatch) {
            if (method !== 'PATCH') {
                sendJson(res, 405, { error: `Method ${method} not allowed on attachments` }, corsHeaders);
                return true;
            }
            const id = decodeURIComponent(captionsMatch[1]);
            const body = await readBody(req);
            if (!Array.isArray(body?.captions)) {
                sendJson(res, 400, { error: "'captions' must be an array" }, corsHeaders);
                return true;
            }
            const captions: { id: string; caption?: string }[] = [];
            for (const item of body.captions) {
                if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
                    sendJson(res, 400, { error: "each caption requires a string 'id'" }, corsHeaders);
                    return true;
                }
                if (item.caption !== undefined && typeof item.caption !== 'string') {
                    sendJson(res, 400, { error: "'caption' must be a string when provided" }, corsHeaders);
                    return true;
                }
                captions.push({ id: item.id, ...(item.caption !== undefined && { caption: item.caption }) });
            }
            try {
                const memory = await store.updateAttachmentCaptions(id, captions);
                sendJson(res, 200, { memory }, corsHeaders);
            } catch (error: any) {
                const msg = error?.message ?? 'Caption update failed';
                sendJson(res, /not found/i.test(msg) ? 404 : 400, { error: msg }, corsHeaders);
            }
            return true;
        }

        // /memories/:id routes
        const detailMatch = pathname.match(/^\/memories\/(.+)$/);
        if (detailMatch) {
            const id = decodeURIComponent(detailMatch[1]);

            if (method === 'GET') {
                const memory = await store.get(id);
                if (!memory) {
                    sendJson(res, 404, { error: 'Memory not found' }, corsHeaders);
                    return true;
                }
                sendJson(res, 200, { memory }, corsHeaders);
                return true;
            }

            if (method === 'PUT' || method === 'PATCH') {
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                if (!isJsonObject(body)) {
                    sendJson(res, 400, { error: 'Request body must be a JSON object' }, corsHeaders);
                    return true;
                }
                const contentError = invalidOptionalString(body, 'content');
                const titleError = invalidOptionalString(body, 'title');
                if (contentError || titleError) {
                    sendJson(res, 400, { error: contentError ?? titleError }, corsHeaders);
                    return true;
                }
                if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                    sendJson(res, 400, { error: "'attachments' must be an array" }, corsHeaders);
                    return true;
                }
                const hasContent = typeof body?.content === 'string';
                const hasTitle = typeof body?.title === 'string';
                const hasAttachments = body?.attachments !== undefined;
                if (!hasContent && !hasTitle && !hasAttachments) {
                    sendJson(res, 400, { error: "provide at least one of 'content', 'title', or 'attachments'" }, corsHeaders);
                    return true;
                }
                const input: { content?: string; title?: string; attachments?: any[] } = {};
                if (hasContent) input.content = body.content as string;
                if (hasTitle) input.title = body.title as string;
                if (hasAttachments) input.attachments = body.attachments;
                try {
                    const memory = await store.update(id, input);
                    sendJson(res, 200, { memory }, corsHeaders);
                } catch (error: any) {
                    const msg = error?.message ?? 'Update failed';
                    sendJson(res, /not found/i.test(msg) ? 404 : 400, { error: msg }, corsHeaders);
                }
                return true;
            }

            if (method === 'DELETE') {
                if (!await store.get(id)) {
                    sendJson(res, 404, { error: 'Memory not found' }, corsHeaders);
                    return true;
                }
                await store.delete(id);
                sendJson(res, 200, { ok: true }, corsHeaders);
                return true;
            }
        }

        return false;
    } catch (error: any) {
        const message = error?.message ?? 'Internal error';
        // readBody rejects with this when the payload exceeds the cap — a
        // client error (oversized attachments), not a server fault.
        if (message === 'Request body too large') {
            sendJson(res, 413, { error: message }, corsHeaders);
            return true;
        }
        if (message === 'Invalid JSON body') {
            sendJson(res, 400, { error: message }, corsHeaders);
            return true;
        }
        console.error('[http-api] request error:', error);
        sendJson(res, 500, { error: message }, corsHeaders);
        return true;
    }
}

export function createMemoryApiHandler(options: MemoryApiHandlerOptions): http.RequestListener {
    return (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = options.corsHeaders ?? {};

        if (method === 'OPTIONS') {
            sendPreflight(res, corsHeaders);
            return;
        }

        void handleMemoryApiRequest(req, res, options).then((handled) => {
            if (!handled) {
                sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
            }
        }).catch((error) => {
            console.error('[http-api] fatal handler error:', error);
            if (!res.headersSent) {
                sendJson(res, 500, { error: 'Internal server error' }, corsHeaders);
                return;
            }
            if (!res.writableEnded) res.end();
        });
    };
}
