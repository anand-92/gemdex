import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { MemoryExportRecord } from 'gemdex-core';
import { RemoteSyncError, RemoteSyncTarget, SYNC_BATCH_SIZE } from './sync-target.js';

function record(id: string): MemoryExportRecord {
    return {
        id,
        title: 'Deployed the edge',
        content: 'Ran deploy.sh.',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        attachments: [
            {
                id: 'transcript',
                mimeType: 'text/plain',
                data: Buffer.from('User: hi\n\nAssistant: hello').toString('base64'),
                caption: 'Full transcript (source file)',
            },
        ],
    };
}

interface Captured {
    path: string;
    authorization?: string;
    body: { records: MemoryExportRecord[] };
}

/** A real HTTP server standing in for the host's mcp-http sync route. */
async function withMockHost(
    handler: (captured: Captured, res: http.ServerResponse) => void,
    run: (baseUrl: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
    const captured: Captured[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const entry: Captured = {
                path: req.url ?? '',
                ...(req.headers.authorization !== undefined && { authorization: req.headers.authorization }),
                body: JSON.parse(raw || '{"records":[]}'),
            };
            captured.push(entry);
            handler(entry, res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
        await run(`http://127.0.0.1:${address.port}/mcp`, captured);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

function ok(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

describe('RemoteSyncTarget', () => {
    test('posts records to /mcp/sync/records with a bearer token', async () => {
        await withMockHost(
            (entry, res) => ok(res, { imported: entry.body.records.length, failed: 0, errors: [] }),
            async (baseUrl, captured) => {
                const target = new RemoteSyncTarget({
                    mcpUrl: baseUrl,
                    getAccessToken: async () => 'access-token-1',
                });
                const result = await target.importRecords([record('chat:factory:s1')]);
                assert.deepEqual(result, { imported: 1, failed: 0, errors: [] });
                assert.equal(captured[0].path, '/mcp/sync/records');
                assert.equal(captured[0].authorization, 'Bearer access-token-1');
                assert.equal(captured[0].body.records[0].id, 'chat:factory:s1');
                // The cleaned transcript must ride along, or read_attachment on
                // the host has nothing to return.
                assert.equal(captured[0].body.records[0].attachments?.[0].id, 'transcript');
            },
        );
    });

    test('refreshes the token once on 401 and retries', async () => {
        let calls = 0;
        await withMockHost(
            (entry, res) => {
                if (entry.authorization === 'Bearer stale') {
                    ok(res, { error: 'Invalid or unauthorized token.' }, 401);
                    return;
                }
                ok(res, { imported: entry.body.records.length, failed: 0, errors: [] });
            },
            async (baseUrl, captured) => {
                const target = new RemoteSyncTarget({
                    mcpUrl: baseUrl,
                    getAccessToken: async ({ forceRefresh }) => {
                        calls += 1;
                        return forceRefresh ? 'fresh' : 'stale';
                    },
                });
                const result = await target.importRecords([record('chat:claude:s1')]);
                assert.equal(result.imported, 1);
                assert.equal(calls, 2, 'expected exactly one refresh');
                assert.equal(captured.length, 2);
                assert.equal(captured[1].authorization, 'Bearer fresh');
            },
        );
    });

    test('does not loop when the refreshed token is also rejected', async () => {
        let calls = 0;
        await withMockHost(
            (_entry, res) => ok(res, { error: 'Invalid or unauthorized token.' }, 401),
            async (baseUrl, captured) => {
                const target = new RemoteSyncTarget({
                    mcpUrl: baseUrl,
                    getAccessToken: async () => { calls += 1; return 'nope'; },
                });
                const result = await target.importRecords([record('chat:codex:s1')]);
                // A genuine authorization failure must surface as a failed
                // record, not an infinite refresh loop.
                assert.equal(result.imported, 0);
                assert.equal(result.failed, 1);
                assert.match(result.errors[0].error, /Invalid or unauthorized token/);
                assert.equal(calls, 2);
                assert.equal(captured.length, 2);
            },
        );
    });

    test('batches large runs and offsets per-record error indexes', async () => {
        const total = SYNC_BATCH_SIZE + 3;
        await withMockHost(
            (entry, res) => {
                // Fail the second (short) batch wholesale.
                if (entry.body.records.length < SYNC_BATCH_SIZE) {
                    ok(res, { error: 'boom' }, 502);
                    return;
                }
                ok(res, { imported: entry.body.records.length, failed: 0, errors: [] });
            },
            async (baseUrl, captured) => {
                const target = new RemoteSyncTarget({
                    mcpUrl: baseUrl,
                    getAccessToken: async () => 'token',
                });
                const records = Array.from({ length: total }, (_, i) => record(`chat:factory:s${i}`));
                const result = await target.importRecords(records);
                assert.equal(captured.length, 2);
                assert.equal(captured[0].body.records.length, SYNC_BATCH_SIZE);
                assert.equal(result.imported, SYNC_BATCH_SIZE);
                assert.equal(result.failed, 3);
                // Indexes must be absolute across batches so the caller can map
                // an error back to the record it sent.
                assert.deepEqual(result.errors.map((e) => e.index), [
                    SYNC_BATCH_SIZE, SYNC_BATCH_SIZE + 1, SYNC_BATCH_SIZE + 2,
                ]);
                assert.equal(result.errors[0].id, `chat:factory:s${SYNC_BATCH_SIZE}`);
            },
        );
    });

    test('a partial failure is reported, never silently counted as imported', async () => {
        await withMockHost(
            (_entry, res) => ok(res, {
                imported: 1,
                failed: 1,
                errors: [{ index: 1, id: 'chat:factory:s2', error: 'embedding failed' }],
            }),
            async (baseUrl) => {
                const target = new RemoteSyncTarget({
                    mcpUrl: baseUrl,
                    getAccessToken: async () => 'token',
                });
                const result = await target.importRecords([
                    record('chat:factory:s1'), record('chat:factory:s2'),
                ]);
                assert.equal(result.imported, 1);
                assert.equal(result.failed, 1);
                assert.equal(result.errors[0].error, 'embedding failed');
            },
        );
    });

    test('surfaces a host error message rather than a bare status', async () => {
        await withMockHost(
            (_entry, res) => ok(res, { error: "id 'mem-x' must start with 'chat:'" }, 400),
            async (baseUrl) => {
                const target = new RemoteSyncTarget({
                    mcpUrl: baseUrl,
                    getAccessToken: async () => 'token',
                });
                const result = await target.importRecords([record('chat:factory:s1')]);
                assert.equal(result.failed, 1);
                assert.match(result.errors[0].error, /must start with 'chat:'/);
            },
        );
    });

    test('rejects a non-http(s) MCP URL at construction', () => {
        assert.throws(
            () => new RemoteSyncTarget({ mcpUrl: 'ftp://host/mcp', getAccessToken: async () => 't' }),
            RemoteSyncError,
        );
    });

    test('never asks for a token when there are no records', async () => {
        let asked = 0;
        const target = new RemoteSyncTarget({
            mcpUrl: 'https://host.example.com/mcp',
            getAccessToken: async () => { asked += 1; return 't'; },
        });
        const result = await target.importRecords([]);
        assert.deepEqual(result, { imported: 0, failed: 0, errors: [] });
        assert.equal(asked, 0);
    });
});
