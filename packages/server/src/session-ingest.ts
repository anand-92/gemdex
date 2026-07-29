/**
 * `POST /v1/sessions/ingest` — clean + digest + upsert uploaded chat sessions.
 *
 * **Why this route lives on the BYOI server and not in the web BFF.**
 * The web manager's upload view needs the *same* end result as
 * `gemdex sync-history`: a session transcript parsed and cleaned by
 * `gemdex-core`, digested by Gemini, and upserted under the deterministic
 * `chat:<source>:<sessionId>` id. That pipeline is TypeScript inside
 * `gemdex-core`, and the BFF is Python — it cannot import it. Three options
 * were on the table:
 *
 *   (a) ship Node + the built package inside the web image and shell out to a
 *       CLI per upload;
 *   (b) forward the upload to a Node process that owns the pipeline;
 *   (c) reuse `POST /mcp/sync/records`, which already upserts `chat:` records.
 *
 * (c) cannot work alone: that route takes *already-digested* records, and the
 * point of this ticket is that the host does the digesting. (a) means adding a
 * whole second toolchain to the runtime image (the web Dockerfile deliberately
 * drops Node after the SPA build) plus a fork per file, and it would need the
 * Gemini key in the web container — a third place a secret lives.
 *
 * So (b), with the deliberate refinement that the Node process is **the BYOI
 * server we already have** rather than a new one. It is the only container that
 * already holds all three things this work needs — `gemdex-core`, a
 * `GEMINI_API_KEY`, and the memory store — so nothing new is deployed, no
 * secret moves, and the BFF reaches it over the exact bearer channel it already
 * uses for every other call. The one cost is that this route is *not* pure
 * storage plumbing like the rest of `/v1`, which is why it lives in this file
 * rather than in core's shared router: the `gemdex serve` sidecar mounts that
 * router and has its own folder-scanning `/ingest/*` routes for the local case.
 */

import * as http from 'http';
import {
    ATTACHMENT_BODY_LIMIT,
    SessionDigester,
    ingestUploadedSessions,
    readBody,
    sendJson,
} from 'gemdex-core';
import type { MemoryBackend, UploadedSessionFile, UploadedSessionResult } from 'gemdex-core';
import type { ServerConfig } from './config.js';

/** Path this module owns, under the server's `/v1` prefix. */
export const SESSION_INGEST_PATH = '/v1/sessions/ingest';

/**
 * Per-request file cap. Each file is one Gemini digest call made while the
 * uploader's browser waits, so this bounds a single request's latency and spend
 * rather than the total a user may upload — the client sends larger selections
 * in batches.
 */
export const MAX_SESSION_FILES_PER_REQUEST = 25;

/**
 * Per-file transcript cap. Comfortably above the largest real sessions
 * (a very long Claude Code session is a few MB of JSONL) while keeping one
 * malformed multi-hundred-MB upload from being parsed at all.
 */
export const MAX_SESSION_FILE_CHARS = 40 * 1024 * 1024;

export interface SessionIngestSummary {
    results: UploadedSessionResult[];
    ingested: number;
    skipped: number;
    failed: number;
}

class SessionIngestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

/**
 * Validate a `{ files: [{ filename, content }] }` payload.
 *
 * Unknown fields are dropped rather than forwarded, and `filename` is reduced
 * to its basename: it reaches the digest's provenance and the session-id
 * fallback, so a client-supplied `../../etc/passwd` must not survive as a path
 * even though nothing here opens it.
 */
export function validateSessionFiles(body: unknown): UploadedSessionFile[] {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new SessionIngestError("Request body must be a JSON object with a 'files' array", 400);
    }
    const files = (body as Record<string, unknown>).files;
    if (!Array.isArray(files) || files.length === 0) {
        throw new SessionIngestError("'files' must be a non-empty array", 400);
    }
    if (files.length > MAX_SESSION_FILES_PER_REQUEST) {
        throw new SessionIngestError(
            `Too many files: ${files.length} exceeds the ${MAX_SESSION_FILES_PER_REQUEST}-file `
            + 'per-request limit. Send them in smaller batches.',
            400,
        );
    }

    return files.map((file, index) => {
        if (typeof file !== 'object' || file === null || Array.isArray(file)) {
            throw new SessionIngestError(`file #${index + 1} must be an object`, 400);
        }
        const record = file as Record<string, unknown>;
        const filename = typeof record.filename === 'string' ? record.filename.trim() : '';
        if (filename.length === 0) {
            throw new SessionIngestError(`file #${index + 1} requires a non-empty string 'filename'`, 400);
        }
        if (typeof record.content !== 'string') {
            throw new SessionIngestError(`file #${index + 1} requires a string 'content'`, 400);
        }
        if (record.content.length > MAX_SESSION_FILE_CHARS) {
            throw new SessionIngestError(
                `file #${index + 1} ('${basename(filename)}') is ${record.content.length} characters, `
                + `over the ${MAX_SESSION_FILE_CHARS}-character per-file limit.`,
                413,
            );
        }
        return { filename: basename(filename), content: record.content };
    });
}

/** Strip any directory component a client may have sent. */
function basename(filename: string): string {
    return filename.split(/[\\/]/).pop() ?? filename;
}

function summarize(results: UploadedSessionResult[]): SessionIngestSummary {
    return {
        results,
        ingested: results.filter((result) => result.status === 'ingested').length,
        skipped: results.filter((result) => result.status === 'skipped').length,
        failed: results.filter((result) => result.status === 'failed').length,
    };
}

/** The only configuration this route reads: how to reach Gemini. */
export type SessionIngestConfig = Pick<ServerConfig, 'geminiApiKey' | 'geminiBaseUrl'>;

export interface SessionIngestOptions {
    store: MemoryBackend;
    config: SessionIngestConfig;
    corsHeaders: Record<string, string>;
    /** Injectable so route tests never call Gemini. */
    createDigester?: () => SessionDigester;
}

/**
 * Handle the route. Returns `true` when it owned the request.
 *
 * The response is always a per-file summary, never a single pass/fail: a
 * ten-file upload where one transcript is corrupt must report nine successes
 * and one named failure, because the alternative — a 500 for the batch — hides
 * which file was the problem and loses the work already paid for.
 */
export async function handleSessionIngestRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: SessionIngestOptions,
): Promise<boolean> {
    const method = req.method ?? 'GET';
    if (method !== 'POST') {
        sendJson(res, 405, { error: `Method ${method} not allowed on ${SESSION_INGEST_PATH}` }, options.corsHeaders);
        return true;
    }

    // Digestion is a Gemini call, so this route needs the key even though the
    // rest of /v1 can serve reads without one. 503 (not 500) because it is a
    // deployment gap the operator can fix, not a request fault. Resolved before
    // the body is read: there is no reason to buffer megabytes of transcript
    // that cannot be processed.
    const apiKey = options.config.geminiApiKey;
    const createDigester = options.createDigester
        ?? (apiKey
            ? (): SessionDigester => new SessionDigester({
                apiKey,
                ...(options.config.geminiBaseUrl && { baseURL: options.config.geminiBaseUrl }),
            })
            : null);
    if (!createDigester) {
        sendJson(
            res,
            503,
            {
                error: 'GEMINI_API_KEY is required on gemdex-server to digest uploaded sessions. '
                    + 'Set it in the server environment and restart.',
            },
            options.corsHeaders,
        );
        return true;
    }

    let files: UploadedSessionFile[];
    try {
        files = validateSessionFiles(await readBody(req, ATTACHMENT_BODY_LIMIT));
    } catch (error) {
        if (error instanceof SessionIngestError) {
            sendJson(res, error.status, { error: error.message }, options.corsHeaders);
            return true;
        }
        throw error;
    }

    const results = await ingestUploadedSessions({
        files,
        digester: createDigester(),
        target: options.store,
    });
    sendJson(res, 200, summarize(results), options.corsHeaders);
    return true;
}
