import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    attachTranscriptToRecord,
    hasTranscriptAttachment,
    parseTranscriptPathFromContent,
    readTranscriptAttachment,
    TRANSCRIPT_ATTACHMENT_CAPTION,
    TRANSCRIPT_ATTACHMENT_ID,
} from './transcript-attachment';

describe('transcript-attachment helpers', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-transcript-att-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('parses the Full transcript footer path', () => {
        const content = 'Did stuff\n\n---\nFull transcript: /Users/me/.factory/sessions/a.jsonl\n(read this file)';
        expect(parseTranscriptPathFromContent(content)).toBe('/Users/me/.factory/sessions/a.jsonl');
        expect(parseTranscriptPathFromContent('no footer')).toBeNull();
    });

    it('reads a transcript file into a portable attachment', () => {
        const filePath = path.join(dir, 'sess.jsonl');
        fs.writeFileSync(filePath, '{"type":"user"}\n', 'utf8');
        const att = readTranscriptAttachment(filePath);
        expect(att).not.toBeNull();
        expect(att!.id).toBe(TRANSCRIPT_ATTACHMENT_ID);
        expect(att!.caption).toBe(TRANSCRIPT_ATTACHMENT_CAPTION);
        expect(Buffer.from(att!.data, 'base64').toString('utf8')).toBe('{"type":"user"}\n');
        expect(att!.mimeType).toBe('application/x-ndjson');
    });

    it('returns null for missing files', () => {
        expect(readTranscriptAttachment(path.join(dir, 'missing.jsonl'))).toBeNull();
    });

    it('attachTranscriptToRecord is idempotent and replaces rather than stacking', () => {
        const filePath = path.join(dir, 'sess.jsonl');
        fs.writeFileSync(filePath, 'line1\n', 'utf8');
        const base = {
            id: 'chat:factory:s1',
            title: 'T',
            content: `Done\n\n---\nFull transcript: ${filePath}\n(read this file)`,
            createdAt: 1,
            updatedAt: 2,
        };
        const first = attachTranscriptToRecord(base);
        expect(first.status).toBe('attached');
        expect(first.record.attachments).toHaveLength(1);

        const second = attachTranscriptToRecord(first.record);
        expect(second.status).toBe('already');
        expect(second.record.attachments).toHaveLength(1);

        fs.writeFileSync(filePath, 'line2\n', 'utf8');
        const forced = attachTranscriptToRecord(first.record, { force: true });
        expect(forced.status).toBe('attached');
        expect(forced.record.attachments).toHaveLength(1);
        expect(Buffer.from(forced.record.attachments![0].data, 'base64').toString('utf8')).toBe('line2\n');
        expect(hasTranscriptAttachment(forced.record.attachments)).toBe(true);
    });

    it('reports missing when the footer path is gone', () => {
        const missing = path.join(dir, 'gone.jsonl');
        const result = attachTranscriptToRecord({
            id: 'chat:claude:x',
            title: 'T',
            content: `x\nFull transcript: ${missing}\n`,
            createdAt: 1,
            updatedAt: 1,
        });
        expect(result.status).toBe('missing');
        expect(result.record.attachments).toBeUndefined();
    });
});
