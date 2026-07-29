import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryBackend } from '../memory/backend';
import type { MemoryExportRecord } from '../memory/types';
import { IngestLedgerStore } from './ingest-ledger';
import { ACTIVE_SESSION_WINDOW_MS } from './session-scanner';
import { MIN_SESSION_CHARS } from './transcript-parser';
import { IngestManager, extractResponseText } from './ingest-manager';
import type { SessionDigester } from './digester';

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({})),
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY' },
}));

const FILLER = 'x'.repeat(MIN_SESSION_CHARS);

let dir: string;
let ledger: IngestLedgerStore;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-manager-'));
    ledger = new IngestLedgerStore({ rootDir: path.join(dir, '.gemdex') });
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function writeSession(name: string, sessionId: string): string {
    const filePath = path.join(dir, 'sessions', name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
        JSON.stringify({
            type: 'user',
            sessionId,
            cwd: '/repo',
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role: 'user', content: `task ${FILLER}` },
        }),
        JSON.stringify({
            type: 'assistant',
            sessionId,
            timestamp: '2026-01-01T00:05:00.000Z',
            message: { role: 'assistant', content: 'done' },
        }),
    ].join('\n'), 'utf8');
    const old = (Date.now() - ACTIVE_SESSION_WINDOW_MS - 60_000) / 1000;
    fs.utimesSync(filePath, old, old);
    return filePath;
}

function writeTrivialSession(name: string): string {
    const filePath = path.join(dir, 'sessions', name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
        type: 'session_start',
        id: path.basename(name, '.jsonl'),
        title: 'New Session',
        cwd: '/repo',
    }), 'utf8');
    const old = (Date.now() - ACTIVE_SESSION_WINDOW_MS - 60_000) / 1000;
    fs.utimesSync(filePath, old, old);
    return filePath;
}

function fakeBackend(): MemoryBackend & { imported: MemoryExportRecord[] } {
    const imported: MemoryExportRecord[] = [];
    return {
        imported,
        importRecords: jest.fn(async (records: MemoryExportRecord[]) => {
            imported.push(...records);
            return { imported: records.length };
        }),
        save: jest.fn(), recall: jest.fn(), update: jest.fn(),
        updateAttachmentCaptions: jest.fn(), get: jest.fn(), list: jest.fn(),
        delete: jest.fn(), exportAll: jest.fn(), readAttachment: jest.fn(),
    } as unknown as MemoryBackend & { imported: MemoryExportRecord[] };
}

function fakeDigester(overrides: Partial<Record<string, jest.Mock>> = {}): SessionDigester {
    return {
        model: 'gemini-3.5-flash-lite',
        digest: overrides.digest ?? jest.fn(async () => ({
            title: 'Did a task',
            whatWasDone: 'It got done.',
            howToReproduce: ['step'],
            toolsAndServices: [],
            credentialsAndConfig: [],
            gotchas: [],
        })),
        getClient: overrides.getClient ?? jest.fn(() => ({
            batches: { get: jest.fn(), create: jest.fn(), cancel: jest.fn() },
            files: { upload: jest.fn(), download: jest.fn() },
        })),
    } as unknown as SessionDigester;
}

function manager(digester: SessionDigester): IngestManager {
    return new IngestManager({
        apiKey: 'k',
        ledger,
        createDigester: () => digester,
    });
}

const folders = () => [{ source: 'claude' as const, path: path.join(dir, 'sessions') }];

describe('IngestManager.scan', () => {
    it('reports buckets and cost estimates', () => {
        writeSession('a.jsonl', 'a');
        writeSession('b.jsonl', 'b');
        const result = manager(fakeDigester()).scan(folders());
        expect(result.pendingCount).toBe(2);
        expect(result.buckets.newFiles).toHaveLength(2);
        expect(result.processableFiles).toHaveLength(2);
        expect(result.skippedTrivialFiles).toHaveLength(0);
        expect(result.estimatedInputTokens).toBeGreaterThan(0);
        expect(result.estimates.length).toBeGreaterThan(0);
        expect(result.estimates[0].batchUsd).toBeLessThanOrEqual(result.estimates[0].standardUsd);
    });

    it('reports changed sessions without including them in pending totals', async () => {
        const changedPath = writeSession('old.jsonl', 'old');
        const backend = fakeBackend();
        await manager(fakeDigester()).run({ folders: folders() }, backend);

        // Rewrite with different content so the prompt hash differs.
        fs.appendFileSync(changedPath, `\n${JSON.stringify({
            type: 'user',
            sessionId: 'old',
            timestamp: '2026-01-02T00:00:00.000Z',
            message: { role: 'user', content: `more ${FILLER}` },
        })}`, 'utf8');
        const old = (Date.now() - ACTIVE_SESSION_WINDOW_MS - 30_000) / 1000;
        fs.utimesSync(changedPath, old, old);
        writeSession('new.jsonl', 'new');

        const result = manager(fakeDigester()).scan(folders());
        expect(result.buckets.newFiles).toHaveLength(1);
        expect(result.buckets.changedFiles).toHaveLength(1);
        expect(result.pendingCount).toBe(1);
        expect(result.processableFiles).toHaveLength(1);
        expect(result.estimatedInputTokens).toBeGreaterThan(0);
    });

    it('reconciles mtime churn without content changes back to up to date', async () => {
        const filePath = writeSession('a.jsonl', 'a');
        const backend = fakeBackend();
        await manager(fakeDigester()).run({ folders: folders() }, backend);

        // Touch the file (new mtime, same content) — e.g. a sync/backup tool.
        const old = (Date.now() - ACTIVE_SESSION_WINDOW_MS - 30_000) / 1000;
        fs.utimesSync(filePath, old, old);

        const result = manager(fakeDigester()).scan(folders());
        expect(result.buckets.changedFiles).toHaveLength(0);
        expect(result.buckets.upToDate.map((file) => file.filePath)).toEqual([filePath]);
        expect(result.pendingCount).toBe(0);
        // The ledger self-heals so the next scan passes the cheap mtime check.
        const entry = ledger.getEntry(filePath);
        expect(entry?.mtimeMs).toBe(fs.statSync(filePath).mtimeMs);
    });

    it('excludes trivial session stubs from pending counts and estimates', () => {
        writeSession('real.jsonl', 'real');
        const trivialPath = writeTrivialSession('stub.jsonl');

        const result = manager(fakeDigester()).scan(folders());

        expect(result.buckets.newFiles).toHaveLength(2);
        expect(result.processableFiles).toHaveLength(1);
        expect(result.pendingCount).toBe(1);
        expect(result.skippedTrivialFiles.map((file) => file.filePath)).toEqual([trivialPath]);
        expect(result.estimatedOutputTokens).toBeGreaterThan(0);
    });
});

describe('IngestManager.run — standard mode', () => {
    it('digests pending sessions, upserts deterministic ids, and records the ledger', async () => {
        const filePath = writeSession('a.jsonl', 'sess-a');
        const backend = fakeBackend();
        const mgr = manager(fakeDigester());

        const progress = await mgr.run({ folders: folders() }, backend);
        expect(progress.state).toBe('done');
        expect(progress.processed).toBe(1);
        expect(backend.imported).toHaveLength(1);
        expect(backend.imported[0].id).toBe('chat:claude:sess-a');
        expect(backend.imported[0].content).toContain(`Full transcript: ${filePath}`);
        expect(ledger.getEntry(filePath)?.memoryId).toBe('chat:claude:sess-a');

        // Second run: nothing pending.
        const second = await mgr.run({ folders: folders() }, backend);
        expect(second.total).toBe(0);
        expect(backend.imported).toHaveLength(1);
    });

    it('attaches the full transcript as a non-embedded file blob without inlining it in content', async () => {
        const filePath = writeSession('a.jsonl', 'sess-a');
        const rawTranscript = fs.readFileSync(filePath, 'utf8');
        const backend = fakeBackend();
        await manager(fakeDigester()).run({ folders: folders() }, backend);

        const record = backend.imported[0];
        expect(record.attachments).toHaveLength(1);
        expect(record.attachments![0].id).toBe('transcript');
        expect(record.attachments![0].caption).toBe('Full transcript (source file)');
        expect(record.attachments![0].mimeType).toMatch(/json|ndjson|plain/);
        expect(Buffer.from(record.attachments![0].data, 'base64').toString('utf8')).toBe(rawTranscript);
        // Digest content stays the summary — not the multi-line raw transcript body.
        expect(record.content).not.toContain('"type":"user"');
        expect(record.content).toContain('It got done.');
        expect(record.content).toContain(`Full transcript: ${filePath}`);
    });

    it('records the prompt hash and skips unchanged content instead of re-digesting', async () => {
        const filePath = writeSession('a.jsonl', 'sess-a');
        const backend = fakeBackend();
        const digest = jest.fn(async () => ({
            title: 'ok', whatWasDone: 'w',
            howToReproduce: [], toolsAndServices: [], credentialsAndConfig: [], gotchas: [],
        }));
        const mgr = manager(fakeDigester({ digest }));

        await mgr.run({ folders: folders() }, backend);
        expect(ledger.getEntry(filePath)?.promptHash).toMatch(/^[0-9a-f]{64}$/);
        expect(digest).toHaveBeenCalledTimes(1);

        // mtime churn only — the run must not pay for an identical digest.
        const old = (Date.now() - ACTIVE_SESSION_WINDOW_MS - 30_000) / 1000;
        fs.utimesSync(filePath, old, old);
        const progress = await mgr.run({ folders: folders() }, backend);
        expect(digest).toHaveBeenCalledTimes(1);
        expect(progress.total).toBe(0);
        expect(progress.skipped).toBe(0);
        expect(ledger.getEntry(filePath)?.mtimeMs).not.toBe(fs.statSync(filePath).mtimeMs);
    });

    it('always ingests only new sessions and leaves changed ones untouched', async () => {
        const changedPath = writeSession('old.jsonl', 'old');
        const backend = fakeBackend();
        const mgr = manager(fakeDigester());
        await mgr.run({ folders: folders() }, backend);

        // Genuinely change the old session and add a brand-new one.
        fs.appendFileSync(changedPath, `\n${JSON.stringify({
            type: 'user',
            sessionId: 'old',
            timestamp: '2026-01-02T00:00:00.000Z',
            message: { role: 'user', content: `more ${FILLER}` },
        })}`, 'utf8');
        const old = (Date.now() - ACTIVE_SESSION_WINDOW_MS - 30_000) / 1000;
        fs.utimesSync(changedPath, old, old);
        writeSession('new.jsonl', 'sess-new');

        const before = ledger.getEntry(changedPath);
        const progress = await mgr.run({ folders: folders() }, backend);
        expect(progress.processed).toBe(1);
        expect(backend.imported.map((record) => record.id)).toEqual(['chat:claude:old', 'chat:claude:sess-new']);
        // The changed session stays visible but can never enter a later run.
        expect(ledger.getEntry(changedPath)).toEqual(before);
        const rescan = mgr.scan(folders());
        expect(rescan.buckets.changedFiles.map((file) => file.filePath)).toEqual([changedPath]);
        expect(rescan.pendingCount).toBe(0);
    });

    it('counts failures without aborting the run', async () => {
        writeSession('a.jsonl', 'a');
        writeSession('b.jsonl', 'b');
        // Session "a" always fails (exhausts retries); session "b" succeeds.
        const digest = jest.fn(async (session: { sessionId: string }) => {
            if (session.sessionId === 'a') throw new Error('boom');
            return {
                title: 'ok', whatWasDone: 'w',
                howToReproduce: [], toolsAndServices: [], credentialsAndConfig: [], gotchas: [],
            };
        });
        const backend = fakeBackend();
        const progress = await manager(fakeDigester({ digest })).run({ folders: folders() }, backend);
        expect(progress.processed).toBe(1);
        expect(progress.failed).toBe(1);
    }, 30_000);

    it('rejects concurrent runs and runs with a pending batch', async () => {
        const mgr = manager(fakeDigester());
        ledger.setPendingBatch({ jobName: 'batches/1', model: 'm', submittedAt: 1, requests: {} });
        await expect(mgr.run({ folders: folders() }, fakeBackend())).rejects.toThrow(/batch ingestion job is pending/);
    });
});

describe('IngestManager — batch mode', () => {
    it('uploads a JSONL file, creates the job, and persists the pending batch', async () => {
        writeSession('a.jsonl', 'sess-a');
        const upload = jest.fn(async () => ({ name: 'files/input-1' }));
        const create = jest.fn(async () => ({ name: 'batches/job-1' }));
        const digester = fakeDigester({
            getClient: jest.fn(() => ({
                batches: { create, get: jest.fn(), cancel: jest.fn() },
                files: { upload, download: jest.fn() },
            })),
        });
        const progress = await manager(digester).run(
            { folders: folders(), mode: 'batch' },
            fakeBackend(),
        );
        expect(upload).toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ src: 'files/input-1' }));
        expect(progress.state).toBe('batchPending');
        const pending = ledger.getPendingBatch();
        expect(pending?.jobName).toBe('batches/job-1');
        expect(Object.values(pending!.requests)[0].sessionId).toBe('sess-a');
    });

    it('collect() returns pending until terminal, then saves digests', async () => {
        const filePath = writeSession('a.jsonl', 'sess-a');
        ledger.setPendingBatch({
            jobName: 'batches/job-1',
            model: 'gemini-3.5-flash-lite',
            submittedAt: Date.now(),
            requests: {
                'session-0': {
                    source: 'claude',
                    filePath,
                    mtimeMs: 1,
                    size: 2,
                    sessionId: 'sess-a',
                    sessionMeta: { sessionId: 'sess-a', source: 'claude', filePath, cwd: '/repo' },
                },
            },
        });

        const resultLine = JSON.stringify({
            key: 'session-0',
            response: {
                candidates: [{
                    content: { parts: [{ text: JSON.stringify({ title: 'T', what_was_done: 'W' }) }] },
                }],
            },
        });
        const get = jest.fn()
            .mockResolvedValueOnce({ state: 'JOB_STATE_RUNNING' })
            .mockResolvedValueOnce({ state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out-1' } });
        const download = jest.fn(async ({ downloadPath }: { downloadPath: string }) => {
            fs.writeFileSync(downloadPath, `${resultLine}\n`, 'utf8');
        });
        const digester = fakeDigester({
            getClient: jest.fn(() => ({
                batches: { get, create: jest.fn(), cancel: jest.fn() },
                files: { upload: jest.fn(), download },
            })),
        });
        const backend = fakeBackend();
        const mgr = manager(digester);

        expect((await mgr.collect(backend)).state).toBe('pending');
        const collected = await mgr.collect(backend);
        expect(collected.state).toBe('collected');
        expect(collected.ingested).toBe(1);
        expect(backend.imported[0].id).toBe('chat:claude:sess-a');
        expect(ledger.getPendingBatch()).toBeUndefined();
        expect(ledger.getEntry(filePath)?.memoryId).toBe('chat:claude:sess-a');
    });

    it('collect() clears a failed job', async () => {
        ledger.setPendingBatch({ jobName: 'batches/x', model: 'gemini-3.5-flash-lite', submittedAt: 1, requests: {} });
        const digester = fakeDigester({
            getClient: jest.fn(() => ({
                batches: { get: jest.fn(async () => ({ state: 'JOB_STATE_FAILED', error: { message: 'nope' } })) },
                files: {},
            })),
        });
        const result = await manager(digester).collect(fakeBackend());
        expect(result.state).toBe('failed');
        expect(ledger.getPendingBatch()).toBeUndefined();
    });

    it('cancelBatch() clears the pending job even when the API call fails', async () => {
        ledger.setPendingBatch({ jobName: 'batches/x', model: 'gemini-3.5-flash-lite', submittedAt: 1, requests: {} });
        const digester = fakeDigester({
            getClient: jest.fn(() => ({
                batches: { cancel: jest.fn(async () => { throw new Error('terminal'); }) },
                files: {},
            })),
        });
        expect(await manager(digester).cancelBatch()).toBe(true);
        expect(ledger.getPendingBatch()).toBeUndefined();
    });
});

describe('extractResponseText', () => {
    it('joins candidate text parts', () => {
        expect(extractResponseText({
            candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }],
        })).toBe('ab');
    });

    it('returns null for malformed responses', () => {
        expect(extractResponseText(undefined)).toBeNull();
        expect(extractResponseText({})).toBeNull();
        expect(extractResponseText({ candidates: [{}] })).toBeNull();
    });
});
