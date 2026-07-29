import { PDFDocument } from 'pdf-lib';
import {
    validateAttachments,
    AttachmentValidationError,
    SUPPORTED_MIME_TYPES,
    SUPPORTED_ATTACHMENT_EXTENSIONS,
    mimeToKind,
    inferMimeTypeFromPath,
    DEFAULT_ATTACHMENT_LIMITS,
} from './attachment-validator';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

/** Build a base64 PDF with the requested number of blank pages. */
async function pdfWithPages(pages: number): Promise<string> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
    const bytes = await doc.save();
    return Buffer.from(bytes).toString('base64');
}

/**
 * Hand-build a minimal valid PCM WAV with a deterministic duration. The data
 * chunk byte count divided by the byte rate yields the duration in seconds, so
 * we can target a duration above or below a cap without a real recording.
 */
function wavOfDuration(seconds: number): string {
    const sampleRate = 8000;
    const bytesPerSample = 2; // 16-bit mono
    const byteRate = sampleRate * bytesPerSample;
    const dataLen = Math.round(seconds * byteRate);
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); // PCM fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(bytesPerSample, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);
    return buf.toString('base64');
}

describe('validateAttachments', () => {
    it('accepts a supported image, decodes bytes, and trims the caption', async () => {
        const [a] = await validateAttachments([{ mimeType: 'image/png', data: b64('pngbytes'), caption: '  login screen  ' }]);
        expect(a.kind).toBe('image');
        expect(a.byteLength).toBe(Buffer.from('pngbytes').length);
        expect(a.caption).toBe('login screen');
    });

    it('rejects an unsupported mimeType', async () => {
        await expect(validateAttachments([{ mimeType: 'image/gif', data: b64('x') }]))
            .rejects.toThrow(AttachmentValidationError);
    });

    it('rejects empty bytes', async () => {
        await expect(validateAttachments([{ mimeType: 'image/png', data: '' }]))
            .rejects.toThrow(/0 bytes/);
    });

    it('enforces the image count cap', async () => {
        const many = Array.from({ length: 7 }, () => ({ mimeType: 'image/png', data: b64('x') }));
        await expect(validateAttachments(many)).rejects.toThrow(/Too many image/);
    });

    it('enforces the PDF count cap', async () => {
        const onePage = await pdfWithPages(1);
        const pdfs = [
            { mimeType: 'application/pdf', data: onePage },
            { mimeType: 'application/pdf', data: onePage },
        ];
        await expect(validateAttachments(pdfs)).rejects.toThrow(/Too many PDF/);
    });

    it('enforces the per-attachment byte ceiling', async () => {
        const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxBytesPerAttachment: 4 };
        await expect(validateAttachments([{ mimeType: 'image/png', data: b64('12345') }], limits))
            .rejects.toThrow(/per-attachment limit/);
    });

    it('tolerates a data: URL prefix', async () => {
        const [a] = await validateAttachments([{ mimeType: 'image/png', data: `data:image/png;base64,${b64('z')}` }]);
        expect(a.byteLength).toBe(1);
    });

    it('maps mimeTypes to kinds and exposes a non-empty supported list', () => {
        expect(mimeToKind('application/pdf')).toBe('pdf');
        expect(mimeToKind('audio/wav')).toBe('audio');
        expect(mimeToKind('video/mp4')).toBe('video');
        expect(mimeToKind('text/plain')).toBe('file');
        expect(mimeToKind('application/x-ndjson')).toBe('file');
        expect(SUPPORTED_MIME_TYPES.length).toBeGreaterThan(0);
    });

    it('accepts transcript-style file attachments without treating them as media', async () => {
        const [a] = await validateAttachments([{
            mimeType: 'application/x-ndjson',
            data: b64('{"type":"user"}\n'),
            caption: 'Full transcript (source file)',
        }]);
        expect(a.kind).toBe('file');
        expect(a.caption).toBe('Full transcript (source file)');
    });

    it('accepts a PDF at or under the page limit', async () => {
        const [a] = await validateAttachments([{ mimeType: 'application/pdf', data: await pdfWithPages(6) }]);
        expect(a.kind).toBe('pdf');
    });

    it('rejects a PDF over the page limit', async () => {
        await expect(validateAttachments([{ mimeType: 'application/pdf', data: await pdfWithPages(7) }]))
            .rejects.toThrow(/7 pages, over the 6-page limit/);
    });

    it('rejects a PDF that cannot be parsed', async () => {
        await expect(validateAttachments([{ mimeType: 'application/pdf', data: b64('not a real pdf') }]))
            .rejects.toThrow(/could not be parsed as a valid PDF/);
    });

    it('accepts audio under the duration cap', async () => {
        const [a] = await validateAttachments([{ mimeType: 'audio/wav', data: wavOfDuration(2) }]);
        expect(a.kind).toBe('audio');
    });

    it('rejects audio over the duration cap', async () => {
        const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxAudioSeconds: 1 };
        await expect(validateAttachments([{ mimeType: 'audio/wav', data: wavOfDuration(3) }], limits))
            .rejects.toThrow(/over the audio 1s limit/);
    });

    it('tolerates audio whose duration cannot be determined', async () => {
        // A buffer music-metadata cannot read a duration from must not be rejected
        // on duration grounds (the byte ceiling already bounds it).
        const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxAudioSeconds: 1 };
        const [a] = await validateAttachments([{ mimeType: 'audio/wav', data: b64('not really audio') }], limits);
        expect(a.kind).toBe('audio');
    });
});

describe('inferMimeTypeFromPath', () => {
    it('maps each supported extension to a supported mimeType', () => {
        expect(inferMimeTypeFromPath('/a/b/photo.png')).toBe('image/png');
        expect(inferMimeTypeFromPath('clip.mp4')).toBe('video/mp4');
        expect(inferMimeTypeFromPath('rec.mov')).toBe('video/quicktime');
        expect(inferMimeTypeFromPath('doc.pdf')).toBe('application/pdf');
        for (const ext of SUPPORTED_ATTACHMENT_EXTENSIONS) {
            const mime = inferMimeTypeFromPath(`file${ext}`);
            expect(mime).toBeDefined();
            expect(SUPPORTED_MIME_TYPES).toContain(mime);
        }
    });

    it('is case-insensitive on the extension', () => {
        expect(inferMimeTypeFromPath('/x/Photo.JPG')).toBe('image/jpeg');
        expect(inferMimeTypeFromPath('CLIP.MP4')).toBe('video/mp4');
    });

    it('returns undefined for unknown or missing extensions', () => {
        expect(inferMimeTypeFromPath('notes.txt')).toBe('text/plain');
        expect(inferMimeTypeFromPath('session.jsonl')).toBe('application/x-ndjson');
        expect(inferMimeTypeFromPath('archive.gif')).toBeUndefined();
        expect(inferMimeTypeFromPath('README')).toBeUndefined();
    });
});
