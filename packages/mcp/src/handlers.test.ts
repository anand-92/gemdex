import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    ImportRecordsResult,
    Memory,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    MemoryAttachmentInput,
    SaveMemoryInput,
    SaveResult,
    SimilarMemoryRef,
    UpdateMemoryInput,
} from 'gemdex-core';
import { MemoryStatsStore } from 'gemdex-core';
import { MemoryToolHandlers } from './handlers.js';

/** Minimal in-memory backend that records update calls for assertions. */
class FakeBackend implements MemoryBackend {
    memory: Memory | null;
    lastUpdate?: { id: string; input: UpdateMemoryInput };
    recallResults: MemoryRecallResult[] = [];
    listResults: MemorySummary[] = [];
    saveResult?: SaveResult;
    /** Optional attachment bytes keyed by `${memoryId}::${attachmentId}`. */
    attachmentBytes = new Map<string, AttachmentBytes>();

    constructor(initial: Memory | null) {
        this.memory = initial;
    }

    async save(input: SaveMemoryInput): Promise<SaveResult> {
        if (this.saveResult) return this.saveResult;
        void input;
        throw new Error('not implemented');
    }

    async recall(
        _query?: string,
        _limit?: number,
        _queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        return this.recallResults;
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        this.lastUpdate = { id, input };
        if (!this.memory || this.memory.id !== id) throw new Error(`Memory not found: ${id}`);
        this.memory = {
            ...this.memory,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.title !== undefined && { title: input.title }),
            updatedAt: this.memory.updatedAt + 1,
        };
        return this.memory;
    }

    async updateAttachmentCaptions(_id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        throw new Error('not implemented');
    }

    async get(id: string): Promise<Memory | null> {
        return this.memory && this.memory.id === id ? this.memory : null;
    }

    async list(): Promise<MemorySummary[]> {
        return this.listResults;
    }

    async delete(_id: string): Promise<void> {}

    async exportAll(): Promise<MemoryExportRecord[]> {
        return [];
    }

    async importRecords(_records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        return { imported: 0, failed: 0, errors: [] };
    }

    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        return this.attachmentBytes.get(`${memoryId}::${attachmentId}`) ?? null;
    }
}

/** Fresh MemoryStatsStore backed by a throwaway tmpdir, for test isolation. */
function makeStatsStore(): { statsStore: MemoryStatsStore; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-handlers-stats-'));
    const statsStore = new MemoryStatsStore(path.join(dir, 'stats.json'));
    return { statsStore, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A stats store whose reads/writes always throw, to prove failures are swallowed. */
class ThrowingStatsStore extends MemoryStatsStore {
    constructor() {
        super(path.join(os.tmpdir(), 'gemdex-handlers-throwing-stats-unused.json'));
    }
    override get(_id: string): never {
        throw new Error('simulated stats read failure');
    }
    override recordRecall(_ids: string[], _now?: number): never {
        throw new Error('simulated stats write failure');
    }
}

function makeMemory(content: string): Memory {
    return { id: 'mem-1', title: 'Note', content, attachments: [], createdAt: 1, updatedAt: 1 };
}

test('update_memory applies edits against current content via get → update', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('line one\nline two\nline three'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'line two', newText: 'LINE TWO' }],
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Updated memory/);
    assert.equal(backend.lastUpdate?.input.content, 'line one\nLINE TWO\nline three');
    // title/attachments untouched, so the store preserves them.
    assert.equal(backend.lastUpdate?.input.title, undefined);
    assert.equal(backend.lastUpdate?.input.attachments, undefined);
    cleanup();
});

test('update_memory edits can be combined with a new title', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('alpha beta'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'beta', newText: 'gamma' }],
        title: 'Renamed',
    });

    assert.equal(result.isError, undefined);
    assert.equal(backend.lastUpdate?.input.content, 'alpha gamma');
    assert.equal(backend.lastUpdate?.input.title, 'Renamed');
    cleanup();
});

test('update_memory rejects content and edits together', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('text'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        content: 'whole new text',
        edits: [{ oldText: 'text', newText: 'x' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not both/);
    assert.equal(backend.lastUpdate, undefined);
    cleanup();
});

test('update_memory surfaces a clean error when an edit does not match', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('hello world'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'absent', newText: 'x' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found in memory content/);
    assert.equal(backend.lastUpdate, undefined);
    cleanup();
});

test('update_memory with edits returns not-found for an unknown id', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({
        id: 'missing',
        edits: [{ oldText: 'a', newText: 'b' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Memory not found: missing/);
    assert.equal(backend.lastUpdate, undefined);
    cleanup();
});

test('update_memory rejects a malformed edits shape', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('text'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'text' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /string 'oldText' and 'newText'/);
    assert.equal(backend.lastUpdate, undefined);
    cleanup();
});

test('update_memory requires at least one updatable field', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('text'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleUpdateMemory({ id: 'mem-1' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'content', 'edits', 'title', or 'attachments'/);
    cleanup();
});

function makeRecallHit(over: Partial<MemoryRecallResult>): MemoryRecallResult {
    return {
        id: 'mem-1',
        title: 'Note',
        content: 'the full content body',
        attachments: [],
        createdAt: 1,
        updatedAt: Date.now(),
        score: 0.5,
        ...over,
    };
}

test('recall returns titles + ids only — never the body', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    const longBody = 'the full content body that must not leak into the title index';
    backend.recallResults = [
        makeRecallHit({
            title: 'Login flow playbook',
            content: longBody,
            updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
            attachments: [{ id: '0', kind: 'image', mimeType: 'image/png', byteLength: 10, caption: 'login bug' }],
        }),
    ];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleRecall({ query: 'login' });
    const text = result.content[0].text;

    assert.equal(result.isError, undefined);
    assert.match(text, /Login flow playbook/);
    assert.match(text, /id: mem-1/);
    assert.match(text, /titles only/);
    assert.ok(!text.includes(longBody), 'body must never appear in recall output');
    assert.ok(!text.includes('updated:'), 'age is not part of the title index');
    assert.ok(!text.includes('attachments:'), 'attachment details are not part of the title index');
    assert.ok(!text.includes('Scores:'), 'score lines are not part of the title index');
    cleanup();
});

test('recall requires a non-empty query', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const handlers = new MemoryToolHandlers(new FakeBackend(null), statsStore);

    const missing = await handlers.handleRecall({});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /'query' is required/);

    const blank = await handlers.handleRecall({ query: '   ' });
    assert.equal(blank.isError, true);
    assert.match(blank.content[0].text, /'query' is required/);
    cleanup();
});

test('get_memory returns full body, age, attachments, and bumps recall stats', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const memory: Memory = {
        id: 'mem-1',
        title: 'Login flow playbook',
        content: 'the full content body',
        attachments: [{ id: '0', kind: 'image', mimeType: 'image/png', byteLength: 10, caption: 'login bug' }],
        createdAt: 1,
        updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    };
    const backend = new FakeBackend(memory);
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleGetMemory({ id: 'mem-1' });
    const text = result.content[0].text;

    assert.equal(result.isError, undefined);
    assert.match(text, /^Login flow playbook/m);
    assert.match(text, /id: mem-1/);
    assert.match(text, /updated: 3d ago/);
    assert.match(text, /attachments: image \(id 0: "login bug"\)/);
    assert.match(text, /the full content body/);
    assert.equal(statsStore.get('mem-1')?.recallCount, 1);
    cleanup();
});

test('get_memory returns not-found for an unknown id and does not bump stats', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const handlers = new MemoryToolHandlers(new FakeBackend(null), statsStore);

    const result = await handlers.handleGetMemory({ id: 'missing' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Memory not found: missing/);
    assert.equal(statsStore.get('missing'), undefined);
    cleanup();
});

test('get_memory requires an id', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const handlers = new MemoryToolHandlers(new FakeBackend(null), statsStore);

    const result = await handlers.handleGetMemory({});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'id' is required/);
    cleanup();
});

// ---------------------------------------------------------------------------
// save_memory: similar-memory advisory block (spec: save-time detection, #109)
// ---------------------------------------------------------------------------

function makeSimilarRef(over: Partial<SimilarMemoryRef>): SimilarMemoryRef {
    return { id: 'existing-1', title: 'Existing memory', similarity: 0.94, updatedAt: Date.now(), ...over };
}

test('save_memory renders the ⚠ similar-memories advisory block when the backend reports one', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.saveResult = {
        id: 'new-1',
        title: 'New memory',
        content: 'x',
        attachments: [],
        createdAt: 1,
        updatedAt: 1,
        similar: [makeSimilarRef({ id: 'existing-1', title: 'Notarization workflow', similarity: 0.94, updatedAt: Date.now() - 21 * 24 * 60 * 60 * 1000 })],
    };
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleSaveMemory({ content: 'about to duplicate something' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Saved memory\./);
    assert.match(result.content[0].text, /id: new-1/);
    assert.match(result.content[0].text, /⚠ similar existing memories already stored:/);
    assert.match(result.content[0].text, /"Notarization workflow" \(id existing-1, updated 3w ago, 0\.94 similar\)/);
    assert.match(result.content[0].text, /update_memory the existing id/);
    cleanup();
});

test('save_memory omits the advisory block entirely when the backend reports no similar candidates', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.saveResult = { id: 'new-1', title: 'New memory', content: 'x', attachments: [], createdAt: 1, updatedAt: 1 };
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleSaveMemory({ content: 'unique content' });

    assert.equal(result.isError, undefined);
    assert.ok(!result.content[0].text.includes('similar'), 'no similar-memories text when the field is absent');
    cleanup();
});

test('save_memory renders multiple similar candidates in order', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.saveResult = {
        id: 'new-1',
        title: 'New memory',
        content: 'x',
        attachments: [],
        createdAt: 1,
        updatedAt: 1,
        similar: [
            makeSimilarRef({ id: 'a', title: 'First', similarity: 0.97 }),
            makeSimilarRef({ id: 'b', title: 'Second', similarity: 0.91 }),
        ],
    };
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleSaveMemory({ content: 'dup' });
    const text = result.content[0].text;

    assert.match(text, /1\. "First"/);
    assert.match(text, /2\. "Second"/);
    cleanup();
});

// ---------------------------------------------------------------------------
// read_attachment (Option C: transcript / blob fetch)
// ---------------------------------------------------------------------------

test('read_attachment returns utf-8 transcript text for a single file attachment', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const body = '{"type":"user","message":"hello"}\n';
    const memory: Memory = {
        id: 'chat:factory:s1',
        title: 'Did a task',
        content: 'Summary\n\n---\nFull transcript: /tmp/x.jsonl\n',
        attachments: [{
            id: 'transcript',
            kind: 'file',
            mimeType: 'application/x-ndjson',
            byteLength: Buffer.byteLength(body),
            caption: 'Full transcript (source file)',
        }],
        createdAt: 1,
        updatedAt: 1,
    };
    const backend = new FakeBackend(memory);
    backend.attachmentBytes.set('chat:factory:s1::transcript', {
        mimeType: 'application/x-ndjson',
        byteLength: Buffer.byteLength(body),
        caption: 'Full transcript (source file)',
        data: Buffer.from(body),
    });
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleReadAttachment({ memory_id: 'chat:factory:s1' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /encoding: utf-8/);
    assert.match(result.content[0].text, /hello/);
    assert.match(result.content[0].text, /caption: Full transcript \(source file\)/);
    cleanup();
});

test('read_attachment truncates when max_chars is small', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const body = 'abcdefghij';
    const memory: Memory = {
        id: 'mem-1',
        title: 'T',
        content: 'c',
        attachments: [{ id: '0', kind: 'file', mimeType: 'text/plain', byteLength: 10 }],
        createdAt: 1,
        updatedAt: 1,
    };
    const backend = new FakeBackend(memory);
    backend.attachmentBytes.set('mem-1::0', {
        mimeType: 'text/plain',
        byteLength: 10,
        data: Buffer.from(body),
    });
    const handlers = new MemoryToolHandlers(backend, statsStore);
    const result = await handlers.handleReadAttachment({ memory_id: 'mem-1', max_chars: 4 });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /truncated: true/);
    assert.match(result.content[0].text, /abcd/);
    assert.doesNotMatch(result.content[0].text, /abcdefghij/);
    cleanup();
});

test('read_attachment requires memory_id and errors on missing memory', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const handlers = new MemoryToolHandlers(new FakeBackend(null), statsStore);
    const missingArg = await handlers.handleReadAttachment({});
    assert.equal(missingArg.isError, true);
    assert.match(missingArg.content[0].text, /memory_id/);
    const missingMem = await handlers.handleReadAttachment({ memory_id: 'nope' });
    assert.equal(missingMem.isError, true);
    assert.match(missingMem.content[0].text, /Memory not found/);
    cleanup();
});

// ---------------------------------------------------------------------------
// report_outcome (spec: outcome feedback loop, #108)
// ---------------------------------------------------------------------------

test('report_outcome happy path records the outcome and confirms the track record', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('some content'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    // Simulate two prior recalls before the outcome report.
    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);

    const result = await handlers.handleReportOutcome({ id: 'mem-1', outcome: 'worked', note: 'did the thing' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Recorded outcome for "Note"\./);
    assert.match(result.content[0].text, /id: mem-1/);
    assert.match(result.content[0].text, /track record: recalled 2×, worked 1×, failed 0×, stale 0×/);
    assert.equal(statsStore.get('mem-1')?.lastOutcome?.note, 'did the thing');
    cleanup();
});

test('report_outcome returns a clean error for an unknown memory id', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleReportOutcome({ id: 'does-not-exist', outcome: 'worked' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Failed to report outcome: Memory not found: does-not-exist/);
    // A junk id must never pollute the ledger.
    assert.equal(statsStore.get('does-not-exist'), undefined);
    cleanup();
});

test('report_outcome rejects a bad outcome enum value', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('x'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleReportOutcome({ id: 'mem-1', outcome: 'sort-of-worked' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'worked', 'failed', or 'stale'/);
    assert.equal(statsStore.get('mem-1'), undefined);
    cleanup();
});

test('report_outcome requires an id', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('x'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleReportOutcome({ outcome: 'worked' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'id' is required/);
    cleanup();
});

test('report_outcome rejects a non-string note', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('x'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleReportOutcome({ id: 'mem-1', outcome: 'worked', note: 12345 });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'note' must be a string/);
    cleanup();
});

test('report_outcome caps an overlong note at 500 characters', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(makeMemory('x'));
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleReportOutcome({ id: 'mem-1', outcome: 'failed', note: 'z'.repeat(600) });

    assert.equal(result.isError, undefined);
    assert.equal(statsStore.get('mem-1')?.lastOutcome?.note?.length, 500);
    cleanup();
});

// ---------------------------------------------------------------------------
// recall title index: no stats bump; track-record line when stats already exist
// ---------------------------------------------------------------------------

test('recall does not bump recallCount (only get_memory does)', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1' }), makeRecallHit({ id: 'mem-2' })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    await handlers.handleRecall({ query: 'anything' });
    await handlers.handleRecall({ query: 'anything again' });

    assert.equal(statsStore.get('mem-1'), undefined);
    assert.equal(statsStore.get('mem-2'), undefined);
    cleanup();
});

test('recall never breaks when the stats store throws on read', async () => {
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1', title: 'Survives stats failure' })];
    const handlers = new MemoryToolHandlers(backend, new ThrowingStatsStore());

    const result = await handlers.handleRecall({ query: 'anything' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Survives stats failure/);
    assert.ok(!result.content[0].text.includes('the full content body'));
});

test('get_memory never breaks when the stats store throws on write', async () => {
    const backend = new FakeBackend(makeMemory('full body still returned'));
    const handlers = new MemoryToolHandlers(backend, new ThrowingStatsStore());

    const result = await handlers.handleGetMemory({ id: 'mem-1' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /full body still returned/);
});

test('recall track-record line is absent when no stats exist for a hit', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'never-opened-before', title: 'Fresh hit' })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleRecall({ query: 'anything' });

    assert.match(result.content[0].text, /Fresh hit/);
    assert.ok(!result.content[0].text.includes('track record'), 'no track-record line without prior stats');
    cleanup();
});

test('recall track-record line shows non-zero tallies and the last-outcome age', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1' })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);
    statsStore.recordRecall(['mem-1']);
    statsStore.recordOutcome('mem-1', 'worked', undefined, Date.now() - 2 * 24 * 60 * 60 * 1000);
    statsStore.recordOutcome('mem-1', 'worked', undefined, Date.now() - 2 * 24 * 60 * 60 * 1000);
    statsStore.recordOutcome('mem-1', 'worked', undefined, Date.now() - 2 * 24 * 60 * 60 * 1000);

    const result = await handlers.handleRecall({ query: 'anything' });

    assert.match(result.content[0].text, /track record: recalled 7×, worked 3× \(last: worked 2d ago\)/);
    assert.ok(!result.content[0].text.includes('⚠'));
    cleanup();
});

test('recall track-record line shows the ⚠ prefix and always includes failed/stale once either is non-zero', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1' })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    for (let i = 0; i < 9; i++) statsStore.recordRecall(['mem-1']);
    statsStore.recordOutcome('mem-1', 'worked');
    statsStore.recordOutcome('mem-1', 'failed', undefined, Date.now() - 4 * 60 * 60 * 1000);
    statsStore.recordOutcome('mem-1', 'failed', undefined, Date.now() - 4 * 60 * 60 * 1000);
    statsStore.recordOutcome('mem-1', 'failed', undefined, Date.now() - 4 * 60 * 60 * 1000);

    const result = await handlers.handleRecall({ query: 'anything' });

    assert.match(result.content[0].text, /⚠ track record: recalled 9×, worked 1×, failed 3× \(last: failed 4h ago\)/);
    cleanup();
});

// ---------------------------------------------------------------------------
// recall: opt-in trust-weighted re-ranking (GEMDEX_TRUST_RANKING)
// ---------------------------------------------------------------------------

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
        return fn();
    } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
    }
}

test('trust ranking OFF (default): result order and fixed limit are unchanged from backend order', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    let requestedLimit: number | undefined;
    backend.recall = async (_q, limit) => {
        requestedLimit = limit;
        return [
            makeRecallHit({ id: 'clean', title: 'Clean', score: 0.5 }),
            makeRecallHit({ id: 'burned', title: 'Burned', score: 0.49 }),
        ];
    };
    // Give 'burned' a terrible track record — must NOT affect order while off.
    statsStore.recordOutcome('burned', 'failed');
    statsStore.recordOutcome('burned', 'failed');
    statsStore.recordOutcome('burned', 'failed');
    statsStore.recordOutcome('burned', 'stale');
    const handlers = new MemoryToolHandlers(backend, statsStore);

    await withEnv('GEMDEX_TRUST_RANKING', undefined, async () => {
        const result = await handlers.handleRecall({ query: 'q' });
        const text = result.content[0].text;
        assert.equal(requestedLimit, 10, 'no over-fetch when the flag is off; fixed N=10');
        const cleanIndex = text.indexOf('id: clean');
        const burnedIndex = text.indexOf('id: burned');
        assert.ok(cleanIndex > -1 && burnedIndex > -1 && cleanIndex < burnedIndex);
        assert.ok(!text.includes('trust=×'), 'no trust factor rendered while the flag is off');
    });
    cleanup();
});

test('trust ranking ON: a high-failed memory drops below a clean one with a slightly lower fused score', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    let requestedLimit: number | undefined;
    backend.recall = async (_q, limit) => {
        requestedLimit = limit;
        return [
            // 'burned' ranks first by raw score...
            makeRecallHit({ id: 'burned', title: 'Burned', score: 0.52 }),
            makeRecallHit({ id: 'clean', title: 'Clean', score: 0.50 }),
        ];
    };
    // 'burned': failed 5x, stale 2x -> penalty = 1 + 0.20*ln(8) ≈ 1.416 -> trust ≈ 0.706.
    for (let i = 0; i < 5; i++) statsStore.recordOutcome('burned', 'failed');
    for (let i = 0; i < 2; i++) statsStore.recordOutcome('burned', 'stale');
    // 'clean' has no stats at all -> trust = 1.
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await withEnv('GEMDEX_TRUST_RANKING', 'true', () =>
        handlers.handleRecall({ query: 'q' }));

    // Over-fetch: min(max(10*2, 10+5), 100) = 20.
    assert.equal(requestedLimit, 20);
    const text = result.content[0].text;
    const cleanIndex = text.indexOf('id: clean');
    const burnedIndex = text.indexOf('id: burned');
    assert.ok(cleanIndex > -1 && burnedIndex > -1 && cleanIndex < burnedIndex, 'clean must now rank above burned');
    // Title index does not render the trust factor line — only order changes.
    assert.ok(!text.includes('trust=×'));
    cleanup();
});

test('trust ranking ON with no stats anywhere leaves relative order unchanged', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recall = async () => [
        makeRecallHit({ id: 'a', title: 'A', score: 0.9 }),
        makeRecallHit({ id: 'b', title: 'B', score: 0.5 }),
    ];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await withEnv('GEMDEX_TRUST_RANKING', 'true', () =>
        handlers.handleRecall({ query: 'q' }));

    const text = result.content[0].text;
    assert.ok(text.indexOf('id: a') < text.indexOf('id: b'));
    cleanup();
});

test('trust ranking treats an unparseable flag value as off (fail-fast-off, not on)', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    let requestedLimit: number | undefined;
    backend.recall = async (_q, limit) => {
        requestedLimit = limit;
        return [makeRecallHit({ id: 'a', score: 0.5 })];
    };
    const handlers = new MemoryToolHandlers(backend, statsStore);

    await withEnv('GEMDEX_TRUST_RANKING', 'yes-please', async () => {
        await handlers.handleRecall({ query: 'q' });
        assert.equal(requestedLimit, 10, 'garbage value must not trigger over-fetch');
    });
    cleanup();
});
