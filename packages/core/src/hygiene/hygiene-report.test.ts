import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HygieneReportStore } from './hygiene-report';
import { HygieneCluster, HygieneReport } from './types';

let dir: string;
let store: HygieneReportStore;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-hygiene-report-'));
    store = new HygieneReportStore({ rootDir: path.join(dir, '.gemdex') });
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function member(id: string) {
    return { memoryId: id, title: id, createdAt: 1, updatedAt: 2, contentLength: 10 };
}

function cluster(clusterId: string, memberIds: string[]): HygieneCluster {
    return {
        clusterId,
        members: memberIds.map(member),
        similarity: 0.9,
        findings: memberIds.map((id) => ({
            memoryId: id,
            verdict: 'keep' as const,
            confidence: 'low' as const,
        })),
    };
}

function report(clusters: HygieneCluster[]): HygieneReport {
    return {
        version: 1,
        scannedAt: 100,
        judgedAt: 200,
        model: 'gemini-3.5-flash-lite',
        threshold: 0.8,
        memoryCount: 5,
        clusters,
        deletedIds: [],
    };
}

describe('HygieneReportStore', () => {
    it('returns empty defaults when no file exists', () => {
        expect(store.getReport()).toBeUndefined();
        expect(store.getDismissed().size).toBe(0);
    });

    it('round-trips a report', () => {
        const original = report([cluster('c1', ['a', 'b'])]);
        store.setReport(original);
        expect(store.getReport()).toEqual(original);
        // Reload via a fresh store instance to prove it hit disk.
        const fresh = new HygieneReportStore({ rootDir: path.join(dir, '.gemdex') });
        expect(fresh.getReport()).toEqual(original);
    });

    it('persists dismissals and prunes dismissed clusters from the stored report', () => {
        store.setReport(report([cluster('c1', ['a', 'b']), cluster('c2', ['c', 'd'])]));
        store.addDismissed(['c1']);
        expect(store.getDismissed()).toEqual(new Set(['c1']));
        expect(store.getReport()!.clusters.map((c) => c.clusterId)).toEqual(['c2']);
        // Dismissing again is idempotent.
        store.addDismissed(['c1', 'c3']);
        expect(store.getDismissed()).toEqual(new Set(['c1', 'c3']));
    });

    it('recordDeleted appends ids, strips members/findings, and drops <2-member clusters', () => {
        store.setReport(report([cluster('c1', ['a', 'b']), cluster('c2', ['c', 'd', 'e'])]));
        store.recordDeleted(['b', 'e']);
        const saved = store.getReport()!;
        expect(saved.deletedIds).toEqual(['b', 'e']);
        // c1 lost 'b' → 1 member left → dropped.
        expect(saved.clusters.map((c) => c.clusterId)).toEqual(['c2']);
        expect(saved.clusters[0].members.map((m) => m.memoryId)).toEqual(['c', 'd']);
        expect(saved.clusters[0].findings!.map((f) => f.memoryId)).toEqual(['c', 'd']);
        // Appending is cumulative and dedupes.
        store.recordDeleted(['b', 'c']);
        const after = store.getReport()!;
        expect(after.deletedIds).toEqual(['b', 'e', 'c']);
        expect(after.clusters).toHaveLength(0);
    });

    it('recordDeleted is a no-op without a stored report', () => {
        store.recordDeleted(['x']);
        expect(store.getReport()).toBeUndefined();
    });

    it('throws on an unreadable file', () => {
        fs.mkdirSync(path.dirname(store.reportPath), { recursive: true });
        fs.writeFileSync(store.reportPath, 'garbage', 'utf8');
        expect(() => store.load()).toThrow(/Unable to read/);
    });
});
