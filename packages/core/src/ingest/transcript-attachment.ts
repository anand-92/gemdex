import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryExportAttachment, MemoryExportRecord } from '../memory/types';
import { parseSessionFile, renderTranscript } from './transcript-parser';
import type { IngestSource, SessionTurn } from './types';

/** Caption used for the cleaned session transcript blob on digest memories. */
export const TRANSCRIPT_ATTACHMENT_CAPTION = 'Full transcript (source file)';

/**
 * Stable attachment id for the primary transcript blob so re-ingest / backfill
 * upserts replace the same slot rather than accumulating duplicates.
 */
export const TRANSCRIPT_ATTACHMENT_ID = 'transcript';

/**
 * Cleaned transcripts are plain text (`User:` / `Assistant:` turns), not raw
 * agent JSONL (no message ids, thinking signatures, tool schemas, etc.).
 */
export const TRANSCRIPT_CLEAN_MIME = 'text/plain';

/**
 * Char budget for the stored cleaned transcript. Higher than the digest-model
 * cap so agents can sift a full session; still bounds pathological logs.
 */
export const TRANSCRIPT_ATTACHMENT_CHAR_CAP = 2_000_000;

/**
 * Parse the absolute path footed by `renderDigestMemory`:
 *   `Full transcript: <path>`
 */
export function parseTranscriptPathFromContent(content: string): string | null {
    if (typeof content !== 'string' || content.length === 0) return null;
    const match = content.match(/^Full transcript:\s*(.+)\s*$/m);
    if (!match) return null;
    const filePath = match[1].trim();
    return filePath.length > 0 ? filePath : null;
}

/** True when a memory already has a transcript-style attachment. */
export function hasTranscriptAttachment(
    attachments: Array<{ id?: string; kind?: string; caption?: string; mimeType?: string }> | undefined,
): boolean {
    if (!attachments || attachments.length === 0) return false;
    return attachments.some((att) => {
        if (att.id === TRANSCRIPT_ATTACHMENT_ID) return true;
        if (att.kind === 'file' && typeof att.caption === 'string'
            && /transcript/i.test(att.caption)) {
            return true;
        }
        if (typeof att.caption === 'string' && att.caption === TRANSCRIPT_ATTACHMENT_CAPTION) {
            return true;
        }
        return false;
    });
}

/**
 * Infer ingest dialect from a session file path so backfill (path-only) can
 * parse without a ledger row. Falls back to `custom` (still accepts JSONL).
 */
export function inferIngestSourceFromPath(filePath: string): IngestSource {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/.factory/') || normalized.includes('/factory/sessions/')) {
        return 'factory';
    }
    if (normalized.includes('/.claude/')) return 'claude';
    if (normalized.includes('/.codex/')) return 'codex';
    if (normalized.includes('antigravity')) return 'antigravity';
    return 'custom';
}

/**
 * Strip agent wire-format bloat into a plain-text transcript:
 * user/assistant text, shell commands, write paths, tool errors — no thinking
 * blocks, signature blobs, message ids, system-reminder dumps, or successful
 * tool-result noise. Returns `null` when the file is missing/unreadable/empty
 * or has no meaningful conversation.
 */
export function buildCleanedTranscriptText(
    filePath: string,
    options: { source?: IngestSource; charCap?: number } = {},
): string | null {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return null;
    if (!fs.existsSync(filePath)) return null;
    const source = options.source ?? inferIngestSourceFromPath(filePath);
    const parsed = parseSessionFile(filePath, source);
    if (!parsed || parsed.turns.length === 0) return null;
    const cap = options.charCap ?? TRANSCRIPT_ATTACHMENT_CHAR_CAP;
    const text = renderTranscript(parsed.turns, cap).trim();
    return text.length > 0 ? text : null;
}

/**
 * Read a session file, clean it, and return a portable export attachment, or
 * `null` when the file is missing / unreadable / has nothing useful.
 *
 * Always stores **cleaned plain text**, never the raw JSONL wire log.
 */
export function readTranscriptAttachment(
    filePath: string,
    options: { id?: string; caption?: string; source?: IngestSource } = {},
): MemoryExportAttachment | null {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return null;
    const cleaned = buildCleanedTranscriptText(filePath, {
        ...(options.source !== undefined ? { source: options.source } : {}),
    });
    if (!cleaned) return null;
    const caption = options.caption ?? TRANSCRIPT_ATTACHMENT_CAPTION;
    return {
        id: options.id ?? TRANSCRIPT_ATTACHMENT_ID,
        mimeType: TRANSCRIPT_CLEAN_MIME,
        data: Buffer.from(cleaned, 'utf8').toString('base64'),
        caption,
    };
}

/**
 * Build the transcript attachment from an already-parsed session instead of
 * re-reading a file. The uploaded-session path has bytes, not a path on the
 * ingesting host, and it has already parsed them to produce the digest — so
 * re-reading would be both impossible and wasteful.
 *
 * Returns `null` when the cleaned text is empty, matching
 * {@link readTranscriptAttachment}'s contract.
 */
export function transcriptAttachmentFromTurns(
    turns: SessionTurn[],
    options: { id?: string; caption?: string; charCap?: number } = {},
): MemoryExportAttachment | null {
    if (turns.length === 0) return null;
    const cap = options.charCap ?? TRANSCRIPT_ATTACHMENT_CHAR_CAP;
    const cleaned = renderTranscript(turns, cap).trim();
    if (cleaned.length === 0) return null;
    return {
        id: options.id ?? TRANSCRIPT_ATTACHMENT_ID,
        mimeType: TRANSCRIPT_CLEAN_MIME,
        data: Buffer.from(cleaned, 'utf8').toString('base64'),
        caption: options.caption ?? TRANSCRIPT_ATTACHMENT_CAPTION,
    };
}

export type AttachTranscriptStatus = 'attached' | 'already' | 'missing' | 'no_path';

export interface AttachTranscriptResult {
    record: MemoryExportRecord;
    status: AttachTranscriptStatus;
    /** Absolute path that was considered (when known). */
    filePath?: string;
}

/**
 * Ensure a digest export record carries exactly one transcript attachment.
 * Does not put transcript body into `content`. Replaces any prior transcript
 * attachment rather than accumulating duplicates when `force` is true or when
 * none exists yet.
 */
export function attachTranscriptToRecord(
    record: MemoryExportRecord,
    options: {
        /** Explicit path; otherwise parsed from the content footer. */
        filePath?: string;
        /** Re-read and replace even when a transcript attachment already exists. */
        force?: boolean;
        /** Dialect hint for cleaning; inferred from path when omitted. */
        source?: IngestSource;
    } = {},
): AttachTranscriptResult {
    const existing = Array.isArray(record.attachments) ? [...record.attachments] : [];
    if (!options.force && hasTranscriptAttachment(existing)) {
        return { record, status: 'already' };
    }

    const filePath = options.filePath ?? parseTranscriptPathFromContent(record.content);
    if (!filePath) {
        return { record, status: 'no_path' };
    }

    const attachment = readTranscriptAttachment(filePath, {
        ...(options.source !== undefined ? { source: options.source } : {}),
    });
    if (!attachment) {
        return { record, status: 'missing', filePath };
    }

    // Drop prior transcript slots so re-import stays idempotent (one blob).
    const others = existing.filter((att) => {
        if (att.id === TRANSCRIPT_ATTACHMENT_ID) return false;
        if (att.caption === TRANSCRIPT_ATTACHMENT_CAPTION) return false;
        if (typeof att.caption === 'string' && /transcript/i.test(att.caption)
            && (att.mimeType?.includes('json') || att.mimeType === 'text/plain'
                || path.extname(filePath).toLowerCase() === '.jsonl')) {
            return false;
        }
        return true;
    });

    return {
        record: {
            ...record,
            attachments: [...others, attachment],
        },
        status: 'attached',
        filePath,
    };
}
