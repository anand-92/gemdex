/**
 * Shared types for the chat-history ingestion pipeline: scanning coding-agent
 * session stores (Claude Code, Factory CLI, Codex, Antigravity, custom folders),
 * distilling each session into a digest memory, and tracking what has already
 * been ingested.
 */

import type { ImportRecordsResult, MemoryExportRecord } from '../memory/types';

/** Where a session file came from. Drives the deterministic memory id prefix. */
export type IngestSource = 'claude' | 'factory' | 'codex' | 'antigravity' | 'custom';

/**
 * What ingestion needs from a destination: upsert-by-id of digest records.
 *
 * Deliberately narrower than `MemoryBackend`. Ingestion only ever calls
 * `importRecords`, because the deterministic `chat:<source>:<sessionId>` id is
 * the whole point — `save` would mint a fresh UUID and duplicate the session on
 * every run. Narrowing the parameter lets a destination that is *not* a full
 * backend (e.g. the OAuth-authenticated sync client in `gemdex-mcp`, which can
 * upsert but cannot recall or delete) be an ingestion target, while every
 * `MemoryBackend` still satisfies it structurally.
 */
export interface IngestTarget {
    importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult>;
}

/** A folder to scan for session transcripts. */
export interface IngestSourceFolder {
    source: IngestSource;
    /** Absolute path of the folder to scan recursively. */
    path: string;
}

/** One discovered session file with the metadata the scanner needs. */
export interface SessionFile {
    source: IngestSource;
    /** Absolute path to the transcript. */
    filePath: string;
    /** Last-modified time in epoch milliseconds. */
    mtimeMs: number;
    /** File size in bytes. */
    size: number;
}

/** Scanner output: discovered files bucketed against the ingest ledger. */
export interface ScanBuckets {
    /** Never ingested before. */
    newFiles: SessionFile[];
    /** Ingested before but the file changed since (mtime or size differ). */
    changedFiles: SessionFile[];
    /** Already ingested and unchanged. */
    upToDate: SessionFile[];
    /** Modified too recently — likely an active session; skipped this run. */
    skippedActive: SessionFile[];
}

/** Per-file ledger entry recording a completed ingestion. */
export interface IngestLedgerEntry {
    mtimeMs: number;
    size: number;
    memoryId: string;
    model: string;
    /** Epoch milliseconds when the digest was saved. */
    ingestedAt: number;
    /**
     * SHA-256 of the digest prompt built from the parsed session. When a
     * file's mtime/size churn (sync tools, CLIs rewriting metadata) but the
     * digest-relevant content is identical, a matching hash lets the scanner
     * treat the session as up to date instead of re-ingesting it. Absent on
     * entries written before this field existed.
     */
    promptHash?: string;
}

/** A pending Gemini Batch API job, persisted so collection survives restarts. */
export interface PendingBatchJob {
    /** Gemini batch job resource name, e.g. `batches/123`. */
    jobName: string;
    model: string;
    /** Epoch milliseconds when the job was submitted. */
    submittedAt: number;
    /** Maps each request key to the session file it digests. */
    requests: Record<string, PendingBatchRequest>;
}

export interface PendingBatchRequest {
    source: IngestSource;
    filePath: string;
    mtimeMs: number;
    size: number;
    sessionId: string;
    /** SHA-256 of the digest prompt, recorded into the ledger on save. Absent on jobs submitted before this field existed. */
    promptHash?: string;
    /** Pre-rendered header/footer context so collection doesn't re-parse. */
    sessionMeta: SessionMeta;
}

/** The on-disk ledger shape (`~/.gemdex/ingest.json`). */
export interface IngestLedger {
    version: 1;
    /** Keyed by absolute file path. */
    files: Record<string, IngestLedgerEntry>;
    pendingBatch?: PendingBatchJob;
}

/** One conversational turn extracted from a transcript. */
export interface SessionTurn {
    role: 'user' | 'assistant';
    text: string;
}

/** Metadata about a parsed session used for digest headers and provenance. */
export interface SessionMeta {
    sessionId: string;
    source: IngestSource;
    filePath: string;
    cwd?: string;
    gitBranch?: string;
    title?: string;
    /** Epoch milliseconds of the first/last events, when present. */
    firstTs?: number;
    lastTs?: number;
}

/** A normalized session transcript, independent of the on-disk dialect. */
export interface ParsedSession extends SessionMeta {
    turns: SessionTurn[];
}

/** Structured digest produced by the LLM. */
export interface SessionDigest {
    title: string;
    whatWasDone: string;
    howToReproduce: string[];
    toolsAndServices: string[];
    credentialsAndConfig: string[];
    gotchas: string[];
}

/** Cost estimate for one model at standard and batch pricing. */
export interface ModelCostEstimate {
    model: string;
    /** USD, standard interactive pricing. */
    standardUsd: number;
    /** USD, Batch API pricing (50% of standard). */
    batchUsd: number;
}

/** Pending count and cost estimates for one ingestion scope. */
export interface IngestScanTotals {
    /** Non-trivial sessions that would be processed. */
    pendingCount: number;
    /** Estimated input tokens across pending files. */
    estimatedInputTokens: number;
    /** Estimated output tokens across pending files. */
    estimatedOutputTokens: number;
    estimates: ModelCostEstimate[];
}

/** Result of scanning sources without running ingestion. */
export interface IngestScanResult extends IngestScanTotals {
    buckets: ScanBuckets;
    /** New files that parse into non-trivial sessions and will be processed. */
    processableFiles: SessionFile[];
    /** New files skipped because they did not contain enough real conversation. */
    skippedTrivialFiles: SessionFile[];
}

export type IngestRunState = 'idle' | 'running' | 'batchPending' | 'done' | 'failed' | 'cancelled';

/** Live progress for an in-flight (or finished) ingestion run. */
export interface IngestProgress {
    state: IngestRunState;
    processed: number;
    failed: number;
    skipped: number;
    total: number;
    currentFile?: string;
    error?: string;
    /** Set when a batch job was submitted and is awaiting collection. */
    pendingBatch?: { jobName: string; model: string; submittedAt: number; requestCount: number };
}
