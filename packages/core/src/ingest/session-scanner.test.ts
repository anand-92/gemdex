import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IngestLedgerStore } from './ingest-ledger';
import {
    ACTIVE_SESSION_WINDOW_MS,
    bucketSessionFiles,
    discoverSessionFiles,
} from './session-scanner';

let dir: string;
let ledger: IngestLedgerStore;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-scanner-'));
    ledger = new IngestLedgerStore({ rootDir: path.join(dir, '.gemdex') });
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(relative: string, content = 'x', mtimeMs?: number): string {
    const filePath = path.join(dir, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    if (mtimeMs !== undefined) {
        fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
    }
    return filePath;
}

describe('discoverSessionFiles', () => {
    it('finds jsonl files recursively and skips settings files', () => {
        writeFile('sessions/proj-a/one.jsonl');
        writeFile('sessions/proj-a/one.settings.json');
        writeFile('sessions/proj-b/nested/two.jsonl');
        writeFile('sessions/readme.md');
        const files = discoverSessionFiles([{ source: 'factory', path: path.join(dir, 'sessions') }]);
        expect(files.map((file) => path.basename(file.filePath)).sort()).toEqual(['one.jsonl', 'two.jsonl']);
        expect(files.every((file) => file.source === 'factory')).toBe(true);
    });

    it('finds Antigravity protobuf conversation files', () => {
        writeFile('conversations/a.pb');
        writeFile('conversations/b.db');
        writeFile('conversations/b.jsonl');
        writeFile('conversations/nested/c.pb');
        const files = discoverSessionFiles([{ source: 'antigravity', path: path.join(dir, 'conversations') }]);
        expect(files.map((file) => path.basename(file.filePath)).sort()).toEqual(['a.pb', 'b.db', 'c.pb']);
        expect(files.every((file) => file.source === 'antigravity')).toBe(true);
    });

    it('returns empty for a missing folder', () => {
        expect(discoverSessionFiles([{ source: 'claude', path: path.join(dir, 'nope') }])).toEqual([]);
    });

    it('dedupes overlapping folders', () => {
        writeFile('sessions/a.jsonl');
        const folder = { source: 'custom' as const, path: path.join(dir, 'sessions') };
        const files = discoverSessionFiles([folder, folder]);
        expect(files).toHaveLength(1);
    });
});

describe('bucketSessionFiles', () => {
    const now = Date.now();
    const old = now - ACTIVE_SESSION_WINDOW_MS - 60_000;

    it('buckets new, changed, up-to-date, and active files', () => {
        const newPath = writeFile('s/new.jsonl', 'new', old);
        const changedPath = writeFile('s/changed.jsonl', 'changed-bigger', old);
        const samePath = writeFile('s/same.jsonl', 'same', old);
        const activePath = writeFile('s/active.jsonl', 'active', now);

        const sameStat = fs.statSync(samePath);
        ledger.recordIngested(samePath, {
            mtimeMs: sameStat.mtimeMs,
            size: sameStat.size,
            memoryId: 'chat:factory:same',
            model: 'm',
            ingestedAt: now,
        });
        ledger.recordIngested(changedPath, {
            mtimeMs: old - 1000,
            size: 1,
            memoryId: 'chat:factory:changed',
            model: 'm',
            ingestedAt: now,
        });

        const files = discoverSessionFiles([{ source: 'factory', path: path.join(dir, 's') }]);
        const buckets = bucketSessionFiles(files, ledger, now);

        expect(buckets.newFiles.map((file) => file.filePath)).toEqual([newPath]);
        expect(buckets.changedFiles.map((file) => file.filePath)).toEqual([changedPath]);
        expect(buckets.upToDate.map((file) => file.filePath)).toEqual([samePath]);
        expect(buckets.skippedActive.map((file) => file.filePath)).toEqual([activePath]);
    });
});

describe('IngestLedgerStore', () => {
    it('round-trips entries and pending batch jobs', () => {
        ledger.recordIngested('/a.jsonl', {
            mtimeMs: 1,
            size: 2,
            memoryId: 'chat:claude:a',
            model: 'gemini-3.5-flash-lite',
            ingestedAt: 3,
        });
        expect(ledger.getEntry('/a.jsonl')?.memoryId).toBe('chat:claude:a');

        ledger.setPendingBatch({
            jobName: 'batches/123',
            model: 'gemini-3.5-flash-lite',
            submittedAt: 4,
            requests: {},
        });
        expect(ledger.getPendingBatch()?.jobName).toBe('batches/123');
        ledger.setPendingBatch(undefined);
        expect(ledger.getPendingBatch()).toBeUndefined();
        // Entries survive the pending-batch churn.
        expect(ledger.getEntry('/a.jsonl')).toBeDefined();
    });
});
