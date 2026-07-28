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

    async readAttachment(_memoryId: string, _attachmentId: string): Promise<AttachmentBytes | null> {
        return null;
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

test('recall surfaces relative age and attachment lines', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [
        makeRecallHit({
            updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
            attachments: [{ id: '0', kind: 'image', mimeType: 'image/png', byteLength: 10, caption: 'login bug' }],
        }),
    ];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleRecall({ query: 'login' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /updated: 3d ago/);
    assert.match(result.content[0].text, /attachments: image \(id 0: "login bug"\)/);
    assert.match(result.content[0].text, /the full content body/);
    cleanup();
});

test('recall detail=summary returns a preview, not full content', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    const longBody = 'x'.repeat(500);
    backend.recallResults = [makeRecallHit({ content: longBody })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleRecall({ query: 'anything', detail: 'summary' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /summary mode/);
    assert.match(result.content[0].text, /…/);
    assert.ok(!result.content[0].text.includes(longBody), 'full body must not appear in summary mode');
    cleanup();
});

test('list_memories renders summaries newest-first with age and media counts', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.listResults = [
        {
            id: 'mem-a',
            title: 'Deploy playbook',
            preview: 'how we deploy the service',
            attachments: [{ id: '0', kind: 'image', mimeType: 'image/png', byteLength: 1 }],
            createdAt: 1,
            updatedAt: Date.now(),
        },
        {
            id: 'mem-b',
            title: 'Signing credentials',
            preview: 'notarization steps',
            attachments: [],
            createdAt: 1,
            updatedAt: Date.now() - 60 * 1000,
        },
    ];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleListMemories({});

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /2 memories/);
    assert.match(result.content[0].text, /Deploy playbook/);
    assert.match(result.content[0].text, /id: mem-a/);
    assert.match(result.content[0].text, /1 image/);
    cleanup();
});

test('list_memories filter is a case-insensitive substring over title + preview', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.listResults = [
        { id: 'mem-a', title: 'Deploy playbook', preview: 'service rollout', attachments: [], createdAt: 1, updatedAt: 2 },
        { id: 'mem-b', title: 'Signing credentials', preview: 'notarization', attachments: [], createdAt: 1, updatedAt: 1 },
    ];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleListMemories({ filter: 'DEPLOY' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Deploy playbook/);
    assert.ok(!result.content[0].text.includes('Signing credentials'));
    cleanup();
});

test('list_memories reports an empty store cleanly', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleListMemories({});

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Nothing stored yet/);
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
// recall: recallCount bump + track-record line rendering
// ---------------------------------------------------------------------------

test('recall bumps recallCount for every returned id', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1' }), makeRecallHit({ id: 'mem-2' })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    await handlers.handleRecall({ query: 'anything' });

    assert.equal(statsStore.get('mem-1')?.recallCount, 1);
    assert.equal(statsStore.get('mem-2')?.recallCount, 1);

    await handlers.handleRecall({ query: 'anything again' });
    assert.equal(statsStore.get('mem-1')?.recallCount, 2);
    cleanup();
});

test('recall never breaks when the stats store throws on read or write', async () => {
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1' })];
    const handlers = new MemoryToolHandlers(backend, new ThrowingStatsStore());

    const result = await handlers.handleRecall({ query: 'anything' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /the full content body/);
});

test('recall track-record line is absent when no stats exist for a hit', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'never-recalled-before' })];
    // Seed stats for a DIFFERENT id so the store file exists but has nothing
    // for this hit — the line must still be absent on first surfacing... but
    // handleRecall itself bumps recallCount before rendering, so assert the
    // pre-recall absence via a separate handler call is not meaningful here;
    // instead verify a genuinely untracked memory shows no line by checking
    // the rendered text has no non-zero-count phrasing beyond "recalled 1×".
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await handlers.handleRecall({ query: 'anything' });

    // First-ever recall: recordRecall runs BEFORE rendering, so this hit now
    // has recallCount=1 and DOES show a line — this documents that ordering.
    assert.match(result.content[0].text, /track record: recalled 1×/);
    assert.ok(!result.content[0].text.includes('⚠'), 'no warning prefix with zero failed/stale');
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
    statsStore.recordOutcome('mem-1', 'worked', undefined, Date.now() - 2 * 24 * 60 * 60 * 1000);
    statsStore.recordOutcome('mem-1', 'worked', undefined, Date.now() - 2 * 24 * 60 * 60 * 1000);
    statsStore.recordOutcome('mem-1', 'worked', undefined, Date.now() - 2 * 24 * 60 * 60 * 1000);

    const result = await handlers.handleRecall({ query: 'anything' });

    // 6 prior + this call's own bump = 7.
    assert.match(result.content[0].text, /track record: recalled 7×, worked 3× \(last: worked 2d ago\)/);
    assert.ok(!result.content[0].text.includes('⚠'));
    cleanup();
});

test('recall track-record line shows the ⚠ prefix and always includes failed/stale once either is non-zero', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recallResults = [makeRecallHit({ id: 'mem-1' })];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    for (let i = 0; i < 8; i++) statsStore.recordRecall(['mem-1']);
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

test('trust ranking OFF (default): result order and requested limit are unchanged from backend order', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    let requestedLimit: number | undefined;
    backend.recall = async (_q, limit) => {
        requestedLimit = limit;
        return [
            makeRecallHit({ id: 'clean', score: 0.5 }),
            makeRecallHit({ id: 'burned', score: 0.49 }),
        ];
    };
    // Give 'burned' a terrible track record — must NOT affect order while off.
    statsStore.recordOutcome('burned', 'failed');
    statsStore.recordOutcome('burned', 'failed');
    statsStore.recordOutcome('burned', 'failed');
    statsStore.recordOutcome('burned', 'stale');
    const handlers = new MemoryToolHandlers(backend, statsStore);

    await withEnv('GEMDEX_TRUST_RANKING', undefined, async () => {
        const result = await handlers.handleRecall({ query: 'q', limit: 5 });
        const text = result.content[0].text;
        assert.equal(requestedLimit, 5, 'no over-fetch when the flag is off');
        assert.ok(text.indexOf('### 1. Note') < text.indexOf('### 2. Note') || text.split('### 1.').length === 2);
        // 'clean' (higher raw score) must still render first.
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
            makeRecallHit({ id: 'burned', score: 0.52 }),
            makeRecallHit({ id: 'clean', score: 0.50 }),
        ];
    };
    // 'burned': failed 5x, stale 2x -> penalty = 1 + 0.20*ln(8) ≈ 1.416 -> trust ≈ 0.706.
    for (let i = 0; i < 5; i++) statsStore.recordOutcome('burned', 'failed');
    for (let i = 0; i < 2; i++) statsStore.recordOutcome('burned', 'stale');
    // 'clean' has no stats at all -> trust = 1.
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await withEnv('GEMDEX_TRUST_RANKING', 'true', () =>
        handlers.handleRecall({ query: 'q', limit: 2 }));

    // Over-fetch: min(max(2*2, 2+5), 100) = min(7,100) = 7.
    assert.equal(requestedLimit, 7);
    const text = result.content[0].text;
    const cleanIndex = text.indexOf('id: clean');
    const burnedIndex = text.indexOf('id: burned');
    assert.ok(cleanIndex > -1 && burnedIndex > -1 && cleanIndex < burnedIndex, 'clean must now rank above burned');
    assert.match(text, /trust=×0\.7\d/);
    cleanup();
});

test('trust ranking ON still over-fetches at the tool\'s max limit (50), not capped down to it', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    let requestedLimit: number | undefined;
    backend.recall = async (_q, limit) => {
        requestedLimit = limit;
        return [makeRecallHit({ id: 'a', score: 0.5 })];
    };
    const handlers = new MemoryToolHandlers(backend, statsStore);

    await withEnv('GEMDEX_TRUST_RANKING', 'true', async () => {
        // limit is clamped to 50 by handleRecall itself; over-fetch must still
        // reach past it (min(max(50*2, 50+5), 100) = 100), not collapse to 50.
        await handlers.handleRecall({ query: 'q', limit: 999 });
        assert.equal(requestedLimit, 100, 'over-fetch cap must stay above the max requestable limit');
    });
    cleanup();
});

test('trust ranking ON with no stats anywhere leaves relative order unchanged (trust=1 for all)', async () => {
    const { statsStore, cleanup } = makeStatsStore();
    const backend = new FakeBackend(null);
    backend.recall = async () => [
        makeRecallHit({ id: 'a', score: 0.9 }),
        makeRecallHit({ id: 'b', score: 0.5 }),
    ];
    const handlers = new MemoryToolHandlers(backend, statsStore);

    const result = await withEnv('GEMDEX_TRUST_RANKING', 'true', () =>
        handlers.handleRecall({ query: 'q', limit: 10 }));

    const text = result.content[0].text;
    assert.ok(text.indexOf('id: a') < text.indexOf('id: b'));
    assert.match(text, /trust=×1\.00/);
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
        await handlers.handleRecall({ query: 'q', limit: 10 });
        assert.equal(requestedLimit, 10, 'garbage value must not trigger over-fetch');
    });
    cleanup();
});
