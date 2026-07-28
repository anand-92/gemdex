import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as httpServer } from "node:http";
import { LanceDBVectorDatabase, LocalMemoryBackend, Embedding, EmbeddingVector, FileBlobStore } from "gemdex-core";
import type {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    EmbeddingContent,
    ImportRecordsResult,
    Memory,
    MemoryAttachmentInput,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    SaveMemoryInput,
    UpdateMemoryInput,
} from "gemdex-core";
import { createMemoryApiHandler } from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createServer } from "./serve.js";

const DIM = 16;

function validGeminiReadiness(apiKey: string) {
    return {
        status: 'valid' as const,
        validatedAt: Date.now(),
        keyFingerprint: crypto.createHash('sha256').update(apiKey).digest('hex'),
    };
}


function vectorize(text: string): number[] {
    const vec: number[] = [];
    for (let i = 0; i < DIM; i++) vec.push(0);
    let total = 0;
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        vec[hash % DIM] += 1;
        total += 1;
    }
    if (total === 0) vec[0] = 1;
    return vec;
}

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return "Fake"; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: vectorize(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: vectorize(t), dimension: DIM }));
    }
}

class FakeMultimodalEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return "FakeMultimodal"; }
    isMultimodal(): boolean { return true; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: vectorize(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: vectorize(t), dimension: DIM }));
    }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return contents.map((c) => {
            const seed = typeof c === "string" ? c : `${c.inlineData.mimeType}:${c.inlineData.data}`;
            return { vector: vectorize(seed), dimension: DIM };
        });
    }
}

class SettingsBackend implements MemoryBackend {
    readonly records = new Map<string, MemoryExportRecord>();

    constructor(records: MemoryExportRecord[] = []) {
        for (const record of records) this.records.set(record.id, record);
    }

    async save(input: SaveMemoryInput): Promise<Memory> {
        const now = Date.now();
        const record: MemoryExportRecord = {
            id: `created-${this.records.size + 1}`,
            title: input.title ?? 'Untitled',
            content: input.content ?? '',
            createdAt: now,
            updatedAt: now,
        };
        this.records.set(record.id, record);
        return { ...record, attachments: [] };
    }

    async recall(
        _query?: string,
        _limit?: number,
        _queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        return [];
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const current = this.records.get(id);
        if (!current) throw new Error('Memory not found');
        const updated = {
            ...current,
            ...(input.title !== undefined && { title: input.title }),
            ...(input.content !== undefined && { content: input.content }),
            updatedAt: Date.now(),
        };
        this.records.set(id, updated);
        return { ...updated, attachments: [] };
    }

    async updateAttachmentCaptions(_id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        throw new Error('not implemented');
    }

    async get(id: string): Promise<Memory | null> {
        const record = this.records.get(id);
        return record ? { ...record, attachments: [] } : null;
    }

    async list(): Promise<MemorySummary[]> {
        return [...this.records.values()].map((record) => ({
            id: record.id,
            title: record.title,
            preview: record.content,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            attachments: [],
        }));
    }

    async delete(id: string): Promise<void> {
        this.records.delete(id);
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        return [...this.records.values()];
    }

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        for (const record of records) this.records.set(record.id, record);
        return { imported: records.length, failed: 0, errors: [] };
    }

    async readAttachment(_memoryId: string, _attachmentId: string): Promise<AttachmentBytes | null> {
        return null;
    }
}

function exportRecord(id: string, content = id): MemoryExportRecord {
    return {
        id,
        title: id,
        content,
        createdAt: 1,
        updatedAt: 2,
    };
}

let tmpDir: string;
let server: ReturnType<typeof createServer>;
let base: string;

async function json(res: Response): Promise<any> {
    return res.json();
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-test-"));
    const db = new LanceDBVectorDatabase({ uri: tmpDir });
    const store = new LocalMemoryBackend({ embedding: new FakeEmbedding(), vectorDatabase: db });
    // No token/allowedOrigin — backward-compat mode (existing tests unchanged).
    server = createServer({ config: {} as any, store });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /health returns ok", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
});

test("GET /config reports configured when a store is present", async () => {
    const res = await fetch(`${base}/config`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.configured, true);
    assert.equal(body.needsKey, false);
    assert.equal(body.gemini.status, 'missing');
});

test("local data routes stay locked until the saved Gemini key validates", async () => {
    const ctx = {
        config: {
            name: 'test',
            version: '1',
            embeddingModel: 'fake',
            geminiApiKey: 'saved-key',
            mode: 'local' as const,
        },
        store: new SettingsBackend(),
        geminiReadiness: { status: 'checking' as const },
        validateGeminiKey: async () => undefined,
    };
    const srv = createServer(ctx);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const before = await fetch(`${srvBase}/config`);
        const beforeBody = await json(before);
        assert.equal(beforeBody.configured, false);
        assert.equal(beforeBody.needsKey, true);
        assert.equal(beforeBody.gemini.status, 'checking');

        const blocked = await fetch(`${srvBase}/memories`);
        assert.equal(blocked.status, 503);
        assert.equal((await json(blocked)).needsKey, true);

        const validated = await fetch(`${srvBase}/config/validate`, { method: 'POST' });
        assert.equal(validated.status, 200);
        assert.equal((await json(validated)).gemini.status, 'valid');

        const unlocked = await fetch(`${srvBase}/memories`);
        assert.equal(unlocked.status, 200);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

test("createServer never marks an unvalidated key as valid", async () => {
    let resolveValidation: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { resolveValidation = resolve; });
    const ctx = {
        config: {
            name: 'test',
            version: '1',
            embeddingModel: 'fake',
            geminiApiKey: 'saved-key',
            mode: 'local' as const,
        },
        store: new SettingsBackend(),
        validateGeminiKey: async () => { await gate; },
    };
    const srv = createServer(ctx);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const before = await json(await fetch(`${srvBase}/config`));
        assert.equal(before.gemini.status, 'checking');
        assert.equal(before.needsKey, true);
        assert.equal(before.configured, false);

        const blocked = await fetch(`${srvBase}/memories`);
        assert.equal(blocked.status, 503);
        assert.equal((await json(blocked)).needsKey, true);

        resolveValidation?.();
        const validated = await fetch(`${srvBase}/config/validate`, { method: 'POST' });
        assert.equal(validated.status, 200);
        assert.equal((await json(validated)).gemini.status, 'valid');
    } finally {
        resolveValidation?.();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

test("POST /config/validate reuses an in-flight check for the same key", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fingerprint = crypto.createHash('sha256').update('saved-key').digest('hex');
    const ctx = {
        config: {
            name: 'test',
            version: '1',
            embeddingModel: 'fake',
            geminiApiKey: 'saved-key',
            mode: 'local' as const,
        },
        store: new SettingsBackend(),
        // Pre-seed checking so createServer does not auto-start a probe; the
        // concurrent validate requests below own the single in-flight check.
        geminiReadiness: {
            status: 'checking' as const,
            message: 'preflight',
            keyFingerprint: fingerprint,
        },
        validateGeminiKey: async () => {
            calls += 1;
            await gate;
        },
    };
    const srv = createServer(ctx);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const first = fetch(`${srvBase}/config/validate`, { method: 'POST' });
        const second = fetch(`${srvBase}/config/validate`, { method: 'POST' });
        // Yield so both handlers enter startConfiguredKeyValidation.
        await new Promise((r) => setTimeout(r, 20));
        release();
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(calls, 1);
        assert.equal((await json(a)).gemini.status, 'valid');
        assert.equal((await json(b)).gemini.status, 'valid');
    } finally {
        release();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

test("POST /config/validate returns needsKey when the saved key is rejected", async () => {
    const ctx = {
        config: {
            name: 'test',
            version: '1',
            embeddingModel: 'fake',
            geminiApiKey: 'saved-key',
            mode: 'local' as const,
        },
        store: new SettingsBackend(),
        geminiReadiness: {
            status: 'invalid' as const,
            message: 'stale',
            keyFingerprint: crypto.createHash('sha256').update('saved-key').digest('hex'),
        },
        validateGeminiKey: async () => { throw new Error('API_KEY_INVALID'); },
    };
    const srv = createServer(ctx);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const res = await fetch(`${srvBase}/config/validate`, { method: 'POST' });
        assert.equal(res.status, 503);
        const body = await json(res);
        assert.equal(body.needsKey, true);
        assert.equal(body.gemini.status, 'invalid');
        assert.match(body.error, /rejected|invalid/i);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

test("POST /config rejects an invalid candidate without replacing the working key", async () => {
    const ctx = {
        config: {
            name: 'test',
            version: '1',
            embeddingModel: 'fake',
            geminiApiKey: 'saved-key',
            mode: 'local' as const,
        },
        store: new SettingsBackend(),
        geminiReadiness: validGeminiReadiness('saved-key'),
        validateGeminiKey: async () => { throw new Error('API_KEY_INVALID'); },
    };
    const srv = createServer(ctx);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const rejected = await fetch(`${srvBase}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: 'bad-candidate' }),
        });
        assert.equal(rejected.status, 401);
        const rejectedBody = await json(rejected);
        assert.equal(rejectedBody.gemini.status, 'invalid');
        assert.equal(rejectedBody.needsKey, true);
        assert.equal(ctx.config.geminiApiKey, 'saved-key');

        const summary = await fetch(`${srvBase}/config`);
        assert.equal((await json(summary)).gemini.status, 'valid');
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

test("shared memory API handler mounts data routes without desktop /config", async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-shared-api-db-"));
    const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-shared-api-blob-"));
    const db = new LanceDBVectorDatabase({ uri: dbDir });
    const store = new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
        blobStore: new FileBlobStore(blobDir),
    });
    const srv = httpServer(createMemoryApiHandler({
        store,
        corsHeaders: { 'Access-Control-Allow-Origin': 'https://server.example.test' },
    }));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const configRes = await fetch(`${srvBase}/config`);
        assert.equal(configRes.status, 404);

        const preflightRes = await fetch(`${srvBase}/memories`, { method: "OPTIONS" });
        assert.equal(preflightRes.status, 204);
        assert.equal(preflightRes.headers.get("access-control-allow-origin"), "https://server.example.test");
        assert.ok((preflightRes.headers.get("access-control-allow-methods") ?? "").includes("POST"));
        assert.ok((preflightRes.headers.get("access-control-allow-headers") ?? "").includes("X-Gemdex-Token"));

        const createRes = await fetch(`${srvBase}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "shared handler memory notarize build with signing identity" }),
        });
        assert.equal(createRes.status, 201);
        assert.equal(createRes.headers.get("access-control-allow-origin"), "https://server.example.test");

        // Save-time similar-memory detection (#109): a near-duplicate create on
        // the SAME shared store instance surfaces the first memory in
        // `memory.similar` — additive field, single POST /memories round-trip.
        const duplicateRes = await fetch(`${srvBase}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "shared handler memory notarize build with signing identity tool" }),
        });
        assert.equal(duplicateRes.status, 201);
        const { memory: duplicateMemory } = await json(duplicateRes);
        assert.ok(Array.isArray(duplicateMemory.similar) && duplicateMemory.similar.length > 0, "expected memory.similar on a near-duplicate create");
        assert.ok(duplicateMemory.similar[0].similarity >= 0.9);

        const listRes = await fetch(`${srvBase}/memories`);
        assert.equal(listRes.status, 200);
        const { memories } = await json(listRes);
        assert.equal(memories.length, 2);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(dbDir, { recursive: true, force: true });
        fs.rmSync(blobDir, { recursive: true, force: true });
    }
});

test("data routes answer 503 needsKey when no local key is configured", async () => {
    const bare = createServer({ config: { mode: 'local' } as any, store: null });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const addr = bare.address() as AddressInfo;
    const bareBase = `http://127.0.0.1:${addr.port}`;
    try {
        const cfg = await fetch(`${bareBase}/config`);
        const cfgBody = await json(cfg);
        assert.equal(cfgBody.configured, false);
        assert.equal(cfgBody.needsKey, true);
        assert.equal(cfgBody.gemini.status, 'missing');

        const res = await fetch(`${bareBase}/memories`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { needsKey?: boolean };
        assert.equal(body.needsKey, true);
    } finally {
        await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
});

test("desktop settings configure, test, switch, migrate, and remove remotes without returning tokens", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-desktop-settings-"));
    const configStore = new ClientConfigStore({ rootDir });
    const local = new SettingsBackend([
        exportRecord('new-id', 'local new'),
        exportRecord('existing-id', 'local update'),
    ]);
    const remote = new SettingsBackend([exportRecord('existing-id', 'remote old')]);
    const token = "d".repeat(64);
    const srv = createServer({
        config: {
            name: 'test',
            version: '1',
            embeddingModel: 'fake',
            geminiApiKey: 'local-key',
            mode: 'local',
        },
        store: local,
        token,
        clientConfigStore: configStore,
        geminiReadiness: validGeminiReadiness('local-key'),
        createBackend: (config) => config.mode === 'remote' ? remote : local,
        fetch: (async (input) => {
            const url = String(input);
            if (url.endsWith('/v1/health')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/memories')) {
                return new Response(JSON.stringify({ memories: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }) as typeof fetch,
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const settingsBase = `http://127.0.0.1:${addr.port}`;
    const headers = {
        "Content-Type": "application/json",
        "X-Gemdex-Token": token,
    };
    try {
        const initial = await fetch(`${settingsBase}/settings`, { headers });
        assert.equal(initial.status, 200);
        const initialBody = await json(initial);
        assert.equal(initialBody.mode, 'local');
        assert.equal(initialBody.configured, true);
        assert.equal(initialBody.localConfigured, true);
        assert.equal(initialBody.gemini.status, 'valid');
        assert.deepEqual(initialBody.remotes, []);

        const add = await fetch(`${settingsBase}/settings/remotes`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: 'prod',
                url: 'https://memory.example.com/',
                token: 'long-lived-secret',
            }),
        });
        assert.equal(add.status, 200);
        const addText = await add.text();
        assert.doesNotMatch(addText, /long-lived-secret/);
        assert.match(fs.readFileSync(configStore.envPath, 'utf8'), /long-lived-secret/);

        const testResponse = await fetch(`${settingsBase}/settings/test`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'prod' }),
        });
        assert.deepEqual(await testResponse.json(), {
            reachable: true,
            authenticated: true,
        });

        const switchResponse = await fetch(`${settingsBase}/settings/mode`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ mode: 'remote', name: 'prod' }),
        });
        assert.equal(switchResponse.status, 200);
        assert.equal((await switchResponse.json() as any).activeRemote, 'prod');

        const remoteConfig = await fetch(`${settingsBase}/config`);
        assert.equal(remoteConfig.status, 200);
        const remoteConfigText = await remoteConfig.text();
        assert.doesNotMatch(remoteConfigText, /long-lived-secret/);
        assert.doesNotMatch(remoteConfigText, /tokenEnvVar/);
        const remoteConfigBody = JSON.parse(remoteConfigText);
        assert.equal(remoteConfigBody.configured, true);
        assert.equal(remoteConfigBody.mode, 'remote');
        assert.equal(remoteConfigBody.needsKey, false);
        assert.equal(remoteConfigBody.gemini.status, 'valid');
        assert.deepEqual(remoteConfigBody.activeRemote, {
            name: 'prod',
            url: 'https://memory.example.com',
            hasToken: true,
        });

        const remoteList = await fetch(`${settingsBase}/memories`, { headers });
        assert.equal(remoteList.status, 200);
        assert.equal((await remoteList.json() as any).memories.length, 1);

        const migration = await fetch(`${settingsBase}/settings/import-local`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'prod' }),
        });
        assert.deepEqual(await migration.json(), {
            created: 1,
            updated: 1,
            skipped: 0,
        });
        assert.equal(remote.records.get('new-id')?.id, 'new-id');

        const localMode = await fetch(`${settingsBase}/settings/mode`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ mode: 'local' }),
        });
        assert.equal((await localMode.json() as any).mode, 'local');

        const remove = await fetch(`${settingsBase}/settings/remotes/prod`, {
            method: 'DELETE',
            headers,
        });
        assert.equal(remove.status, 200);
        assert.deepEqual((await remove.json() as any).remotes, []);
        assert.doesNotMatch(fs.readFileSync(configStore.envPath, 'utf8'), /long-lived-secret/);

        configStore.add('broken', 'https://broken.example.com', 'MISSING_REMOTE_TOKEN');
        const brokenSwitch = await fetch(`${settingsBase}/settings/mode`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ mode: 'remote', name: 'broken' }),
        });
        assert.equal(brokenSwitch.status, 400);
        assert.equal(configStore.getEnv('GEMDEX_MODE'), 'local');
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test("CRUD lifecycle: create, list, get, update, delete", async () => {
    // create
    const createRes = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "remember the deploy token xyz", title: "Deploy" }),
    });
    assert.equal(createRes.status, 201);
    const { memory } = await json(createRes);
    assert.ok(memory.id);
    assert.equal(memory.title, "Deploy");

    // list
    const listRes = await fetch(`${base}/memories`);
    const { memories } = await json(listRes);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, memory.id);
    assert.ok(memories[0].preview.includes("deploy token"));

    // get
    const getRes = await fetch(`${base}/memories/${memory.id}`);
    assert.equal(getRes.status, 200);
    const fetched = (await json(getRes)).memory;
    assert.equal(fetched.content, "remember the deploy token xyz");

    // update
    const updateRes = await fetch(`${base}/memories/${memory.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "updated token abc", title: "Deploy v2" }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await json(updateRes)).memory;
    assert.equal(updated.content, "updated token abc");
    assert.equal(updated.title, "Deploy v2");

    // delete
    const delRes = await fetch(`${base}/memories/${memory.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const afterList = (await json(await fetch(`${base}/memories`))).memories;
    assert.equal(afterList.length, 0);
});

test("export then import round-trips memories", async () => {
    await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "alpha memory" }),
    });
    const exportRes = await fetch(`${base}/export`);
    const { records } = await json(exportRes);
    assert.ok(records.length >= 1);

    const importRes = await fetch(`${base}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
    });
    assert.equal(importRes.status, 200);
    const result = await json(importRes);
    assert.ok(result.imported >= 1);
});

test("import rejects missing records array", async () => {
    const res = await fetch(`${base}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid payload: 'records' must be an array" });
});

test("create requires non-empty content", async () => {
    const res = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   " }),
    });
    assert.equal(res.status, 400);
});

test("invalid JSON body returns 400", async () => {
    const res = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
});

test("get on unknown id returns 404", async () => {
    const res = await fetch(`${base}/memories/does-not-exist`);
    assert.equal(res.status, 404);
});

test("POST /recall returns matching memories by text query", async () => {
    await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "kafka retry backoff strategy notes", title: "Kafka" }),
    });
    const res = await fetch(`${base}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "kafka retry backoff", limit: 5 }),
    });
    assert.equal(res.status, 200);
    const { results } = await json(res);
    assert.ok(Array.isArray(results));
    assert.ok(results.some((r: any) => r.title === "Kafka"));
});

test("POST /recall with neither query nor attachments returns 400", async () => {
    const res = await fetch(`${base}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
});

test("create with neither content nor attachments returns 400", async () => {
    const res = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
});

test("multimodal: create with an attachment, then fetch its raw bytes", async () => {
    const mmDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-mm-db-"));
    const mmBlobDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-mm-blob-"));
    const db = new LanceDBVectorDatabase({ uri: mmDbDir });
    const mmStore = new LocalMemoryBackend({
        embedding: new FakeMultimodalEmbedding(),
        vectorDatabase: db,
        blobStore: new FileBlobStore(mmBlobDir),
    });
    const mmServer = createServer({ config: {} as any, store: mmStore });
    await new Promise<void>((resolve) => mmServer.listen(0, "127.0.0.1", resolve));
    const addr = mmServer.address() as AddressInfo;
    const mmBase = `http://127.0.0.1:${addr.port}`;
    try {
        const data = Buffer.from("PNGBYTES").toString("base64");
        const createRes = await fetch(`${mmBase}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "ui mock", attachments: [{ mimeType: "image/png", data, caption: "home" }] }),
        });
        assert.equal(createRes.status, 201);
        const { memory } = await json(createRes);
        assert.equal(memory.attachments.length, 1);
        assert.equal(memory.attachments[0].mimeType, "image/png");

        const attId = memory.attachments[0].id;
        const blobRes = await fetch(`${mmBase}/memories/${memory.id}/attachments/${attId}`);
        assert.equal(blobRes.status, 200);
        assert.equal(blobRes.headers.get("content-type"), "image/png");
        assert.equal(blobRes.headers.get("x-content-type-options"), "nosniff");
        const buf = Buffer.from(await blobRes.arrayBuffer());
        assert.equal(buf.toString(), "PNGBYTES");

        const missing = await fetch(`${mmBase}/memories/${memory.id}/attachments/nope`);
        assert.equal(missing.status, 404);

        // recall-by-media: the same bytes embed to the same vector, so a
        // media-only /recall finds the memory it was attached to.
        const recallRes = await fetch(`${mmBase}/recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ attachments: [{ mimeType: "image/png", data }] }),
        });
        assert.equal(recallRes.status, 200);
        const { results } = await json(recallRes);
        assert.ok(results.some((r: any) => r.id === memory.id));
    } finally {
        await new Promise<void>((resolve) => mmServer.close(() => resolve()));
        fs.rmSync(mmDbDir, { recursive: true, force: true });
        fs.rmSync(mmBlobDir, { recursive: true, force: true });
    }
});

test("attachment bytes force download for unsupported mime metadata", async () => {
    const unexpectedStoreCall = async (): Promise<never> => {
        throw new Error("Unexpected store call");
    };
    const store: MemoryBackend = {
        save: unexpectedStoreCall,
        recall: unexpectedStoreCall,
        update: unexpectedStoreCall,
        updateAttachmentCaptions: unexpectedStoreCall,
        get: unexpectedStoreCall,
        list: unexpectedStoreCall,
        delete: unexpectedStoreCall,
        exportAll: unexpectedStoreCall,
        importRecords: unexpectedStoreCall,
        readAttachment: async () => ({
            data: Buffer.from("<html></html>"),
            mimeType: "text/html",
            byteLength: Buffer.byteLength("<html></html>"),
        }),
    };
    const srv = httpServer(createMemoryApiHandler({ store }));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        const res = await fetch(`${srvBase}/memories/memory-id/attachments/attachment-id`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/octet-stream");
        assert.equal(res.headers.get("content-disposition"), "attachment");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "<html></html>");
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

test("PATCH /memories/:id/attachments updates a caption, 404 missing, 400 bad body", async () => {
    const mmDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-cap-db-"));
    const mmBlobDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-cap-blob-"));
    const db = new LanceDBVectorDatabase({ uri: mmDbDir });
    const mmStore = new LocalMemoryBackend({
        embedding: new FakeMultimodalEmbedding(),
        vectorDatabase: db,
        blobStore: new FileBlobStore(mmBlobDir),
    });
    const mmServer = createServer({ config: {} as any, store: mmStore });
    await new Promise<void>((resolve) => mmServer.listen(0, "127.0.0.1", resolve));
    const addr = mmServer.address() as AddressInfo;
    const mmBase = `http://127.0.0.1:${addr.port}`;
    try {
        const data = Buffer.from("CAPBYTES").toString("base64");
        const createRes = await fetch(`${mmBase}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "ui mock", attachments: [{ mimeType: "image/png", data, caption: "old" }] }),
        });
        assert.equal(createRes.status, 201);
        const { memory } = await json(createRes);
        const attId = memory.attachments[0].id;

        // happy path: 200 with the updated caption
        const okRes = await fetch(`${mmBase}/memories/${memory.id}/attachments`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions: [{ id: attId, caption: "new caption" }] }),
        });
        assert.equal(okRes.status, 200);
        const updated = (await json(okRes)).memory;
        assert.equal(updated.attachments[0].caption, "new caption");

        // 404 for an unknown memory id
        const missingRes = await fetch(`${mmBase}/memories/does-not-exist/attachments`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions: [{ id: "0", caption: "x" }] }),
        });
        assert.equal(missingRes.status, 404);

        // 400 for a malformed body (captions not an array)
        const badRes = await fetch(`${mmBase}/memories/${memory.id}/attachments`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions: "nope" }),
        });
        assert.equal(badRes.status, 400);

        // 405 for a non-PATCH method on the attachments collection path
        const wrongMethod = await fetch(`${mmBase}/memories/${memory.id}/attachments`, { method: "POST" });
        assert.equal(wrongMethod.status, 405);
    } finally {
        await new Promise<void>((resolve) => mmServer.close(() => resolve()));
        fs.rmSync(mmDbDir, { recursive: true, force: true });
        fs.rmSync(mmBlobDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Token enforcement tests
// ---------------------------------------------------------------------------

/** Spin up an isolated server with a specific token (and no allowedOrigin check
 *  so these tests work from any origin — Node fetch has no Origin header). */
async function withTokenServer(
    token: string,
    fn: (base: string) => Promise<void>,
): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-auth-"));
    const db = new LanceDBVectorDatabase({ uri: dir });
    const store = new LocalMemoryBackend({ embedding: new FakeEmbedding(), vectorDatabase: db });
    const srv = createServer({
        config: {} as any,
        store,
        token,
        validateGeminiKey: async () => undefined,
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        await fn(srvBase);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const TOKEN_CHAR = "a"; const TEST_TOKEN = TOKEN_CHAR.repeat(64); // 64-char hex-like test token

test("token: GET /health is accessible without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/health`);
        assert.equal(res.status, 200);
    });
});

test("token: GET /config is accessible without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/config`);
        assert.equal(res.status, 200);
    });
});

test("token: POST /config is accessible without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        // Validation is injected by withTokenServer; this test only covers auth.
        const res = await fetch(`${b}/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: "not-a-real-key" }),
        });
        assert.equal(res.status, 200);
    });
});

test("token: data route without token returns 401", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`);
        assert.equal(res.status, 401);
    });
});

test("token: data route with wrong token returns 401", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, {
            headers: { "X-Gemdex-Token": "b".repeat(64) },
        });
        assert.equal(res.status, 401);
    });
});

test("token: data route with correct token succeeds", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, {
            headers: { "X-Gemdex-Token": TEST_TOKEN },
        });
        assert.equal(res.status, 200);
        const { memories: list } = await res.json() as any;
        assert.ok(Array.isArray(list));
    });
});

test("token: OPTIONS preflight is allowed without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, { method: "OPTIONS" });
        assert.equal(res.status, 204);
    });
});

test("token: CORS headers include X-Gemdex-Token in Allow-Headers", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, { method: "OPTIONS" });
        const allow = res.headers.get("access-control-allow-headers") ?? "";
        assert.ok(allow.toLowerCase().includes("x-gemdex-token"), `allow-headers: ${allow}`);
    });
});

test("origin: request with mismatched Origin header returns 403", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-origin-"));
    const db = new LanceDBVectorDatabase({ uri: dir });
    const store = new LocalMemoryBackend({ embedding: new FakeEmbedding(), vectorDatabase: db });
    const srv = createServer({
        config: {} as any,
        store,
        token: TEST_TOKEN,
        allowedOrigin: "zero://app",
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        // A request with a foreign Origin header must be rejected.
        const res = await fetch(`${srvBase}/health`, {
            headers: { "Origin": "https://evil.example.com" },
        });
        assert.equal(res.status, 403);

        // A request with no Origin header (same-origin / CLI) must pass.
        const healthRes = await fetch(`${srvBase}/health`);
        assert.equal(healthRes.status, 200);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
