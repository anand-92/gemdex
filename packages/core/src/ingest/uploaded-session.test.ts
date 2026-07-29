import { SessionDigester } from './digester';
import { TRANSCRIPT_ATTACHMENT_ID } from './transcript-attachment';
import { detectJsonlSessionShape } from './transcript-parser';
import type { ImportRecordsResult, MemoryExportRecord } from '../memory/types';
import {
    UPLOADED_TRANSCRIPT_POINTER,
    ingestUploadedSessions,
    sessionIdForUpload,
} from './uploaded-session';

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: { generateContent: jest.fn() },
    })),
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY' },
}));

/** Enough real conversation to clear MIN_SESSION_CHARS. */
const LONG_TEXT = `Set up the notarization pipeline end to end. ${'detail '.repeat(40)}`;

function claudeJsonl(sessionId: string): string {
    return [
        { type: 'permission-mode', permissionMode: 'default' },
        {
            type: 'user',
            timestamp: '2026-05-14T15:01:32.088Z',
            sessionId,
            cwd: '/Users/me/agent',
            gitBranch: 'main',
            message: { role: 'user', content: LONG_TEXT },
        },
        {
            type: 'assistant',
            timestamp: '2026-05-14T15:02:00.000Z',
            sessionId,
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'never stored' },
                    { type: 'text', text: 'Submitting to the notary service.' },
                    {
                        type: 'tool_use',
                        name: 'Bash',
                        input: { command: 'xcrun notarytool submit app.zip' },
                    },
                ],
            },
        },
    ].map((record) => JSON.stringify(record)).join('\n');
}

function factoryJsonl(id: string): string {
    return [
        { type: 'session_start', id, title: 'Wire up the BFF', cwd: '/Users/me/proj' },
        { type: 'message', timestamp: '2026-05-14T15:01:32.088Z', message: { role: 'user', content: LONG_TEXT } },
    ].map((record) => JSON.stringify(record)).join('\n');
}

function codexJsonl(id: string): string {
    return [
        {
            timestamp: '2025-11-18T05:03:32.810Z',
            type: 'session_meta',
            payload: { id, timestamp: '2025-11-18T05:03:32.800Z', cwd: '/Users/me/notes' },
        },
        {
            timestamp: '2025-11-18T05:04:00.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: LONG_TEXT }] },
        },
    ].map((record) => JSON.stringify(record)).join('\n');
}

class RecordingTarget {
    readonly batches: MemoryExportRecord[][] = [];
    result: ImportRecordsResult = { imported: 1, failed: 0, errors: [] };

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        this.batches.push(records);
        return this.result;
    }

    /** Every record ever imported, flattened. */
    all(): MemoryExportRecord[] {
        return this.batches.flat();
    }
}

function digesterReturning(title = 'Notarize the macOS app'): SessionDigester {
    const digester = new SessionDigester({ apiKey: 'k' });
    (digester.getClient().models.generateContent as jest.Mock).mockResolvedValue({
        text: JSON.stringify({
            title,
            what_was_done: 'Submitted the app for notarization.',
            how_to_reproduce: ['xcrun notarytool submit app.zip'],
        }),
    });
    return digester;
}

describe('detectJsonlSessionShape', () => {
    it('identifies each dialect from its own marker record, with the session id it carries', () => {
        expect(detectJsonlSessionShape(claudeJsonl('claude-1')))
            .toEqual({ source: 'claude', sessionId: 'claude-1' });
        expect(detectJsonlSessionShape(factoryJsonl('factory-1')))
            .toEqual({ source: 'factory', sessionId: 'factory-1' });
        expect(detectJsonlSessionShape(codexJsonl('codex-1')))
            .toEqual({ source: 'codex', sessionId: 'codex-1' });
    });

    it('falls back to custom when no dialect marker is present', () => {
        const raw = JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } });
        expect(detectJsonlSessionShape(raw)).toEqual({ source: 'custom' });
    });

    it('ignores unparseable lines rather than failing detection', () => {
        const raw = `not json\n{oops\n${claudeJsonl('claude-2')}`;
        expect(detectJsonlSessionShape(raw)).toEqual({ source: 'claude', sessionId: 'claude-2' });
    });
});

describe('sessionIdForUpload', () => {
    it('prefers the id the transcript claims over the filename', () => {
        expect(sessionIdForUpload('whatever.jsonl', 'from-transcript')).toBe('from-transcript');
    });

    it('falls back to the filename stem, stripped of any directory prefix', () => {
        expect(sessionIdForUpload('abc-123.jsonl', undefined)).toBe('abc-123');
        expect(sessionIdForUpload('sessions/proj/abc-123.jsonl', undefined)).toBe('abc-123');
        expect(sessionIdForUpload('.jsonl', undefined)).toBe('unknown-session');
    });
});

describe('ingestUploadedSessions', () => {
    it('digests an uploaded transcript into a deterministic chat: memory', async () => {
        const target = new RecordingTarget();
        const results = await ingestUploadedSessions({
            files: [{ filename: 'claude-1.jsonl', content: claudeJsonl('claude-1') }],
            digester: digesterReturning(),
            target,
        });

        expect(results).toEqual([
            expect.objectContaining({
                filename: 'claude-1.jsonl',
                status: 'ingested',
                memoryId: 'chat:claude:claude-1',
                title: 'Notarize the macOS app',
                source: 'claude',
                sessionId: 'claude-1',
            }),
        ]);

        const [record] = target.all();
        expect(record.id).toBe('chat:claude:claude-1');
        expect(record.title).toBe('Notarize the macOS app');
        expect(record.content).toContain('Source: Claude Code');
        expect(record.content).toContain('## How to reproduce');
    });

    it('stores the cleaned transcript as one text/plain attachment, not raw JSONL', async () => {
        const target = new RecordingTarget();
        await ingestUploadedSessions({
            files: [{ filename: 'claude-1.jsonl', content: claudeJsonl('claude-1') }],
            digester: digesterReturning(),
            target,
        });

        const [record] = target.all();
        expect(record.attachments).toHaveLength(1);
        const [attachment] = record.attachments!;
        expect(attachment.id).toBe(TRANSCRIPT_ATTACHMENT_ID);
        expect(attachment.mimeType).toBe('text/plain');

        const transcript = Buffer.from(attachment.data, 'base64').toString('utf8');
        expect(transcript).toContain('Submitting to the notary service.');
        expect(transcript).toContain('$ xcrun notarytool submit app.zip');
        // The cleaning is the whole point: wire-format bloat must not survive.
        expect(transcript).not.toContain('never stored');
        expect(transcript).not.toContain('"type"');
    });

    it('foots a read_attachment pointer instead of a path that does not exist on this host', async () => {
        const target = new RecordingTarget();
        await ingestUploadedSessions({
            files: [{ filename: 'claude-1.jsonl', content: claudeJsonl('claude-1') }],
            digester: digesterReturning(),
            target,
        });

        const [record] = target.all();
        expect(record.content).toContain(`Full transcript: ${UPLOADED_TRANSCRIPT_POINTER}`);
        expect(record.content).not.toContain('Full transcript: claude-1.jsonl');
    });

    it('re-uploading the same session upserts one id rather than duplicating', async () => {
        const target = new RecordingTarget();
        const file = { filename: 'claude-1.jsonl', content: claudeJsonl('claude-1') };

        await ingestUploadedSessions({ files: [file], digester: digesterReturning(), target });
        await ingestUploadedSessions({ files: [file], digester: digesterReturning('Renamed title'), target });

        const ids = target.all().map((record) => record.id);
        expect(ids).toEqual(['chat:claude:claude-1', 'chat:claude:claude-1']);
    });

    it('reports a malformed upload as skipped/unparseable without touching the target', async () => {
        const target = new RecordingTarget();
        const results = await ingestUploadedSessions({
            files: [{ filename: 'broken.jsonl', content: 'this is not jsonl at all\n{' }],
            digester: digesterReturning(),
            target,
        });

        expect(results[0]).toEqual(expect.objectContaining({
            filename: 'broken.jsonl',
            status: 'skipped',
            reason: 'unparseable',
        }));
        expect(target.batches).toHaveLength(0);
    });

    it('distinguishes a too-short session from an unparseable one', async () => {
        const target = new RecordingTarget();
        const results = await ingestUploadedSessions({
            files: [{
                filename: 'tiny.jsonl',
                content: JSON.stringify({
                    type: 'user',
                    sessionId: 'tiny-1',
                    message: { role: 'user', content: 'hi' },
                }),
            }],
            digester: digesterReturning(),
            target,
        });

        expect(results[0]).toEqual(expect.objectContaining({
            filename: 'tiny.jsonl',
            status: 'skipped',
            reason: 'trivial',
            source: 'claude',
            sessionId: 'tiny-1',
        }));
        expect(target.batches).toHaveLength(0);
    });

    it('isolates a digest failure to its own file so the rest of the batch still lands', async () => {
        const target = new RecordingTarget();
        const digester = new SessionDigester({ apiKey: 'k' });
        const generateContent = digester.getClient().models.generateContent as jest.Mock;
        generateContent
            .mockRejectedValueOnce(new Error('Gemini is having a day'))
            .mockResolvedValue({ text: JSON.stringify({ title: 'Second', what_was_done: 'W' }) });

        const results = await ingestUploadedSessions({
            files: [
                { filename: 'first.jsonl', content: claudeJsonl('claude-1') },
                { filename: 'second.jsonl', content: factoryJsonl('factory-1') },
            ],
            digester,
            target,
        });

        expect(results[0]).toEqual(expect.objectContaining({
            filename: 'first.jsonl',
            status: 'failed',
            error: 'Gemini is having a day',
        }));
        expect(results[1]).toEqual(expect.objectContaining({
            filename: 'second.jsonl',
            status: 'ingested',
            memoryId: 'chat:factory:factory-1',
        }));
        expect(target.all().map((record) => record.id)).toEqual(['chat:factory:factory-1']);
    });

    it('reports a rejected import as failed rather than claiming success', async () => {
        const target = new RecordingTarget();
        target.result = { imported: 0, failed: 1, errors: [{ index: 0, error: 'embedding refused' }] };

        const results = await ingestUploadedSessions({
            files: [{ filename: 'claude-1.jsonl', content: claudeJsonl('claude-1') }],
            digester: digesterReturning(),
            target,
        });

        expect(results[0].status).toBe('failed');
        expect(results[0].error).toContain('embedding refused');
    });
});
