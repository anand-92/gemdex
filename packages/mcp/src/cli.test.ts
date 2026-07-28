import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    ImportRecordsResult,
    Memory,
    MemoryAttachmentInput,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    SaveMemoryInput,
    UpdateMemoryInput,
} from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { runCli } from './cli.js';
import { createConfig } from './config.js';

class FakeBackend implements MemoryBackend {
    records = new Map<string, MemoryExportRecord>();
    failIds = new Set<string>();

    async save(_input: SaveMemoryInput): Promise<Memory> {
        throw new Error('not implemented');
    }

    async recall(
        _query?: string,
        _limit?: number,
        _queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        return [];
    }

    async update(_id: string, _input: UpdateMemoryInput): Promise<Memory> {
        throw new Error('not implemented');
    }

    async updateAttachmentCaptions(_id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        throw new Error('not implemented');
    }

    async get(id: string): Promise<Memory | null> {
        const item = this.records.get(id);
        return item ? { ...item, attachments: [] } : null;
    }

    async list(): Promise<MemorySummary[]> {
        return [];
    }

    async delete(_id: string): Promise<void> {}

    async exportAll(): Promise<MemoryExportRecord[]> {
        return [...this.records.values()];
    }

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        const item = records[0];
        if (this.failIds.has(item.id)) throw new Error('rejected');
        this.records.set(item.id, item);
        return { imported: 1, failed: 0, errors: [] };
    }

    async readAttachment(_memoryId: string, _attachmentId: string): Promise<AttachmentBytes | null> {
        return null;
    }
}

function record(id: string): MemoryExportRecord {
    return {
        id,
        title: id,
        content: `content ${id}`,
        createdAt: 1,
        updatedAt: 2,
    };
}

async function withCli(
    callback: (
        run: (
            args: string[],
            overrides?: { local?: MemoryBackend; remote?: MemoryBackend; fetch?: typeof fetch },
        ) => Promise<{ code: number | null; stdout: string; stderr: string }>,
        store: ClientConfigStore,
    ) => Promise<void>,
): Promise<void> {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-cli-'));
    const store = new ClientConfigStore({ rootDir });
    try {
        await callback(async (args, overrides = {}) => {
            let stdout = '';
            let stderr = '';
            const code = await runCli(args, {
                store,
                io: {
                    stdout: (message) => { stdout += message; },
                    stderr: (message) => { stderr += message; },
                    readSecret: async () => 'secret-token',
                },
                fetch: overrides.fetch ??
                    (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch,
                createLocalBackend: () => overrides.local ?? new FakeBackend(),
                createRemoteBackend: () => overrides.remote ?? new FakeBackend(),
            });
            return { code, stdout, stderr };
        }, store);
    } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
    }
}

test('remote add/list/mode/remove stores named configuration and keeps token out of JSON', async () => {
    await withCli(async (run, store) => {
        const added = await run(['remote', 'add', 'prod', 'https://memory.example.com/']);
        assert.equal(added.code, 0);
        assert.match(added.stdout, /Added remote "prod"/);
        assert.doesNotMatch(`${added.stdout}${added.stderr}`, /secret-token/);

        const configText = await fs.readFile(store.configPath, 'utf8');
        const envText = await fs.readFile(store.envPath, 'utf8');
        assert.doesNotMatch(configText, /secret-token/);
        assert.match(envText, /GEMDEX_REMOTE_TOKEN_PROD=secret-token/);

        assert.match((await run(['remote', 'list'])).stdout, /prod\thttps:\/\/memory\.example\.com/);
        assert.equal((await run(['mode', 'remote', 'prod'])).code, 0);
        assert.equal(store.getEnv('GEMDEX_MODE'), 'remote');
        assert.equal(store.getEnv('GEMDEX_REMOTE_NAME'), 'prod');
        assert.deepEqual(createConfig((name) => store.getEnv(name)).remote, {
            url: 'https://memory.example.com',
            token: 'secret-token',
        });
        assert.match((await run(['remote', 'list'])).stdout, /^\* prod/m);

        assert.equal((await run(['remote', 'remove', 'prod'])).code, 0);
        assert.equal(store.getEnv('GEMDEX_MODE'), 'local');
        assert.equal(store.getEnv('GEMDEX_REMOTE_TOKEN_PROD'), undefined);
        assert.deepEqual(store.list(), []);
    });
});

test('status reports remote health and authenticated API reachability', async () => {
    await withCli(async (run, store) => {
        store.add('prod', 'https://memory.example.com', 'TOKEN');
        store.setEnv('TOKEN', 'token');
        store.activateRemote('prod');

        const result = await run(['status']);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /Mode: remote \(prod\)/);
        assert.match(result.stdout, /Reachable: yes/);
        assert.match(result.stdout, /Authenticated: yes/);
    });
});

function versionResponse(overrides: Record<string, unknown> = {}): Response {
    return new Response(
        JSON.stringify({
            name: 'gemdex-server',
            apiVersion: 'v1',
            serverVersion: '0.1.0',
            minClientVersion: '0.3.0',
            protocolVersion: 1,
            capabilities: {},
            ...overrides,
        }),
        { status: 200 },
    );
}

test('init-remote stores the remote, verifies, activates, and prints the agent command', async () => {
    await withCli(async (run, store) => {
        const remote = new FakeBackend();
        const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
            assert.match(String(input), /\/v1\/version$/);
            return versionResponse();
        }) as typeof fetch;

        const result = await run(
            ['init-remote', 'macmini', 'https://mac-mini.example.ts.net/'],
            { remote, fetch: fetchImpl },
        );

        assert.equal(result.code, 0);
        assert.match(result.stdout, /Added remote "macmini"/);
        assert.match(result.stdout, /Server reachable and version-compatible\./);
        assert.match(result.stdout, /Authenticated successfully\./);
        assert.match(result.stdout, /Gemdex mode is now remote: macmini\./);
        assert.match(result.stdout, /claude mcp add gemdex/);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-token/);

        // Token stored out of config.json; mode flipped to remote.
        assert.equal(store.getEnv('GEMDEX_MODE'), 'remote');
        assert.equal(store.getEnv('GEMDEX_REMOTE_NAME'), 'macmini');
        const configText = await fs.readFile(store.configPath, 'utf8');
        assert.doesNotMatch(configText, /secret-token/);
    });
});

test('init-remote with --import-local copies local memories and can skip activation', async () => {
    await withCli(async (run, store) => {
        const local = new FakeBackend();
        local.records.set('one', record('one'));
        local.records.set('two', record('two'));
        const remote = new FakeBackend();
        const fetchImpl = (async () => versionResponse()) as typeof fetch;

        const result = await run(
            ['init-remote', 'macmini', 'https://mac-mini.example.ts.net', '--import-local', '--no-activate'],
            { local, remote, fetch: fetchImpl },
        );

        assert.equal(result.code, 0);
        assert.match(result.stdout, /Imported local memories — Created: 2, Updated: 0, Skipped: 0\./);
        assert.equal(remote.records.get('one')?.id, 'one');
        assert.equal(remote.records.get('two')?.id, 'two');
        // --no-activate leaves the machine in local mode.
        assert.notEqual(store.getEnv('GEMDEX_MODE'), 'remote');
    });
});

test('init-remote fails fast on an incompatible server protocol version', async () => {
    await withCli(async (run, store) => {
        const fetchImpl = (async () => versionResponse({ protocolVersion: 2 })) as typeof fetch;

        const result = await run(
            ['init-remote', 'macmini', 'https://mac-mini.example.ts.net'],
            { fetch: fetchImpl },
        );

        assert.equal(result.code, 1);
        assert.match(result.stderr, /protocolVersion/);
        // Never switched into remote mode on failure.
        assert.notEqual(store.getEnv('GEMDEX_MODE'), 'remote');
    });
});

test('migration preserves ids and reports created, updated, and skipped records', async () => {
    await withCli(async (run, store) => {
        store.add('prod', 'https://memory.example.com', 'TOKEN');
        store.setEnv('TOKEN', 'token');
        const local = new FakeBackend();
        local.records.set('new-id', record('new-id'));
        local.records.set('existing-id', record('existing-id'));
        local.records.set('bad-id', record('bad-id'));
        const remote = new FakeBackend();
        remote.records.set('existing-id', record('existing-id'));
        remote.failIds.add('bad-id');

        const result = await run(['import-local-to-remote', 'prod'], { local, remote });
        assert.equal(result.code, 1);
        assert.match(result.stdout, /Created: 1/);
        assert.match(result.stdout, /Updated: 1/);
        assert.match(result.stdout, /Skipped: 1/);
        assert.match(result.stderr, /Skipped bad-id: rejected/);
        assert.equal(remote.records.get('new-id')?.id, 'new-id');
    });
});
