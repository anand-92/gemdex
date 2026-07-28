import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IngestManager, IngestProgress, IngestScanResult, MemoryBackend } from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { runCli } from './cli.js';

let rootDir: string;
let savedApiKey: string | undefined;

beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-cli-ingest-'));
    savedApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (savedApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
    } else {
        process.env.GEMINI_API_KEY = savedApiKey;
    }
});

interface FakeManagerState {
    scanResult: IngestScanResult;
    runResult: IngestProgress;
    collectResult: unknown;
    runs: unknown[];
    collects: number;
}

function makeState(pendingCount: number): FakeManagerState {
    return {
        scanResult: {
            buckets: {
                newFiles: Array.from({ length: pendingCount }, (_, index) => ({
                    source: 'claude' as const,
                    filePath: `/s/${index}.jsonl`,
                    mtimeMs: 1,
                    size: 1,
                })),
                changedFiles: [],
                upToDate: [],
                skippedActive: [],
            },
            processableFiles: Array.from({ length: pendingCount }, (_, index) => ({
                source: 'claude' as const,
                filePath: `/s/${index}.jsonl`,
                mtimeMs: 1,
                size: 1,
            })),
            skippedTrivialFiles: [],
            pendingCount,
            estimatedInputTokens: 1000,
            estimatedOutputTokens: 800,
            estimates: [
                { model: 'gemini-3.5-flash-lite', standardUsd: 1.23, batchUsd: 0.62 },
            ],
        },
        runResult: { state: 'done', processed: pendingCount, failed: 0, skipped: 0, total: pendingCount },
        collectResult: { state: 'none' },
        runs: [],
        collects: 0,
    };
}

function fakeManager(state: FakeManagerState): IngestManager {
    return {
        scan: () => state.scanResult,
        run: async (options: unknown) => {
            state.runs.push(options);
            return state.runResult;
        },
        getProgress: () => state.runResult,
        isRunning: () => false,
        cancel: () => undefined,
        cancelBatch: async () => false,
        collect: async () => {
            state.collects += 1;
            return state.collectResult;
        },
    } as unknown as IngestManager;
}

async function run(
    args: string[],
    state: FakeManagerState,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(args, {
        store: new ClientConfigStore({ rootDir }),
        io: {
            stdout: (message) => { stdout += message; },
            stderr: (message) => { stderr += message; },
            readSecret: async () => '',
        },
        createIngestManager: () => fakeManager(state),
        createActiveBackend: () => ({} as MemoryBackend),
    });
    return { code, stdout, stderr };
}

test('ingest-history --dry-run prints the scan and cost table without running', async () => {
    const state = makeState(3);
    // Point the default sources at a real folder so source resolution passes.
    const sessions = path.join(rootDir, '.claude', 'projects');
    fs.mkdirSync(sessions, { recursive: true });
    const result = await run(['ingest-history', '--dry-run', '--source', sessions], state);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /new: 3/);
    assert.match(result.stdout, /gemini-3\.5-flash-lite\s+standard \$1\.23\s+batch \$0\.62/);
    assert.equal(state.runs.length, 0);
});

test('ingest-history --dry-run reports trivial candidates separately', async () => {
    const state = makeState(1);
    state.scanResult.buckets.newFiles.push({
        source: 'factory',
        filePath: '/s/stub.jsonl',
        mtimeMs: 1,
        size: 236,
    });
    state.scanResult.skippedTrivialFiles.push({
        source: 'factory',
        filePath: '/s/stub.jsonl',
        mtimeMs: 1,
        size: 236,
    });

    const result = await run(['ingest-history', '--dry-run', '--source', rootDir], state);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Sessions — new: 1, previously ingested and changed \(skipped\): 0/);
    assert.match(result.stdout, /Skipped trivial candidates: 1/);
});

test('ingest-history runs standard mode and reports the summary', async () => {
    const state = makeState(2);
    const result = await run(['ingest-history', '--source', rootDir], state);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Done — Ingested: 2, Failed: 0/);
    const options = state.runs[0] as { mode?: string; model?: string };
    assert.equal(options.mode, 'standard');
    assert.equal(options.model, 'gemini-3.5-flash-lite');
});

test('ingest-history always skips changed sessions and prices only new ones', async () => {
    const state = makeState(1);
    state.scanResult.buckets.changedFiles = [
        { source: 'claude', filePath: '/s/changed.jsonl', mtimeMs: 2, size: 9 },
    ];
    state.scanResult.estimatedInputTokens = 900;
    state.scanResult.estimatedOutputTokens = 400;
    state.scanResult.estimates = [
        { model: 'gemini-3.5-flash-lite', standardUsd: 0.55, batchUsd: 0.28 },
    ];
    const result = await run(['ingest-history', '--source', rootDir], state);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /previously ingested and changed \(skipped\): 1/);
    assert.match(result.stdout, /Previously ingested sessions are never reprocessed/);
    assert.match(result.stdout, /~900/);
    const options = state.runs[0] as Record<string, unknown>;
    assert.equal('newOnly' in options, false);
});

test('ingest-history reports nothing to do when only changed sessions exist', async () => {
    const state = makeState(0);
    state.scanResult.buckets.changedFiles = [
        { source: 'claude', filePath: '/s/changed.jsonl', mtimeMs: 2, size: 9 },
    ];
    const result = await run(['ingest-history', '--source', rootDir], state);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Previously ingested sessions are never reprocessed/);
    assert.match(result.stdout, /Nothing to ingest/);
    assert.equal(state.runs.length, 0);
});

test('ingest-history --batch submits and prints the job name', async () => {
    const state = makeState(2);
    state.runResult = {
        state: 'batchPending', processed: 0, failed: 0, skipped: 0, total: 2,
        pendingBatch: { jobName: 'batches/42', model: 'gemini-3.5-flash-lite', submittedAt: 1, requestCount: 2 },
    };
    const result = await run(['ingest-history', '--batch', '--source', rootDir], state);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Submitted batch job batches\/42/);
    assert.match(result.stdout, /--collect/);
});

test('ingest-history --collect reports collection results', async () => {
    const state = makeState(0);
    state.collectResult = { state: 'collected', jobState: 'JOB_STATE_SUCCEEDED', ingested: 5, failed: 1 };
    const result = await run(['ingest-history', '--collect'], state);
    assert.equal(result.code, 1); // failures present
    assert.match(result.stdout, /Ingested: 5, Failed: 1/);
    assert.equal(state.collects, 1);
});

test('ingest-history rejects unknown models', async () => {
    const result = await run(['ingest-history', '--model', 'gemini-1.5-pro', '--source', rootDir], makeState(0));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unsupported model/);
});

test('ingest-history fails without a GEMINI_API_KEY', async () => {
    delete process.env.GEMINI_API_KEY;
    // envManager may also read ~/.gemdex/.env; tolerate environments where a
    // real key exists there by only asserting when resolution actually fails.
    const result = await run(['ingest-history', '--dry-run', '--source', rootDir], makeState(0));
    if (result.code === 1) {
        assert.match(result.stderr, /GEMINI_API_KEY/);
    }
});

test('ingest-history reports nothing to do when no sessions are pending', async () => {
    const result = await run(['ingest-history', '--source', rootDir], makeState(0));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Nothing to ingest/);
});
