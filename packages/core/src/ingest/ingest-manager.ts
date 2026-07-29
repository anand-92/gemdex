import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryBackend } from '../memory/backend';
import type { MemoryExportRecord } from '../memory/types';
import {
    SessionDigester,
    buildDigestPrompt,
    digestBatchRequest,
    estimateCost,
    estimateTokensForChars,
    memoryIdForSession,
    parseDigestResponse,
    renderDigestMemory,
    ESTIMATED_OUTPUT_TOKENS_PER_SESSION,
} from './digester';
import { IngestLedgerStore } from './ingest-ledger';
import { bucketSessionFiles, discoverSessionFiles } from './session-scanner';
import {
    attachTranscriptToRecord,
    readTranscriptAttachment,
    TRANSCRIPT_ATTACHMENT_CAPTION,
} from './transcript-attachment';
import { parseSessionFile } from './transcript-parser';
import {
    IngestLedgerEntry,
    IngestProgress,
    IngestScanResult,
    IngestScanTotals,
    IngestSourceFolder,
    ParsedSession,
    PendingBatchJob,
    PendingBatchRequest,
    SessionDigest,
    SessionFile,
} from './types';

export type IngestMode = 'standard' | 'batch';

export interface IngestRunOptions {
    folders: IngestSourceFolder[];
    model?: string;
    mode?: IngestMode;
}

export interface IngestManagerConfig {
    apiKey: string;
    geminiBaseUrl?: string;
    ledger?: IngestLedgerStore;
    /** Injectable for tests. */
    createDigester?: (model: string | undefined) => SessionDigester;
}

/** Concurrent digest requests in standard mode. */
const STANDARD_CONCURRENCY = 4;
/** Retry attempts per session in standard mode. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

const BATCH_TERMINAL_STATES = new Set([
    'JOB_STATE_SUCCEEDED',
    'JOB_STATE_FAILED',
    'JOB_STATE_CANCELLED',
    'JOB_STATE_EXPIRED',
]);

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingSession {
    file: SessionFile;
    session: ParsedSession;
    promptHash: string;
}

/** Hash of the digest prompt: the exact input the LLM digest depends on. */
function hashDigestPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export interface CollectResult {
    state: 'none' | 'pending' | 'collected' | 'failed';
    jobState?: string;
    ingested?: number;
    failed?: number;
    error?: string;
}

/**
 * Orchestrates chat-history ingestion: scan source folders against the
 * ledger, digest each pending session via Gemini (standard or Batch API),
 * and upsert one memory per session into the active MemoryBackend with the
 * deterministic id `chat:<source>:<sessionId>`.
 *
 * One run at a time; progress is polled via {@link getProgress}.
 */
export class IngestManager {
    private readonly config: IngestManagerConfig;
    private readonly ledger: IngestLedgerStore;
    private progress: IngestProgress = { state: 'idle', processed: 0, failed: 0, skipped: 0, total: 0 };
    private cancelRequested = false;
    private running = false;

    constructor(config: IngestManagerConfig) {
        this.config = config;
        this.ledger = config.ledger ?? new IngestLedgerStore();
    }

    getProgress(): IngestProgress {
        const pending = this.ledger.getPendingBatch();
        if (!this.running && pending) {
            return {
                ...this.progress,
                state: 'batchPending',
                pendingBatch: {
                    jobName: pending.jobName,
                    model: pending.model,
                    submittedAt: pending.submittedAt,
                    requestCount: Object.keys(pending.requests).length,
                },
            };
        }
        return { ...this.progress };
    }

    isRunning(): boolean {
        return this.running;
    }

    cancel(): void {
        this.cancelRequested = true;
    }

    /**
     * Scan source folders, bucket against the ledger, and estimate the cost of
     * never-before-ingested sessions. Changed sessions are reported for
     * transparency but are never processable. Files flagged as changed whose
     * digest prompt hash matches the ledger (mtime/size churn without content
     * changes) are reconciled back into `upToDate` and refreshed.
     */
    scan(folders: IngestSourceFolder[]): IngestScanResult {
        const files = discoverSessionFiles(folders);
        const buckets = bucketSessionFiles(files, this.ledger);
        const ledgerEntries = this.ledger.load().files;
        const refreshedEntries: Record<string, IngestLedgerEntry> = {};

        let newChars = 0;
        const processableFiles: SessionFile[] = [];
        const skippedTrivialFiles: SessionFile[] = [];

        for (const file of buckets.newFiles) {
            const session = this.tryParse(file);
            if (!session) {
                skippedTrivialFiles.push(file);
                continue;
            }
            processableFiles.push(file);
            newChars += buildDigestPrompt(session).length;
        }

        const stillChanged: SessionFile[] = [];
        for (const file of buckets.changedFiles) {
            const session = this.tryParse(file);
            if (!session) {
                stillChanged.push(file);
                continue;
            }
            const prompt = buildDigestPrompt(session);
            const entry = ledgerEntries[file.filePath];
            if (entry?.promptHash !== undefined && entry.promptHash === hashDigestPrompt(prompt)) {
                // The file was touched on disk, but the content the digest
                // depends on is unchanged — self-heal the ledger and move on.
                buckets.upToDate.push(file);
                refreshedEntries[file.filePath] = { ...entry, mtimeMs: file.mtimeMs, size: file.size };
                continue;
            }
            stillChanged.push(file);
        }
        buckets.changedFiles = stillChanged;
        this.ledger.updateEntries(refreshedEntries);

        const totalsFor = (count: number, chars: number): IngestScanTotals => {
            const estimatedInputTokens = estimateTokensForChars(chars);
            const estimatedOutputTokens = count * ESTIMATED_OUTPUT_TOKENS_PER_SESSION;
            return {
                pendingCount: count,
                estimatedInputTokens,
                estimatedOutputTokens,
                estimates: estimateCost(estimatedInputTokens, estimatedOutputTokens),
            };
        };
        return {
            buckets,
            processableFiles,
            skippedTrivialFiles,
            ...totalsFor(processableFiles.length, newChars),
        };
    }

    /**
     * Run ingestion over the pending files in `folders`. Resolves when the
     * run completes (standard) or the batch job has been submitted (batch).
     */
    async run(options: IngestRunOptions, backend: MemoryBackend): Promise<IngestProgress> {
        if (this.running) throw new Error('An ingestion run is already in progress.');
        if (this.ledger.getPendingBatch()) {
            throw new Error('A batch ingestion job is pending. Collect or cancel it first.');
        }
        this.running = true;
        this.cancelRequested = false;
        try {
            const files = discoverSessionFiles(options.folders);
            const buckets = bucketSessionFiles(files, this.ledger);
            // Permanently new-sessions-only: only ledger-absent files are eligible.
            // Prompt-hash reconciliation for mtime churn lives in scan(), not here.
            const pendingFiles = [...buckets.newFiles];

            const sessions: PendingSession[] = [];
            let skipped = 0;
            for (const file of pendingFiles) {
                const session = this.tryParse(file);
                if (!session) {
                    skipped += 1;
                    continue;
                }
                const promptHash = hashDigestPrompt(buildDigestPrompt(session));
                sessions.push({ file, session, promptHash });
            }

            this.progress = {
                state: 'running',
                processed: 0,
                failed: 0,
                skipped,
                total: sessions.length,
            };

            if (sessions.length === 0) {
                this.progress.state = 'done';
                return this.getProgress();
            }

            if ((options.mode ?? 'standard') === 'batch') {
                await this.submitBatch(sessions, options.model);
            } else {
                await this.runStandard(sessions, options.model, backend);
            }
            return this.getProgress();
        } catch (error) {
            this.progress = {
                ...this.progress,
                state: 'failed',
                error: error instanceof Error ? error.message : String(error),
            };
            throw error;
        } finally {
            this.running = false;
        }
    }

    /**
     * Poll a pending batch job and, when complete, download its results and
     * save the digests. Safe to call repeatedly; returns `pending` until the
     * job reaches a terminal state.
     */
    async collect(backend: MemoryBackend): Promise<CollectResult> {
        const pending = this.ledger.getPendingBatch();
        if (!pending) return { state: 'none' };

        const digester = this.createDigester(pending.model);
        const client = digester.getClient();
        const job = await client.batches.get({ name: pending.jobName });
        const jobState = String(job.state ?? 'JOB_STATE_PENDING');
        if (!BATCH_TERMINAL_STATES.has(jobState)) {
            return { state: 'pending', jobState };
        }
        if (jobState !== 'JOB_STATE_SUCCEEDED') {
            this.ledger.setPendingBatch(undefined);
            return {
                state: 'failed',
                jobState,
                error: job.error ? JSON.stringify(job.error) : `Batch job ended in ${jobState}`,
            };
        }

        const resultFileName = job.dest?.fileName;
        if (!resultFileName) {
            this.ledger.setPendingBatch(undefined);
            return { state: 'failed', jobState, error: 'Batch job succeeded but returned no result file.' };
        }

        const downloadPath = path.join(os.tmpdir(), `gemdex-batch-results-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
        let content: string;
        try {
            await client.files.download({ file: resultFileName, downloadPath });
            content = fs.readFileSync(downloadPath, 'utf8');
        } finally {
            fs.rmSync(downloadPath, { force: true });
        }

        let ingested = 0;
        let failed = 0;
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let parsed: any;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                failed += 1;
                continue;
            }
            const key = typeof parsed?.key === 'string' ? parsed.key : undefined;
            const request = key ? pending.requests[key] : undefined;
            if (!request) {
                failed += 1;
                continue;
            }
            const text = extractResponseText(parsed?.response);
            if (!text) {
                failed += 1;
                continue;
            }
            try {
                const digest = parseDigestResponse(text);
                await this.saveDigest(digest, request, backend, pending.model);
                ingested += 1;
            } catch {
                failed += 1;
            }
        }
        this.ledger.setPendingBatch(undefined);
        this.progress = {
            state: 'done',
            processed: ingested,
            failed,
            skipped: 0,
            total: Object.keys(pending.requests).length,
        };
        return { state: 'collected', jobState, ingested, failed };
    }

    /** Cancel a pending batch job (best-effort server-side) and clear it locally. */
    async cancelBatch(): Promise<boolean> {
        const pending = this.ledger.getPendingBatch();
        if (!pending) return false;
        try {
            const digester = this.createDigester(pending.model);
            await digester.getClient().batches.cancel({ name: pending.jobName });
        } catch {
            // Job may already be terminal; clearing the local record is what matters.
        }
        this.ledger.setPendingBatch(undefined);
        return true;
    }

    private createDigester(model: string | undefined): SessionDigester {
        if (this.config.createDigester) return this.config.createDigester(model);
        return new SessionDigester({
            apiKey: this.config.apiKey,
            model,
            baseURL: this.config.geminiBaseUrl,
        });
    }

    private tryParse(file: SessionFile): ParsedSession | null {
        try {
            return parseSessionFile(file.filePath, file.source);
        } catch {
            return null;
        }
    }

    private async runStandard(
        sessions: PendingSession[],
        model: string | undefined,
        backend: MemoryBackend,
    ): Promise<void> {
        const digester = this.createDigester(model);
        const queue = [...sessions];
        const workers = Array.from({ length: Math.min(STANDARD_CONCURRENCY, queue.length) }, async () => {
            for (;;) {
                if (this.cancelRequested) return;
                const item = queue.shift();
                if (!item) return;
                this.progress.currentFile = item.file.filePath;
                try {
                    const digest = await this.digestWithRetry(digester, item.session);
                    await this.saveDigest(digest, {
                        source: item.file.source,
                        filePath: item.file.filePath,
                        mtimeMs: item.file.mtimeMs,
                        size: item.file.size,
                        sessionId: item.session.sessionId,
                        promptHash: item.promptHash,
                        sessionMeta: toSessionMeta(item.session),
                    }, backend, digester.model);
                    this.progress.processed += 1;
                } catch (error) {
                    this.progress.failed += 1;
                    console.error(
                        `[ingest] failed to digest ${item.file.filePath}: ` +
                        (error instanceof Error ? error.message : String(error)),
                    );
                }
            }
        });
        await Promise.all(workers);
        delete this.progress.currentFile;
        this.progress.state = this.cancelRequested ? 'cancelled' : 'done';
    }

    private async digestWithRetry(digester: SessionDigester, session: ParsedSession): Promise<SessionDigest> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (this.cancelRequested) {
                throw new Error('Ingestion cancelled');
            }
            try {
                return await digester.digest(session);
            } catch (error) {
                lastError = error;
                if (attempt < MAX_ATTEMPTS && !this.cancelRequested) {
                    await sleep(RETRY_BASE_DELAY_MS * attempt);
                }
            }
        }
        throw lastError;
    }

    private async saveDigest(
        digest: SessionDigest,
        request: PendingBatchRequest,
        backend: MemoryBackend,
        model: string,
    ): Promise<void> {
        const meta = request.sessionMeta;
        const memoryId = memoryIdForSession(meta);
        const now = Date.now();
        const content = renderDigestMemory(digest, meta);
        // Digest text stays searchable/embeddable; full transcript is a
        // non-embedded blob attachment so hybrid search is not polluted.
        // Cleaned plain-text transcript (no JSONL wire bloat / thinking / signatures).
        const transcript = readTranscriptAttachment(meta.filePath, {
            caption: TRANSCRIPT_ATTACHMENT_CAPTION,
            source: meta.source,
        });
        let record: MemoryExportRecord = {
            id: memoryId,
            title: digest.title,
            content,
            createdAt: meta.firstTs ?? now,
            updatedAt: meta.lastTs ?? now,
            ...(transcript ? { attachments: [transcript] } : {}),
        };
        // If the explicit path failed, still try the content footer (same path).
        if (!transcript) {
            const attached = attachTranscriptToRecord(record, {
                filePath: meta.filePath,
                force: true,
                source: meta.source,
            });
            record = attached.record;
            if (attached.status === 'missing') {
                console.error(
                    `[ingest] transcript file missing or empty after clean for ${memoryId}: ${meta.filePath}`,
                );
            }
        }
        const result = await backend.importRecords([record]);
        if (result.imported !== 1) {
            const detail = result.errors[0]?.error;
            throw new Error(`Backend did not import digest for ${meta.filePath}${detail ? `: ${detail}` : ''}`);
        }
        this.ledger.recordIngested(request.filePath, {
            mtimeMs: request.mtimeMs,
            size: request.size,
            memoryId,
            model,
            ingestedAt: now,
            ...(request.promptHash !== undefined ? { promptHash: request.promptHash } : {}),
        });
    }

    private async submitBatch(sessions: PendingSession[], model: string | undefined): Promise<void> {
        const digester = this.createDigester(model);
        const client = digester.getClient();

        const requests: Record<string, PendingBatchRequest> = {};
        const lines: string[] = [];
        sessions.forEach((item, index) => {
            const key = `session-${index}`;
            requests[key] = {
                source: item.file.source,
                filePath: item.file.filePath,
                mtimeMs: item.file.mtimeMs,
                size: item.file.size,
                sessionId: item.session.sessionId,
                promptHash: item.promptHash,
                sessionMeta: toSessionMeta(item.session),
            };
            lines.push(JSON.stringify({ key, request: digestBatchRequest(item.session) }));
        });

        const uploadPath = path.join(os.tmpdir(), `gemdex-batch-input-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
        let uploadedName: string | undefined;
        try {
            fs.writeFileSync(uploadPath, `${lines.join('\n')}\n`, 'utf8');
            const uploaded = await client.files.upload({
                file: uploadPath,
                config: { displayName: 'gemdex-chat-history-ingest', mimeType: 'jsonl' },
            });
            uploadedName = uploaded.name ?? undefined;
        } finally {
            fs.rmSync(uploadPath, { force: true });
        }
        if (!uploadedName) {
            throw new Error('File upload for the batch job returned no file name.');
        }

        const job = await client.batches.create({
            model: digester.model,
            src: uploadedName,
            config: { displayName: 'gemdex-chat-history-ingest' },
        });
        if (!job.name) {
            throw new Error('Batch job creation returned no job name.');
        }

        const pending: PendingBatchJob = {
            jobName: job.name,
            model: digester.model,
            submittedAt: Date.now(),
            requests,
        };
        this.ledger.setPendingBatch(pending);
        this.progress = {
            state: 'batchPending',
            processed: 0,
            failed: 0,
            skipped: this.progress.skipped,
            total: sessions.length,
            pendingBatch: {
                jobName: pending.jobName,
                model: pending.model,
                submittedAt: pending.submittedAt,
                requestCount: sessions.length,
            },
        };
    }
}

function toSessionMeta(session: ParsedSession) {
    const { turns: _turns, ...meta } = session;
    return meta;
}

/** Pull the text payload out of a (JSON-decoded) GenerateContentResponse. */
export function extractResponseText(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null;
    const candidates = (response as Record<string, unknown>).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const content = (candidates[0] as Record<string, unknown> | undefined)?.content;
    const parts = (content as Record<string, unknown> | undefined)?.parts;
    if (!Array.isArray(parts)) return null;
    const text = parts
        .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined))
        .filter((value): value is string => typeof value === 'string')
        .join('');
    return text || null;
}
