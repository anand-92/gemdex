import { HybridSubScores } from '../vectordb';

/**
 * The media modalities `gemini-embedding-2` accepts as inline content. Each
 * supported mimeType maps to exactly one of these (see attachment-validator).
 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'pdf';

/**
 * Inline media supplied by a caller when saving/updating a memory. `data` is
 * base64-encoded bytes; `caption` (optional) is the text that backs the BM25
 * branch for this attachment (falls back to the memory title when omitted).
 */
export interface MemoryAttachmentInput {
    mimeType: string;
    /** base64-encoded bytes. */
    data: string;
    caption?: string;
}

/**
 * Stored-attachment metadata as seen by callers. The raw bytes live on disk as
 * a blob (see BlobStore); fetch them via `MemoryStore.readAttachment` /
 * the sidecar's blob route. `id` is stable within its parent memory.
 */
export interface MemoryAttachment {
    id: string;
    kind: AttachmentKind;
    mimeType: string;
    /** Size of the decoded bytes on disk. */
    byteLength: number;
    caption?: string;
}

/**
 * A stored memory as seen by callers (MCP tools, the desktop sidecar).
 * Only `content`, `title`, and `attachments` are user-facing; the rest is
 * system metadata that is never used for ranking.
 */
export interface Memory {
    id: string;
    title: string;
    content: string;
    /** Inline media attached to this memory (empty when text-only). */
    attachments: MemoryAttachment[];
    /** Epoch milliseconds. */
    createdAt: number;
    /** Epoch milliseconds. */
    updatedAt: number;
}

/** Lightweight memory shape for list/browse views (content truncated). */
export interface MemorySummary {
    id: string;
    title: string;
    preview: string;
    /** Attachment metadata so list views can badge/thumbnail media memories. */
    attachments: MemoryAttachment[];
    createdAt: number;
    updatedAt: number;
}

/** A recall hit: a full parent memory plus its fused relevance score. */
export interface MemoryRecallResult extends Memory {
    score: number;
    /** Per-branch (dense/BM25) rank breakdown from hybrid search, when available. */
    subScores?: HybridSubScores;
}

/**
 * A near-duplicate/conflict candidate surfaced by save-time detection
 * (`MemoryStore.save` → `findSimilarParents`). Uses the same centroid-cosine
 * math and default threshold as memory hygiene clustering — one mental model
 * for "similar" across the product.
 */
export interface SimilarMemoryRef {
    id: string;
    title: string;
    /** Centroid cosine similarity in [0, 1] (hygiene semantics). */
    similarity: number;
    updatedAt: number;
}

/** `save()` result: the created memory plus advisory conflict candidates. */
export interface SaveResult extends Memory {
    /** Present only when detection ran and found candidates >= threshold. */
    similar?: SimilarMemoryRef[];
}

export interface SaveMemoryInput {
    /** Overall caption / BM25 text. Optional when at least one attachment is supplied. */
    content?: string;
    title?: string;
    /** Optional inline media to embed. Requires a multimodal embedding model. */
    attachments?: MemoryAttachmentInput[];
}

export interface UpdateMemoryInput {
    /** Replacement content. Optional when at least one attachment is supplied. */
    content?: string;
    title?: string;
    /** Replacement attachments. When provided, fully replaces prior attachments. */
    attachments?: MemoryAttachmentInput[];
}

/**
 * A caption-only edit for one existing attachment, keyed by its stable
 * per-parent `id`. An empty/whitespace `caption` clears it (the attachment's
 * BM25 text falls back to the memory title). Used by the no-re-embed caption
 * update path — see `MemoryStore.updateAttachmentCaptions`.
 */
export interface AttachmentCaptionUpdate {
    id: string;
    caption?: string;
}

/**
 * Portable attachment shape for export/import. Carries the bytes inline as
 * base64 so a dump round-trips without the on-disk blob directory.
 */
export interface MemoryExportAttachment {
    id?: string;
    mimeType: string;
    /** base64-encoded bytes. */
    data: string;
    caption?: string;
}

/** Raw attachment bytes plus their content type, for rendering/streaming. */
export interface AttachmentBytes {
    mimeType: string;
    byteLength: number;
    caption?: string;
    data: Buffer;
}

/** Record shape used for export/import (§7.5). */
export interface MemoryExportRecord {
    id: string;
    title: string;
    content: string;
    createdAt: number;
    updatedAt: number;
    /** Inline media, base64-encoded, for portable round-trips. */
    attachments?: MemoryExportAttachment[];
}

/** One record that failed to import: which record it was, and why. */
export interface ImportRecordError {
    /** Zero-based position of the record in the import payload. */
    index: number;
    /** The record's id, when it carried one. */
    id?: string;
    error: string;
}

/**
 * `importRecords()` result. Importing is per-record fault-tolerant: a record
 * that throws (embedding/network/validation) is collected into `errors` and
 * the remaining records still import, so one bad record can't abort a large
 * restore. Records with neither content nor attachments are skipped silently
 * (counted in neither `imported` nor `failed`).
 */
export interface ImportRecordsResult {
    imported: number;
    failed: number;
    errors: ImportRecordError[];
}
