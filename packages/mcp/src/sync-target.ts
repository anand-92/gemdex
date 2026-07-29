import type { ImportRecordsResult, IngestTarget, MemoryExportRecord } from 'gemdex-core';
import { errorMessage } from './errors.js';

/**
 * An {@link IngestTarget} that upserts digests into a **remote host's** pool
 * over the OAuth-protected `/mcp/sync/records` route.
 *
 * Deliberately *not* a `MemoryBackend`: this is a write-only capability. The
 * laptop running sync can create/update chat digests by their deterministic id
 * and nothing else — it cannot list, recall, or delete the host's memories.
 * `IngestTarget` exists precisely so ingestion can accept that narrower thing
 * (see `gemdex-core/src/ingest/types.ts`).
 *
 * Why this route rather than the BYOI `/v1/import`: in the reference deploy the
 * BYOI is loopback-only on the host, and its bearer is a single long-lived
 * full-access secret that must never be copied onto laptops. The MCP endpoint is
 * the only public surface, it authenticates a *person* via OAuth, and the host
 * re-checks the email allowlist on every request.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Records per request. Mirrors the host's `MAX_RECORDS_PER_REQUEST`; a
 * transcript blob is easily megabytes, so batching also keeps a single failed
 * request from costing a whole run's worth of upload.
 */
export const SYNC_BATCH_SIZE = 25;

/** Path of the host's sync route, under `/mcp` so the public edge already routes it. */
export const SYNC_RECORDS_SUFFIX = '/sync/records';

export interface RemoteSyncTargetOptions {
    /** The host's `/mcp` endpoint, e.g. `https://gemdex.example.com/mcp`. */
    mcpUrl: string;
    /**
     * Supplies a bearer, and re-supplies it on a 401. Called per attempt rather
     * than captured once so an access token that expires mid-run (they are
     * short-lived by design) is refreshed instead of failing the run.
     */
    getAccessToken: (options: { forceRefresh: boolean }) => Promise<string>;
    timeoutMs?: number;
    fetch?: typeof fetch;
}

export class RemoteSyncError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'RemoteSyncError';
    }
}

export class RemoteSyncTarget implements IngestTarget {
    private readonly endpoint: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: RemoteSyncTargetOptions) {
        const normalized = options.mcpUrl.replace(/\/+$/, '');
        let parsed: URL;
        try {
            parsed = new URL(normalized);
        } catch {
            throw new RemoteSyncError(`Invalid MCP URL '${options.mcpUrl}'.`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new RemoteSyncError(`MCP URL must use http or https, got '${parsed.protocol}'.`);
        }
        this.endpoint = `${normalized}${SYNC_RECORDS_SUFFIX}`;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchImpl = options.fetch ?? fetch;
    }

    /**
     * Upsert records by id, in batches. Results are summed across batches, and
     * a batch that fails wholesale is reported as per-record errors so the
     * caller sees the same `ImportRecordsResult` shape a local backend returns
     * — the ingest ledger only records sessions whose import actually counted.
     */
    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        const total: ImportRecordsResult = { imported: 0, failed: 0, errors: [] };
        for (let offset = 0; offset < records.length; offset += SYNC_BATCH_SIZE) {
            const batch = records.slice(offset, offset + SYNC_BATCH_SIZE);
            try {
                const result = await this.postBatch(batch);
                total.imported += result.imported;
                total.failed += result.failed;
                for (const error of result.errors) {
                    total.errors.push({ ...error, index: error.index + offset });
                }
            } catch (error) {
                total.failed += batch.length;
                batch.forEach((record, index) => {
                    total.errors.push({ index: offset + index, id: record.id, error: errorMessage(error) });
                });
            }
        }
        return total;
    }

    private async postBatch(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        // First attempt uses a cached token; a 401 means it expired or the
        // host's allowlist changed, so retry exactly once with a fresh one
        // rather than looping (a genuine authorization failure must surface).
        let response = await this.send(records, await this.options.getAccessToken({ forceRefresh: false }));
        if (response.status === 401) {
            response = await this.send(records, await this.options.getAccessToken({ forceRefresh: true }));
        }

        const text = await response.text();
        let body: unknown = null;
        if (text.length > 0) {
            try {
                body = JSON.parse(text);
            } catch {
                throw new RemoteSyncError(
                    `Host returned invalid JSON from ${this.endpoint} (HTTP ${response.status}).`,
                    response.status,
                );
            }
        }

        if (!response.ok) {
            const detail = body && typeof body === 'object' && 'error' in body
                && typeof (body as { error: unknown }).error === 'string'
                ? (body as { error: string }).error
                : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
            throw new RemoteSyncError(`Host rejected the sync request: ${detail}`, response.status);
        }

        if (!body || typeof body !== 'object' || typeof (body as { imported?: unknown }).imported !== 'number') {
            throw new RemoteSyncError(
                `Invalid response from ${this.endpoint}: missing numeric 'imported' field.`,
            );
        }
        const parsed = body as { imported: number; failed?: unknown; errors?: unknown };
        return {
            imported: parsed.imported,
            failed: typeof parsed.failed === 'number' ? parsed.failed : 0,
            errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        };
    }

    private async send(records: MemoryExportRecord[], token: string): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            return await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ records }),
                signal: controller.signal,
            });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new RemoteSyncError(
                    `Sync request to ${this.endpoint} timed out after ${this.timeoutMs}ms.`,
                );
            }
            throw new RemoteSyncError(`Unable to reach the host at ${this.endpoint}: ${errorMessage(error)}`);
        } finally {
            clearTimeout(timer);
        }
    }
}
