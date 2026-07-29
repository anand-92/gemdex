import { parseBuffer } from 'music-metadata';
import { PDFDocument } from 'pdf-lib';
import { AttachmentKind, MemoryAttachmentInput } from './types';

/**
 * Validation for inline media attachments before they are embedded/stored.
 *
 * `gemini-embedding-2` accepts text, image, audio, video, and PDF mapped into
 * one space, with documented per-request caps (image ≤ 6, PDF 1 file/≤ 6 pages,
 * audio ≤ 180 s, video ≤ 120 s). We enforce the mimeType allowlist, per-modality
 * counts, and a byte ceiling cheaply (before decoding), then probe the decoded
 * bytes to enforce the precise media limits: PDF page count (≤ 6) via `pdf-lib`
 * and audio/video duration (≤ 180 s / ≤ 120 s) via `music-metadata`. Duration is
 * only enforced when it is actually detectable from the container — some streams
 * carry no usable duration, and we tolerate those rather than reject on a metric
 * we cannot read. The video frame budget (Gemini samples ~1 fps, ≤ 32 frames) is
 * not enforced separately: it is already bounded by the ≤ 120 s duration cap.
 */

const MIME_TO_KIND: Record<string, AttachmentKind> = {
    'image/png': 'image',
    'image/jpeg': 'image',
    'audio/mp3': 'audio',
    'audio/mpeg': 'audio',
    'audio/wav': 'audio',
    'audio/x-wav': 'audio',
    'audio/wave': 'audio',
    'video/mp4': 'video',
    'video/quicktime': 'video',
    'application/pdf': 'pdf',
    // Blob-only (non-embedded) file attachments — transcripts, plain text, JSONL.
    'text/plain': 'file',
    'application/json': 'file',
    'application/jsonl': 'file',
    'application/x-ndjson': 'file',
    'text/x-jsonl': 'file',
};

/** Every mimeType accepted as an attachment. */
export const SUPPORTED_MIME_TYPES: string[] = Object.keys(MIME_TO_KIND);

/**
 * Kinds whose bytes are fed to the multimodal embedding model. `file` is
 * deliberately excluded — those attachments are stored as blobs only.
 */
export const EMBEDDABLE_ATTACHMENT_KINDS: ReadonlySet<AttachmentKind> = new Set([
    'image',
    'audio',
    'video',
    'pdf',
]);

/** True when an attachment's bytes should be embedded (not blob-only). */
export function isEmbeddableAttachmentKind(kind: AttachmentKind): boolean {
    return EMBEDDABLE_ATTACHMENT_KINDS.has(kind);
}

/**
 * File-extension → mimeType, for inferring an attachment's type from a local
 * path when the caller does not pass `mimeType` explicitly. Every value here is
 * one of the supported types above, so an inferred mimeType always validates.
 */
const EXT_TO_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp3': 'audio/mp3',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.qt': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.ndjson': 'application/x-ndjson',
};

/** Every file extension that maps to a supported attachment mimeType. */
export const SUPPORTED_ATTACHMENT_EXTENSIONS: string[] = Object.keys(EXT_TO_MIME);

/** Infer a supported mimeType from a file path's extension, or undefined. */
export function inferMimeTypeFromPath(filePath: string): string | undefined {
    if (typeof filePath !== 'string') return undefined;
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot < 0) return undefined;
    const ext = filePath.slice(lastDot).toLowerCase();
    return EXT_TO_MIME[ext];
}

export interface AttachmentLimits {
    /** Max image attachments per memory (Gemini caps image at 6 per request). */
    maxImages: number;
    /** Max audio attachments per memory. */
    maxAudio: number;
    /** Max video attachments per memory. */
    maxVideo: number;
    /** Max PDF attachments per memory (Gemini caps documents at 1 file/request). */
    maxPdf: number;
    /**
     * Max blob-only `file` attachments per memory (e.g. full chat transcripts).
     * Not embedded; raised independently of Gemini media caps.
     */
    maxFiles: number;
    /** Per-attachment decoded-byte ceiling. */
    maxBytesPerAttachment: number;
    /** Max audio duration in seconds (enforced only when detectable). */
    maxAudioSeconds: number;
    /** Max video duration in seconds (enforced only when detectable). */
    maxVideoSeconds: number;
    /** Max PDF page count. */
    maxPdfPages: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
    maxImages: 6,
    maxAudio: 1,
    maxVideo: 1,
    maxPdf: 1,
    maxFiles: 4,
    maxBytesPerAttachment: 20 * 1024 * 1024,
    maxAudioSeconds: 180,
    maxVideoSeconds: 120,
    maxPdfPages: 6,
};

/** A decoded, validated attachment ready to embed + persist. */
export interface ValidatedAttachment {
    kind: AttachmentKind;
    mimeType: string;
    bytes: Buffer;
    byteLength: number;
    caption?: string;
}

/** Thrown for any caller-correctable problem with an attachments payload. */
export class AttachmentValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AttachmentValidationError';
    }
}

/** Map a mimeType to its modality, or undefined if unsupported. */
export function mimeToKind(mimeType: string): AttachmentKind | undefined {
    if (typeof mimeType !== 'string') return undefined;
    return MIME_TO_KIND[mimeType.toLowerCase()];
}

function decodeBase64(data: string): Buffer {
    // Tolerate a `data:<mime>;base64,<payload>` URL prefix from UIs.
    const payload = data.startsWith('data:') && data.includes(',')
        ? data.slice(data.indexOf(',') + 1)
        : data;
    return Buffer.from(payload, 'base64');
}

/**
 * Enforce the PDF page-count cap on decoded bytes. A file that pdf-lib cannot
 * parse is rejected as malformed (matching the surrounding "caller-correctable"
 * error style) rather than thrown opaquely.
 */
async function enforcePdfPageLimit(bytes: Buffer, index: number, maxPages: number): Promise<void> {
    let pageCount: number;
    try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        pageCount = doc.getPageCount();
    } catch {
        throw new AttachmentValidationError(
            `Attachment #${index + 1} (application/pdf) could not be parsed as a valid PDF.`,
        );
    }
    if (pageCount > maxPages) {
        throw new AttachmentValidationError(
            `Attachment #${index + 1} (application/pdf) has ${pageCount} pages, over the ${maxPages}-page limit.`,
        );
    }
}

/**
 * Enforce an audio/video duration cap on decoded bytes. Duration is read from
 * the container via music-metadata; we only enforce when it is detectable —
 * some containers carry no usable duration, and an unreadable/corrupt stream is
 * tolerated here (the byte ceiling already bounds it) rather than rejected on a
 * metric we cannot determine.
 */
async function enforceDurationLimit(
    bytes: Buffer,
    mimeType: string,
    index: number,
    label: string,
    maxSeconds: number,
): Promise<void> {
    let duration: number | undefined;
    try {
        const meta = await parseBuffer(bytes, { mimeType });
        duration = meta.format.duration;
    } catch {
        // Unparseable/duration-unknown container: tolerate, do not reject.
        return;
    }
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > maxSeconds) {
        throw new AttachmentValidationError(
            `Attachment #${index + 1} (${mimeType}) is ${Math.round(duration)}s long, over the ${label} ` +
            `${maxSeconds}s limit.`,
        );
    }
}

/**
 * Validate + decode an attachments array. Throws AttachmentValidationError on
 * the first problem (unsupported type, empty/oversized bytes, count over cap,
 * PDF over the page limit, or audio/video over the duration limit). Returns the
 * decoded attachments in input order.
 */
export async function validateAttachments(
    attachments: MemoryAttachmentInput[],
    limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): Promise<ValidatedAttachment[]> {
    const result: ValidatedAttachment[] = [];
    const counts: Record<AttachmentKind, number> = { image: 0, audio: 0, video: 0, pdf: 0, file: 0 };
    const capFor: Record<AttachmentKind, number> = {
        image: limits.maxImages,
        audio: limits.maxAudio,
        video: limits.maxVideo,
        pdf: limits.maxPdf,
        file: limits.maxFiles,
    };
    const labelFor: Record<AttachmentKind, string> = {
        image: 'image',
        audio: 'audio',
        video: 'video',
        pdf: 'PDF',
        file: 'file',
    };
    // base64 inflates bytes by ~4/3; reject oversized payloads by string length
    // BEFORE allocating the decoded Buffer so a huge input can't OOM the process.
    const maxBase64Len = Math.ceil(limits.maxBytesPerAttachment * 1.37) + 256;

    for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        if (!att || typeof att.mimeType !== 'string' || typeof att.data !== 'string') {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} must be an object with a string 'mimeType' and base64 'data'.`,
            );
        }

        const kind = mimeToKind(att.mimeType);
        if (!kind) {
            throw new AttachmentValidationError(
                `Unsupported attachment mimeType '${att.mimeType}'. Supported: ${SUPPORTED_MIME_TYPES.join(', ')}.`,
            );
        }

        // Enforce the per-modality cap and the size ceiling before decoding, so
        // an over-cap or oversized payload never gets fully decoded into memory.
        counts[kind] += 1;
        if (counts[kind] > capFor[kind]) {
            throw new AttachmentValidationError(
                `Too many ${labelFor[kind]} attachments (${counts[kind]}); max ${capFor[kind]} per memory.`,
            );
        }
        if (att.data.length > maxBase64Len) {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} (${att.mimeType}) exceeds the ${limits.maxBytesPerAttachment}-byte per-attachment limit.`,
            );
        }

        const bytes = decodeBase64(att.data);
        if (bytes.length === 0) {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} (${att.mimeType}) decoded to 0 bytes; 'data' must be non-empty base64.`,
            );
        }
        if (bytes.length > limits.maxBytesPerAttachment) {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} (${att.mimeType}) is ${bytes.length} bytes, over the ` +
                `${limits.maxBytesPerAttachment}-byte per-attachment limit.`,
            );
        }

        // Probe the decoded bytes for the precise media limits only AFTER the
        // cheap count/byte checks have passed, so the expensive parse never runs
        // on an over-cap or oversized payload.
        if (kind === 'pdf') {
            await enforcePdfPageLimit(bytes, i, limits.maxPdfPages);
        } else if (kind === 'audio') {
            await enforceDurationLimit(bytes, att.mimeType, i, 'audio', limits.maxAudioSeconds);
        } else if (kind === 'video') {
            await enforceDurationLimit(bytes, att.mimeType, i, 'video', limits.maxVideoSeconds);
        }

        const caption = typeof att.caption === 'string' ? att.caption.trim() : '';
        result.push({
            kind,
            mimeType: att.mimeType,
            bytes,
            byteLength: bytes.length,
            ...(caption.length > 0 && { caption }),
        });
    }

    return result;
}
