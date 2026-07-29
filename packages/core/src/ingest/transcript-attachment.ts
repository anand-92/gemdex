import * as fs from 'node:fs';
import * as path from 'node:path';
import { inferMimeTypeFromPath } from '../memory/attachment-validator';
import type { MemoryExportAttachment, MemoryExportRecord } from '../memory/types';

/** Caption used for the full-session transcript blob on digest memories. */
export const TRANSCRIPT_ATTACHMENT_CAPTION = 'Full transcript (source file)';

/**
 * Stable attachment id for the primary transcript blob so re-ingest / backfill
 * upserts replace the same slot rather than accumulating duplicates.
 */
export const TRANSCRIPT_ATTACHMENT_ID = 'transcript';

/** Default mime when the transcript path has no recognized extension. */
export const TRANSCRIPT_DEFAULT_MIME = 'application/x-ndjson';

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
 * Infer a blob-only mime type for a transcript path. Falls back to NDJSON for
 * session logs (Claude/Factory/Codex style `.jsonl`).
 */
export function transcriptMimeForPath(filePath: string): string {
    return inferMimeTypeFromPath(filePath) ?? TRANSCRIPT_DEFAULT_MIME;
}

/**
 * Read a transcript file from disk and return a portable export attachment, or
 * `null` when the file is missing / unreadable / empty.
 */
export function readTranscriptAttachment(
    filePath: string,
    options: { id?: string; caption?: string } = {},
): MemoryExportAttachment | null {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return null;
    let bytes: Buffer;
    try {
        bytes = fs.readFileSync(filePath);
    } catch {
        return null;
    }
    if (bytes.length === 0) return null;
    const caption = options.caption ?? TRANSCRIPT_ATTACHMENT_CAPTION;
    return {
        id: options.id ?? TRANSCRIPT_ATTACHMENT_ID,
        mimeType: transcriptMimeForPath(filePath),
        data: bytes.toString('base64'),
        caption,
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

    const attachment = readTranscriptAttachment(filePath);
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
