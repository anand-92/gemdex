/**
 * Ingest a session transcript supplied as **bytes** rather than as a path on
 * the ingesting host.
 *
 * `IngestManager` is the machine-local pipeline: it scans folders it can `stat`,
 * consults the `~/.gemdex/ingest.json` ledger, and re-reads each file to build
 * the transcript blob. None of that applies when a human uploads a session
 * through the web manager — the file lives on *their* laptop, the host has no
 * folder to scan, and a per-host ledger keyed by absolute path is meaningless
 * for a payload that never had a path here.
 *
 * What is shared, deliberately, is everything that decides *what a memory looks
 * like*: the same `parseJsonlSession` cleaning, the same `SessionDigester`
 * prompt and schema, the same `renderDigestMemory` layout, the same cleaned
 * plain-text transcript attachment, and above all the same deterministic
 * `chat:<source>:<sessionId>` id. That last one is what makes re-uploading a
 * session an upsert instead of a duplicate, and it is why an uploaded session
 * and the same session synced by `gemdex sync-history` collapse onto one memory
 * rather than two.
 */

import {
    SessionDigester,
    memoryIdForSession,
    renderDigestMemory,
} from './digester';
import {
    TRANSCRIPT_ATTACHMENT_ID,
    transcriptAttachmentFromTurns,
} from './transcript-attachment';
import { detectJsonlSessionShape, parseJsonlSession } from './transcript-parser';
import type { IngestSource, IngestTarget, ParsedSession } from './types';
import type { MemoryExportRecord } from '../memory/types';

/**
 * Pointer written into the digest's provenance footer for an uploaded session.
 *
 * The path-based pipeline foots an absolute path, which is exactly right there
 * and exactly wrong here: the uploaded file's path was on the uploader's
 * machine and nothing on the host can open it. Naming the attachment instead
 * gives an agent an instruction it can follow.
 */
export const UPLOADED_TRANSCRIPT_POINTER =
    `read_attachment(id: "${TRANSCRIPT_ATTACHMENT_ID}") on this memory (uploaded session)`;

/** Why an uploaded session produced no memory. */
export type UploadedSessionSkipReason = 'unparseable' | 'trivial';

export interface UploadedSessionFile {
    /** Name as uploaded. Only used for the fallback session id and for reporting. */
    filename: string;
    /** The transcript's raw JSONL text. */
    content: string;
}

export interface UploadedSessionResult {
    filename: string;
    status: 'ingested' | 'skipped' | 'failed';
    /** Set when `status === 'ingested'`. */
    memoryId?: string;
    title?: string;
    source?: IngestSource;
    sessionId?: string;
    /** Set when `status === 'skipped'`. */
    reason?: UploadedSessionSkipReason;
    /** Set when `status === 'failed'`. */
    error?: string;
}

export interface IngestUploadedSessionsOptions {
    files: UploadedSessionFile[];
    digester: SessionDigester;
    target: IngestTarget;
}

/**
 * Derive the session id for an uploaded transcript.
 *
 * The dialect's own id wins whenever the transcript carries one, because that is
 * what makes the memory id agree with a `sync-history` push of the same session.
 * The filename stem is the fallback, matching `sessionIdFromFile` in the
 * path-based parser — agent CLIs name session files after the session id, so in
 * practice the two agree.
 */
export function sessionIdForUpload(filename: string, detected: string | undefined): string {
    if (detected) return detected;
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const stem = base.replace(/\.jsonl$/i, '').trim();
    return stem.length > 0 ? stem : 'unknown-session';
}

/**
 * Parse, clean, digest, and upsert each uploaded transcript.
 *
 * Per-file fault isolation is the point: one malformed upload in a batch of
 * twenty must not lose the other nineteen, and the UI reports per-file status.
 * So a parse failure is a `skipped` result and a digest/import failure is a
 * `failed` result — never a thrown error that collapses the whole request.
 * Files are processed sequentially because each one is a Gemini call the user is
 * paying for and watching; concurrency here would only make a partial failure
 * harder to attribute.
 */
export async function ingestUploadedSessions(
    options: IngestUploadedSessionsOptions,
): Promise<UploadedSessionResult[]> {
    const results: UploadedSessionResult[] = [];
    for (const file of options.files) {
        results.push(await ingestOne(file, options.digester, options.target));
    }
    return results;
}

async function ingestOne(
    file: UploadedSessionFile,
    digester: SessionDigester,
    target: IngestTarget,
): Promise<UploadedSessionResult> {
    let session: ParsedSession | null;
    let source: IngestSource;
    let sessionId: string;
    try {
        const detected = detectJsonlSessionShape(file.content);
        source = detected.source;
        sessionId = sessionIdForUpload(file.filename, detected.sessionId);
        session = parseJsonlSession(file.content, {
            source,
            // No path exists on this host; the filename is what provenance can
            // honestly claim, and `filePath` is never opened on this path.
            filePath: file.filename,
            sessionId,
        });
    } catch (error) {
        return { filename: file.filename, status: 'failed', error: describe(error) };
    }

    if (!session) {
        // `parseJsonlSession` returns null both for "no JSON records at all" and
        // for "parsed fine but under MIN_SESSION_CHARS of real conversation".
        // The distinction matters to the person who uploaded it: one is a wrong
        // file, the other is a session too small to be worth a digest.
        const hasRecords = file.content.split('\n').some((line) => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            try {
                const parsed = JSON.parse(trimmed);
                return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
            } catch {
                return false;
            }
        });
        return {
            filename: file.filename,
            status: 'skipped',
            reason: hasRecords ? 'trivial' : 'unparseable',
            source,
            sessionId,
        };
    }

    try {
        const digest = await digester.digest(session);
        const { turns, ...meta } = session;
        const memoryId = memoryIdForSession(meta);
        const now = Date.now();
        const transcript = transcriptAttachmentFromTurns(turns);
        const record: MemoryExportRecord = {
            id: memoryId,
            title: digest.title,
            content: renderDigestMemory(digest, meta, {
                transcriptPointer: UPLOADED_TRANSCRIPT_POINTER,
            }),
            createdAt: meta.firstTs ?? now,
            updatedAt: meta.lastTs ?? now,
            ...(transcript ? { attachments: [transcript] } : {}),
        };
        const result = await target.importRecords([record]);
        if (result.imported !== 1) {
            const detail = result.errors[0]?.error;
            throw new Error(`the memory store rejected the digest${detail ? `: ${detail}` : ''}`);
        }
        return {
            filename: file.filename,
            status: 'ingested',
            memoryId,
            title: digest.title,
            source: meta.source,
            sessionId: meta.sessionId,
        };
    } catch (error) {
        return { filename: file.filename, status: 'failed', error: describe(error) };
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
