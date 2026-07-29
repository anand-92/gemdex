import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MIN_SESSION_CHARS } from './transcript-parser';
import {
    attachTranscriptToRecord,
    buildCleanedTranscriptText,
    hasTranscriptAttachment,
    inferIngestSourceFromPath,
    parseTranscriptPathFromContent,
    readTranscriptAttachment,
    TRANSCRIPT_ATTACHMENT_CAPTION,
    TRANSCRIPT_ATTACHMENT_ID,
    TRANSCRIPT_CLEAN_MIME,
} from './transcript-attachment';

const FILLER = 'x'.repeat(MIN_SESSION_CHARS);

describe('transcript-attachment helpers', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-transcript-att-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeFactorySession(name: string, extraAssistantParts: unknown[] = []): string {
        const filePath = path.join(dir, name);
        const records = [
            {
                type: 'session_start',
                id: 'sess-clean-1',
                title: 'Clean me',
                cwd: '/repo',
            },
            {
                type: 'message',
                id: 'm1',
                timestamp: '2026-03-27T19:12:00.000Z',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `<system-reminder>\nHuge deferred tool schema dump\n</system-reminder>\nPlease fix the bug. ${FILLER}`,
                        },
                    ],
                },
            },
            {
                type: 'message',
                id: 'm2',
                timestamp: '2026-03-27T19:12:27.252Z',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'thinking',
                            signature: 'reasoning_content',
                            signatureProvider: 'openai',
                            thinking: 'I should not appear in the cleaned blob.',
                        },
                        { type: 'text', text: 'Here is the fix.' },
                        ...extraAssistantParts,
                    ],
                },
            },
        ];
        fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
        return filePath;
    }

    it('parses the Full transcript footer path', () => {
        const content = 'Did stuff\n\n---\nFull transcript: /Users/me/.factory/sessions/a.jsonl\n(read this file)';
        expect(parseTranscriptPathFromContent(content)).toBe('/Users/me/.factory/sessions/a.jsonl');
        expect(parseTranscriptPathFromContent('no footer')).toBeNull();
    });

    it('infers source dialect from path', () => {
        expect(inferIngestSourceFromPath('/Users/me/.factory/sessions/x.jsonl')).toBe('factory');
        expect(inferIngestSourceFromPath('/Users/me/.claude/projects/x.jsonl')).toBe('claude');
        expect(inferIngestSourceFromPath('/tmp/custom/sess.jsonl')).toBe('custom');
    });

    it('strips wire-format bloat into plain User/Assistant text', () => {
        const filePath = writeFactorySession('bloated.jsonl', [
            {
                type: 'tool_use',
                id: 't1',
                name: 'Bash',
                input: { command: 'npm test' },
            },
        ]);
        const cleaned = buildCleanedTranscriptText(filePath, { source: 'factory' });
        expect(cleaned).not.toBeNull();
        expect(cleaned!).toContain('User:');
        expect(cleaned!).toContain('Please fix the bug.');
        expect(cleaned!).toContain('Assistant:');
        expect(cleaned!).toContain('Here is the fix.');
        expect(cleaned!).toContain('$ npm test');
        // Bloat that must never land in the stored blob:
        expect(cleaned!).not.toContain('reasoning_content');
        expect(cleaned!).not.toContain('signatureProvider');
        expect(cleaned!).not.toContain('I should not appear');
        expect(cleaned!).not.toContain('system-reminder');
        expect(cleaned!).not.toContain('"type":"message"');
        expect(cleaned!).not.toContain('2293ad7f'); // hypothetical uuid noise
    });

    it('reads a cleaned plain-text attachment (not raw JSONL)', () => {
        const filePath = writeFactorySession('sess.jsonl');
        const att = readTranscriptAttachment(filePath, { source: 'factory' });
        expect(att).not.toBeNull();
        expect(att!.id).toBe(TRANSCRIPT_ATTACHMENT_ID);
        expect(att!.caption).toBe(TRANSCRIPT_ATTACHMENT_CAPTION);
        expect(att!.mimeType).toBe(TRANSCRIPT_CLEAN_MIME);
        const text = Buffer.from(att!.data, 'base64').toString('utf8');
        expect(text).toContain('Here is the fix.');
        expect(text).not.toContain('"type":"thinking"');
    });

    it('returns null for missing files', () => {
        expect(readTranscriptAttachment(path.join(dir, 'missing.jsonl'))).toBeNull();
    });

    it('attachTranscriptToRecord is idempotent and replaces rather than stacking', () => {
        const filePath = writeFactorySession('v1.jsonl');
        const base = {
            id: 'chat:factory:s1',
            title: 'T',
            content: `Done\n\n---\nFull transcript: ${filePath}\n(read this file)`,
            createdAt: 1,
            updatedAt: 2,
        };
        const first = attachTranscriptToRecord(base, { source: 'factory' });
        expect(first.status).toBe('attached');
        expect(first.record.attachments).toHaveLength(1);

        const second = attachTranscriptToRecord(first.record, { source: 'factory' });
        expect(second.status).toBe('already');
        expect(second.record.attachments).toHaveLength(1);

        // Rewrite session with different assistant text, force re-attach.
        fs.writeFileSync(
            filePath,
            `${[
                { type: 'session_start', id: 'sess-clean-1', title: 'Clean me', cwd: '/repo' },
                {
                    type: 'message',
                    message: {
                        role: 'user',
                        content: [{ type: 'text', text: `Please fix the bug. ${FILLER}` }],
                    },
                },
                {
                    type: 'message',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Second version of the fix.' }],
                    },
                },
            ].map((r) => JSON.stringify(r)).join('\n')}\n`,
            'utf8',
        );

        const forced = attachTranscriptToRecord(first.record, { force: true, source: 'factory' });
        expect(forced.status).toBe('attached');
        expect(forced.record.attachments).toHaveLength(1);
        const text = Buffer.from(forced.record.attachments![0].data, 'base64').toString('utf8');
        expect(text).toContain('Second version of the fix.');
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
