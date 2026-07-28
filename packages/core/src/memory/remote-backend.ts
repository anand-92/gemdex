import {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    ImportRecordsResult,
    Memory,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    MemoryAttachmentInput,
    SaveMemoryInput,
    SaveResult,
    UpdateMemoryInput,
} from './types';
import type { MemoryBackend } from './backend';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_LIMIT = 100 * 1024 * 1024;

export interface RemoteMemoryBackendOptions {
    url: string;
    token: string;
    timeoutMs?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    fetch?: typeof fetch;
}

export class RemoteMemoryError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
        public readonly code?: 'timeout' | 'network' | 'invalid_response' | 'body_too_large',
    ) {
        super(message);
        this.name = 'RemoteMemoryError';
    }
}

interface RequestOptions {
    method?: string;
    body?: unknown;
    allowNotFound?: boolean;
    responseType?: 'json' | 'bytes';
}

interface RemoteResponse<T> {
    value: T | null;
    headers: Headers;
}

function normalizeUrl(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new RemoteMemoryError(`Invalid Gemdex remote URL '${value}'.`, undefined, 'network');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new RemoteMemoryError(
            `Gemdex remote URL must use http or https, got '${parsed.protocol}'.`,
            undefined,
            'network',
        );
    }
    return value.replace(/\/+$/, '');
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1) {
        throw new RemoteMemoryError(`${name} must be a positive integer.`);
    }
    return value;
}

function errorMessage(body: unknown, status: number, statusText: string): string {
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        return body.error;
    }
    return `Gemdex Server returned HTTP ${status}${statusText ? ` ${statusText}` : ''}.`;
}

export class RemoteMemoryBackend implements MemoryBackend {
    private readonly url: string;
    private readonly token: string;
    private readonly timeoutMs: number;
    private readonly maxRequestBytes: number;
    private readonly maxResponseBytes: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: RemoteMemoryBackendOptions) {
        this.url = normalizeUrl(options.url);
        this.token = options.token.trim();
        if (!this.token) {
            throw new RemoteMemoryError('A non-empty bearer token is required for Gemdex remote mode.');
        }
        this.timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
        this.maxRequestBytes = positiveLimit(options.maxRequestBytes, DEFAULT_BODY_LIMIT, 'maxRequestBytes');
        this.maxResponseBytes = positiveLimit(options.maxResponseBytes, DEFAULT_BODY_LIMIT, 'maxResponseBytes');
        this.fetchImpl = options.fetch ?? fetch;
    }

    // Local-mode-only in v1 (see MemoryStore.findSimilarParents): the BYOI
    // server does not run detection yet, so `similar` is simply absent from
    // the response here — `SaveResult`'s `similar` field being optional makes
    // that a type-compatible no-op rather than a wire-contract change.
    async save(input: SaveMemoryInput): Promise<SaveResult> {
        const response = await this.request<{ memory: SaveResult }>('/v1/memories', {
            method: 'POST',
            body: input,
        });
        return this.requireField(response.value, 'memory', '/v1/memories');
    }

    async recall(
        query?: string,
        limit?: number,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        const response = await this.request<{ results: MemoryRecallResult[] }>('/v1/recall', {
            method: 'POST',
            body: {
                ...(query !== undefined && { query }),
                ...(limit !== undefined && { limit }),
                ...(queryAttachments !== undefined && { attachments: queryAttachments }),
            },
        });
        return this.requireField(response.value, 'results', '/v1/recall');
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const path = `/v1/memories/${encodeURIComponent(id)}`;
        const response = await this.request<{ memory: Memory }>(path, {
            method: 'PUT',
            body: input,
        });
        return this.requireField(response.value, 'memory', path);
    }

    async updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const path = `/v1/memories/${encodeURIComponent(id)}/attachments`;
        const response = await this.request<{ memory: Memory }>(path, {
            method: 'PATCH',
            body: { captions },
        });
        return this.requireField(response.value, 'memory', path);
    }

    async get(id: string): Promise<Memory | null> {
        const path = `/v1/memories/${encodeURIComponent(id)}`;
        const response = await this.request<{ memory: Memory }>(path, { allowNotFound: true });
        if (response.value === null) return null;
        return this.requireField(response.value, 'memory', path);
    }

    async list(): Promise<MemorySummary[]> {
        const response = await this.request<{ memories: MemorySummary[] }>('/v1/memories');
        return this.requireField(response.value, 'memories', '/v1/memories');
    }

    async delete(id: string): Promise<void> {
        await this.request(`/v1/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        const response = await this.request<{ records: MemoryExportRecord[] }>('/v1/export');
        return this.requireField(response.value, 'records', '/v1/export');
    }

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        const response = await this.request<ImportRecordsResult>('/v1/import', {
            method: 'POST',
            body: { records },
        });
        if (
            response.value === null ||
            typeof response.value !== 'object' ||
            typeof response.value.imported !== 'number'
        ) {
            throw this.invalidResponse('/v1/import', "missing numeric 'imported' field");
        }
        // Servers pre-dating per-record import errors return only { imported }.
        const failed = typeof response.value.failed === 'number' ? response.value.failed : 0;
        const errors = Array.isArray(response.value.errors) ? response.value.errors : [];
        return { imported: response.value.imported, failed, errors };
    }

    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const path =
            `/v1/memories/${encodeURIComponent(memoryId)}/attachments/${encodeURIComponent(attachmentId)}`;
        const response = await this.request<Buffer>(path, {
            allowNotFound: true,
            responseType: 'bytes',
        });
        if (response.value === null) return null;
        const mimeType = response.headers.get('content-type')?.split(';', 1)[0] || 'application/octet-stream';
        return {
            mimeType,
            byteLength: response.value.length,
            data: response.value,
        };
    }

    private requireField<T extends object, K extends keyof T>(value: T | null, field: K, path: string): T[K] {
        if (value === null || typeof value !== 'object' || !(field in value)) {
            throw this.invalidResponse(path, `missing '${String(field)}' field`);
        }
        return value[field];
    }

    private invalidResponse(path: string, detail: string): RemoteMemoryError {
        return new RemoteMemoryError(
            `Invalid response from Gemdex Server for ${path}: ${detail}.`,
            undefined,
            'invalid_response',
        );
    }

    private async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<RemoteResponse<T>> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let serializedBody: string | undefined;
        if (options.body !== undefined) {
            serializedBody = JSON.stringify(options.body);
            const requestBytes = Buffer.byteLength(serializedBody);
            if (requestBytes > this.maxRequestBytes) {
                clearTimeout(timer);
                throw new RemoteMemoryError(
                    `Remote request body is ${requestBytes} bytes, over the ${this.maxRequestBytes}-byte client limit.`,
                    undefined,
                    'body_too_large',
                );
            }
        }

        let response: Response;
        try {
            response = await this.fetchImpl(`${this.url}${path}`, {
                method: options.method ?? 'GET',
                headers: {
                    'Accept': options.responseType === 'bytes' ? '*/*' : 'application/json',
                    'Authorization': `Bearer ${this.token}`,
                    ...(serializedBody !== undefined && { 'Content-Type': 'application/json' }),
                },
                ...(serializedBody !== undefined && { body: serializedBody }),
                signal: controller.signal,
            });
        } catch (error) {
            clearTimeout(timer);
            if (controller.signal.aborted) {
                throw new RemoteMemoryError(
                    `Gemdex Server request to ${path} timed out after ${this.timeoutMs}ms.`,
                    undefined,
                    'timeout',
                );
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw new RemoteMemoryError(
                `Unable to reach Gemdex Server at ${this.url}: ${detail}`,
                undefined,
                'network',
            );
        }

        let bytes: Uint8Array;
        try {
            bytes = await this.readResponseBody(response, path);
        } catch (error) {
            if (controller.signal.aborted) {
                throw new RemoteMemoryError(
                    `Gemdex Server request to ${path} timed out after ${this.timeoutMs}ms.`,
                    undefined,
                    'timeout',
                );
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
        if (options.allowNotFound && response.status === 404) {
            return { value: null, headers: response.headers };
        }

        if (options.responseType === 'bytes' && response.ok) {
            return { value: Buffer.from(bytes) as T, headers: response.headers };
        }

        let body: unknown = null;
        if (bytes.length > 0) {
            try {
                body = JSON.parse(Buffer.from(bytes).toString('utf8'));
            } catch {
                throw new RemoteMemoryError(
                    `Gemdex Server returned invalid JSON for ${path} (HTTP ${response.status}).`,
                    response.status,
                    'invalid_response',
                );
            }
        }

        if (!response.ok) {
            throw new RemoteMemoryError(
                errorMessage(body, response.status, response.statusText),
                response.status,
            );
        }
        return { value: body as T, headers: response.headers };
    }

    private async readResponseBody(response: Response, path: string): Promise<Uint8Array> {
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
            await response.body?.cancel();
            throw new RemoteMemoryError(
                `Gemdex Server response for ${path} exceeds the ${this.maxResponseBytes}-byte client limit.`,
                response.status,
                'body_too_large',
            );
        }
        if (!response.body) return new Uint8Array();

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > this.maxResponseBytes) {
                await reader.cancel();
                throw new RemoteMemoryError(
                    `Gemdex Server response for ${path} exceeds the ${this.maxResponseBytes}-byte client limit.`,
                    response.status,
                    'body_too_large',
                );
            }
            chunks.push(value);
        }
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result;
    }
}
