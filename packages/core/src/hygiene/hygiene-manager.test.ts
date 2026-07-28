import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryBackend } from '../memory/backend';
import type { MemoryStore, ParentVectorData } from '../memory/memory-store';
import { clusterIdFor } from './candidate-finder';
import { HygieneReportStore } from './hygiene-report';
import { HygieneManager } from './hygiene-manager';
import type { ClusterJudge, JudgeMemberInput } from './judge';
import { HygieneFinding } from './types';

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({})),
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY' },
}));

const DIM = 4;

function axis(index: number): number[] {
    const vec = new Array(DIM).fill(0);
    vec[index] = 1;
    return vec;
}

function parent(id: string, axisIndex: number, updatedAt: number): ParentVectorData {
    return {
        id,
        title: `title ${id}`,
        createdAt: updatedAt - 100,
        updatedAt,
        fullContent: `content of ${id}`,
        vectors: [axis(axisIndex)],
    };
}

/** Two duplicate parents (cluster) + one unrelated parent. */
const PARENTS: ParentVectorData[] = [
    parent('dup-new', 0, 2_000),
    parent('dup-old', 0, 1_000),
    parent('other', 1, 3_000),
];

function fakeStore(parents: ParentVectorData[] = PARENTS): MemoryStore {
    return {
        listParentsWithVectors: jest.fn(async () => parents),
    } as unknown as MemoryStore;
}

function fakeJudge(judge?: jest.Mock): ClusterJudge {
    return {
        model: 'gemini-3.5-flash-lite',
        judge: judge ?? jest.fn(async (members: JudgeMemberInput[]): Promise<HygieneFinding[]> =>
            members.map((m, index) => index === 0
                ? { memoryId: m.memoryId, verdict: 'keep', confidence: 'high' }
                : { memoryId: m.memoryId, verdict: 'duplicate', supersededBy: members[0].memoryId, confidence: 'high' })),
    } as unknown as ClusterJudge;
}

function fakeBackend(overrides: { failOn?: string } = {}): MemoryBackend & { deleted: string[] } {
    const deleted: string[] = [];
    return {
        deleted,
        delete: jest.fn(async (id: string) => {
            if (id === overrides.failOn) throw new Error(`cannot delete ${id}`);
            deleted.push(id);
        }),
    } as unknown as MemoryBackend & { deleted: string[] };
}

let dir: string;
let reportStore: HygieneReportStore;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-hygiene-manager-'));
    reportStore = new HygieneReportStore({ rootDir: path.join(dir, '.gemdex') });
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function manager(judge: ClusterJudge = fakeJudge()): HygieneManager {
    return new HygieneManager({
        apiKey: 'k',
        reportStore,
        createJudge: () => judge,
    });
}

describe('HygieneManager.scan', () => {
    it('produces clusters with cost estimates and no LLM calls', async () => {
        const judge = fakeJudge();
        const result = await manager(judge).scan(fakeStore());
        expect(result.memoryCount).toBe(3);
        expect(result.clusters).toHaveLength(1);
        expect(result.clusters[0].members.map((m) => m.memoryId)).toEqual(['dup-new', 'dup-old']);
        expect(result.threshold).toBe(0.9);
        expect(result.estimatedInputTokens).toBeGreaterThan(0);
        expect(result.estimatedOutputTokens).toBe(400);
        expect(result.estimates.length).toBeGreaterThan(0);
        expect((judge.judge as jest.Mock)).not.toHaveBeenCalled();
    });

    it('filters dismissed clusters and counts them', async () => {
        reportStore.addDismissed([clusterIdFor(['dup-new', 'dup-old'])]);
        const result = await manager().scan(fakeStore());
        expect(result.clusters).toHaveLength(0);
        expect(result.dismissedCount).toBe(1);
    });

    it('honors a custom threshold', async () => {
        const result = await manager().scan(fakeStore(), 0.99);
        expect(result.threshold).toBe(0.99);
    });
});

describe('HygieneManager.run', () => {
    it('judges clusters, writes the report, and reports progress', async () => {
        const mgr = manager();
        const progress = await mgr.run({}, fakeStore());
        expect(progress.state).toBe('done');
        expect(progress.judged).toBe(1);
        expect(progress.failed).toBe(0);
        expect(progress.total).toBe(1);

        const report = reportStore.getReport()!;
        expect(report.version).toBe(1);
        expect(report.model).toBe('gemini-3.5-flash-lite');
        expect(report.memoryCount).toBe(3);
        expect(report.clusters).toHaveLength(1);
        expect(report.clusters[0].findings).toEqual([
            { memoryId: 'dup-new', verdict: 'keep', confidence: 'high' },
            { memoryId: 'dup-old', verdict: 'duplicate', supersededBy: 'dup-new', confidence: 'high' },
        ]);
        expect(mgr.isRunning()).toBe(false);
    });

    it('records per-cluster failures and continues', async () => {
        const judge = fakeJudge(jest.fn(async () => { throw new Error('boom'); }));
        const progress = await manager(judge).run({}, fakeStore());
        expect(progress.state).toBe('done');
        expect(progress.judged).toBe(0);
        expect(progress.failed).toBe(1);
        const report = reportStore.getReport()!;
        expect(report.clusters[0].error).toBe('boom');
        expect(report.clusters[0].findings).toBeUndefined();
    }, 30_000);

    it('rejects a second run while one is in flight', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const judge = fakeJudge(jest.fn(async () => {
            await gate;
            return [];
        }));
        const mgr = manager(judge);
        const first = mgr.run({}, fakeStore());
        await expect(mgr.run({}, fakeStore())).rejects.toThrow(/already in progress/);
        release();
        await first;
    });

    it('cancel stops between clusters', async () => {
        // Many independent clusters: pairs on distinct axes... but DIM=4 caps us,
        // so use two clusters and cancel after the first judge call.
        const parents = [
            parent('a1', 0, 1_000), parent('a2', 0, 2_000),
            parent('b1', 1, 1_000), parent('b2', 1, 2_000),
        ];
        let mgr!: HygieneManager;
        const judge = fakeJudge(jest.fn(async (members: JudgeMemberInput[]): Promise<HygieneFinding[]> => {
            mgr.cancel();
            return members.map((m) => ({ memoryId: m.memoryId, verdict: 'keep', confidence: 'low' }));
        }));
        mgr = new HygieneManager({
            apiKey: 'k',
            reportStore,
            createJudge: () => judge,
        });
        const progress = await mgr.run({}, fakeStore(parents));
        expect(progress.state).toBe('cancelled');
        expect(progress.judged).toBeLessThan(progress.total);
    });

    it('preserves previously deleted ids across runs', async () => {
        const mgr = manager();
        await mgr.run({}, fakeStore());
        await mgr.apply(['dup-old'], fakeBackend());
        await mgr.run({}, fakeStore());
        expect(reportStore.getReport()!.deletedIds).toEqual(['dup-old']);
    });
});

describe('HygieneManager.apply', () => {
    it('deletes via the backend and records into the report', async () => {
        const mgr = manager();
        await mgr.run({}, fakeStore());
        const backend = fakeBackend();
        const result = await mgr.apply(['dup-old'], backend);
        expect(result.deleted).toBe(1);
        expect(backend.deleted).toEqual(['dup-old']);
        const report = reportStore.getReport()!;
        expect(report.deletedIds).toEqual(['dup-old']);
        // Cluster fell below 2 members → dropped.
        expect(report.clusters).toHaveLength(0);
    });

    it('records successful deletions then rethrows on a failed delete', async () => {
        const mgr = manager();
        await mgr.run({}, fakeStore());
        const backend = fakeBackend({ failOn: 'dup-new' });
        await expect(mgr.apply(['dup-old', 'dup-new'], backend)).rejects.toThrow(/cannot delete dup-new/);
        expect(backend.deleted).toEqual(['dup-old']);
        expect(reportStore.getReport()!.deletedIds).toEqual(['dup-old']);
    });
});

describe('HygieneManager.dismiss', () => {
    it('adds dismissals and prunes the stored report', async () => {
        const mgr = manager();
        await mgr.run({}, fakeStore());
        const clusterId = reportStore.getReport()!.clusters[0].clusterId;
        mgr.dismiss([clusterId]);
        expect(reportStore.getReport()!.clusters).toHaveLength(0);
        // A later scan filters the dismissed cluster.
        const rescan = await mgr.scan(fakeStore());
        expect(rescan.clusters).toHaveLength(0);
        expect(rescan.dismissedCount).toBe(1);
    });
});
