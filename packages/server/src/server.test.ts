import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DataType, newDb } from 'pg-mem';
import type { MemoryBackend } from 'gemdex-core';
import type {
    EmbeddingContent,
    EmbeddingVector,
    ImportRecordsResult,
    Memory,
    MemoryAttachment,
    MemoryAttachmentInput,
    MemorySummary,
    MemoryRecallResult,
    MemoryExportRecord,
    AttachmentBytes,
    SaveMemoryInput,
    UpdateMemoryInput,
    AttachmentCaptionUpdate,
} from 'gemdex-core';
import {
    DEFAULT_ATTACHMENT_LIMITS,
    Embedding,
    SUPPORTED_API_VERSION,
    SUPPORTED_PROTOCOL_VERSION,
    mimeToKind,
    validateAttachments,
} from 'gemdex-core';
import type { ServerVersionInfo } from 'gemdex-core';
import type { ServerConfig } from './config.js';
import type { DatabasePool } from './postgres.js';
import { createConfiguredStore, createServer } from './server.js';

/**
 * Minimal in-memory MemoryBackend stub for testing the shared handler
 * integration without requiring a real database.
 */
class FakeMemoryBackend implements MemoryBackend {
    private memories: Map<string, Memory> = new Map();
    private attachmentBytes: Map<string, Buffer> = new Map();
    private counter = 0;
    lastRecall: { query?: string; limit?: number; attachments?: MemoryAttachmentInput[] } | null = null;

    async save(input: SaveMemoryInput): Promise<Memory> {
        const id = `mem_${++this.counter}`;
        const now = Date.now();
        const attachments = await this.prepareAttachments(id, input.attachments);
        const memory: Memory = {
            id,
            title: input.title ?? '',
            content: input.content ?? '',
            attachments,
            createdAt: now,
            updatedAt: now,
        };
        this.memories.set(id, memory);
        return memory;
    }

    async recall(
        query?: string,
        limit?: number,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        if (queryAttachments) await validateAttachments(queryAttachments);
        this.lastRecall = { query, limit, attachments: queryAttachments };
        const items = [...this.memories.values()].slice(0, limit ?? 10);
        return items.map((m) => ({ ...m, score: 1.0 }));
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = this.memories.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        const attachments = input.attachments === undefined
            ? existing.attachments
            : await this.prepareAttachments(id, input.attachments);
        const updated: Memory = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.title !== undefined && { title: input.title }),
            attachments,
            updatedAt: Date.now(),
        };
        this.memories.set(id, updated);
        return updated;
    }

    async updateAttachmentCaptions(id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const existing = this.memories.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        return existing;
    }

    async get(id: string): Promise<Memory | null> {
        return this.memories.get(id) ?? null;
    }

    async list(): Promise<MemorySummary[]> {
        return [...this.memories.values()].map((m) => ({
            id: m.id,
            title: m.title,
            preview: m.content.slice(0, 100),
            attachments: [],
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
        }));
    }

    async delete(id: string): Promise<void> {
        this.memories.delete(id);
        for (const key of this.attachmentBytes.keys()) {
            if (key.startsWith(`${id}:`)) this.attachmentBytes.delete(key);
        }
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        return [...this.memories.values()].map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            attachments: [],
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
        }));
    }

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        for (const record of records) {
            const attachments = await this.prepareAttachments(record.id, record.attachments);
            this.memories.set(record.id, {
                id: record.id,
                title: record.title,
                content: record.content,
                attachments,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
            });
        }
        return { imported: records.length, failed: 0, errors: [] };
    }

    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const memory = this.memories.get(memoryId);
        const attachment = memory?.attachments.find((item) => item.id === attachmentId);
        const data = this.attachmentBytes.get(`${memoryId}:${attachmentId}`);
        if (!attachment || !data) return null;
        return {
            mimeType: attachment.mimeType,
            byteLength: data.length,
            caption: attachment.caption,
            data,
        };
    }

    private async prepareAttachments(
        memoryId: string,
        attachments: MemoryAttachmentInput[] | undefined,
    ): Promise<MemoryAttachment[]> {
        if (!attachments) return [];
        const validated = await validateAttachments(attachments);
        return validated.map((attachment, index) => {
            const id = String(index);
            this.attachmentBytes.set(`${memoryId}:${id}`, attachment.bytes);
            return {
                id,
                kind: mimeToKind(attachment.mimeType)!,
                mimeType: attachment.mimeType,
                byteLength: attachment.byteLength,
                ...(attachment.caption && { caption: attachment.caption }),
            };
        });
    }
}

class FakeServerEmbedding extends Embedding {
    protected maxTokens = 8192;
    calls = 0;

    async detectDimension(): Promise<number> {
        return 4;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return (await this.embedBatch([text]))[0];
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.calls += texts.length;
        return texts.map(() => ({ vector: [1, 0, 0, 0], dimension: 4 }));
    }

    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        this.calls += contents.length;
        return contents.map(() => ({ vector: [1, 0, 0, 0], dimension: 4 }));
    }

    getDimension(): number {
        return 4;
    }

    getProvider(): string {
        return 'fake-server';
    }

    isMultimodal(): boolean {
        return true;
    }
}

function createPgMemPool(): DatabasePool {
    const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
    db.registerExtension('vector', (schema) => {
        schema.registerEquivalentType({
            name: 'vector',
            equivalentTo: DataType.text,
            isValid: (value) => typeof value === 'string' && value.startsWith('['),
        });
    });
    const adapter = db.adapters.createPg();
    return new adapter.Pool() as DatabasePool;
}

function postgresServerConfig(): ServerConfig {
    return {
        host: '127.0.0.1',
        port: 8765,
        token: 'test-token',
        unsafeDevNoAuth: false,
        allowedOrigins: [],
        databaseUrl: 'postgres://injected-pool',
        embeddingModel: 'gemini-embedding-2',
        blobStore: { kind: 'file' },
    };
}

async function withServer(
    store: MemoryBackend | null,
    fn: (base: string) => Promise<void>,
    options: { token?: string; unsafeDevNoAuth?: boolean; allowedOrigins?: string[] } = { token: 'test-token' },
): Promise<void> {
    const server = createServer({ store, ...options });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
        await fn(base);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test('GET /v1/health returns 200 { ok: true }', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/v1/health`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    });
});

test('GET /v1/version returns correct shape', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/v1/version`);
        assert.equal(res.status, 200);
        const body = await res.json() as ServerVersionInfo;
        assert.equal(body.name, 'gemdex-server');
        assert.equal(body.apiVersion, SUPPORTED_API_VERSION);
        assert.equal(body.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
        assert.equal(body.minClientVersion, '0.3.0');
        assert.deepEqual(body.capabilities, {
            attachments: true,
            recallAttachments: true,
            importExport: true,
            auth: ['bearer'],
        });
    });
});

test('GET /v1/memories with no store returns 503', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(res.status, 503);
        const body = await res.json() as { error: string };
        assert.equal(typeof body.error, 'string');
        assert.ok(body.error.length > 0, 'error message should be non-empty');
    });
});

test('GET /v1/memories with a fake store returns 200 { memories: [] }', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(res.status, 200);
        const body = await res.json() as { memories: unknown[] };
        assert.deepEqual(body, { memories: [] });
    });
});

test('POST /v1/memories with fake store creates a memory and lists it', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const createRes = await fetch(`${base}/v1/memories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
            body: JSON.stringify({ content: 'test memory content', title: 'Test' }),
        });
        assert.equal(createRes.status, 201);
        const { memory } = await createRes.json() as { memory: { id: string; title: string } };
        assert.ok(memory.id);
        assert.equal(memory.title, 'Test');

        const listRes = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(listRes.status, 200);
        const { memories } = await listRes.json() as { memories: Array<{ id: string }> };
        assert.equal(memories.length, 1);
        assert.equal(memories[0].id, memory.id);
    });
});

test('v1 memory API covers create/get/patch/put/recall/export/delete/import', async () => {
    const store = new FakeMemoryBackend();
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const imageData = Buffer.from('valid image-like bytes').toString('base64');
    await withServer(store, async (base) => {
        const createdResponse = await fetch(`${base}/v1/memories`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
                title: 'Remote memory',
                content: 'full parent content',
                attachments: [{ mimeType: 'image/png', data: imageData, caption: 'diagram' }],
            }),
        });
        assert.equal(createdResponse.status, 201);
        const created = (await createdResponse.json() as { memory: Memory }).memory;
        assert.equal(created.attachments.length, 1);

        const getResponse = await fetch(`${base}/v1/memories/${created.id}`, { headers: auth });
        assert.equal(getResponse.status, 200);
        assert.equal((await getResponse.json() as { memory: Memory }).memory.content, 'full parent content');

        const attachmentResponse = await fetch(
            `${base}/v1/memories/${created.id}/attachments/0`,
            { headers: auth },
        );
        assert.equal(attachmentResponse.status, 200);
        assert.equal(Buffer.from(await attachmentResponse.arrayBuffer()).toString(), 'valid image-like bytes');

        const patchResponse = await fetch(`${base}/v1/memories/${created.id}`, {
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ title: 'Patched title' }),
        });
        assert.equal(patchResponse.status, 200);
        assert.equal((await patchResponse.json() as { memory: Memory }).memory.title, 'Patched title');

        const putResponse = await fetch(`${base}/v1/memories/${created.id}`, {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ content: 'updated full parent content' }),
        });
        assert.equal(putResponse.status, 200);

        const recallResponse = await fetch(`${base}/v1/recall`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
                query: 'updated',
                limit: 5,
                attachments: [{ mimeType: 'image/png', data: imageData }],
            }),
        });
        assert.equal(recallResponse.status, 200);
        const recalled = (await recallResponse.json() as { results: MemoryRecallResult[] }).results;
        assert.equal(recalled[0].content, 'updated full parent content');
        assert.equal(store.lastRecall?.limit, 5);
        assert.equal(store.lastRecall?.attachments?.length, 1);

        const exportResponse = await fetch(`${base}/v1/export`, { headers: auth });
        assert.equal(exportResponse.status, 200);
        const records = (await exportResponse.json() as { records: MemoryExportRecord[] }).records;
        assert.equal(records.length, 1);

        const deleteResponse = await fetch(`${base}/v1/memories/${created.id}`, {
            method: 'DELETE',
            headers: auth,
        });
        assert.equal(deleteResponse.status, 200);
        assert.equal((await fetch(`${base}/v1/memories/${created.id}`, { headers: auth })).status, 404);
        assert.equal((await fetch(`${base}/v1/memories/${created.id}`, {
            method: 'DELETE',
            headers: auth,
        })).status, 404);

        const importResponse = await fetch(`${base}/v1/import`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ records }),
        });
        assert.equal(importResponse.status, 200);
        assert.deepEqual(await importResponse.json(), { imported: 1, failed: 0, errors: [] });
        assert.equal((await fetch(`${base}/v1/memories/${created.id}`, { headers: auth })).status, 200);
    });
});

test('v1 memory API rejects invalid request fields with actionable 400 responses', async () => {
    const store = new FakeMemoryBackend();
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const cases = [
        { path: '/v1/memories', method: 'POST', body: [] },
        { path: '/v1/memories', method: 'POST', body: { content: 42 } },
        { path: '/v1/memories', method: 'POST', body: { attachments: {} } },
        { path: '/v1/recall', method: 'POST', body: {} },
        { path: '/v1/recall', method: 'POST', body: { query: 42 } },
        { path: '/v1/recall', method: 'POST', body: { query: 'x', limit: 51 } },
        { path: '/v1/memories/missing', method: 'PATCH', body: {} },
        { path: '/v1/memories/missing', method: 'PATCH', body: { title: 42 } },
        { path: '/v1/import', method: 'POST', body: { records: [{}] } },
    ];

    await withServer(store, async (base) => {
        for (const item of cases) {
            const response = await fetch(`${base}${item.path}`, {
                method: item.method,
                headers,
                body: JSON.stringify(item.body),
            });
            assert.equal(response.status, 400, `${item.method} ${item.path}`);
            const result = await response.json() as { error: string };
            assert.ok(result.error.length > 0);
        }
    });
});

test('v1 memory API enforces the 20 MiB decoded attachment limit', async () => {
    const store = new FakeMemoryBackend();
    const oversizedBase64 = 'A'.repeat(Math.ceil(DEFAULT_ATTACHMENT_LIMITS.maxBytesPerAttachment * 1.37) + 257);
    await withServer(store, async (base) => {
        const response = await fetch(`${base}/v1/memories`, {
            method: 'POST',
            headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                attachments: [{ mimeType: 'image/png', data: oversizedBase64 }],
            }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json() as { error: string }).error, /per-attachment limit/);
    });
});

test('configured server routes execute embeddings on the server-owned backend', async () => {
    const pool = createPgMemPool();
    const embedding = new FakeServerEmbedding();
    const store = await createConfiguredStore(postgresServerConfig(), {
        pool,
        embedding,
        usePgVectorQueries: false,
    });
    assert.ok(store);
    try {
        await withServer(store, async (base) => {
            const createResponse = await fetch(`${base}/v1/memories`, {
                method: 'POST',
                headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'server embeds this remote content' }),
            });
            assert.equal(createResponse.status, 201);

            const recallResponse = await fetch(`${base}/v1/recall`, {
                method: 'POST',
                headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'remote content' }),
            });
            assert.equal(recallResponse.status, 200);
            assert.ok(embedding.calls >= 2);
        });
    } finally {
        await pool.end();
    }
});

test('configured server routes report a missing server Gemini key on embedding work', async () => {
    const pool = createPgMemPool();
    const store = await createConfiguredStore(postgresServerConfig(), {
        pool,
        usePgVectorQueries: false,
    });
    assert.ok(store);
    try {
        await withServer(store, async (base) => {
            const response = await fetch(`${base}/v1/memories`, {
                method: 'POST',
                headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'requires a server embedding' }),
            });
            assert.equal(response.status, 400);
            assert.match((await response.json() as { error: string }).error, /GEMINI_API_KEY.*gemdex-server/);
        });
    } finally {
        await pool.end();
    }
});

test('health and version routes work even when store is null', async () => {
    await withServer(null, async (base) => {
        const health = await fetch(`${base}/v1/health`);
        assert.equal(health.status, 200);

        const version = await fetch(`${base}/v1/version`);
        assert.equal(version.status, 200);

        const memories = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(memories.status, 503);
    });
});

test('unknown route returns 404', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/unknown-path`);
        assert.equal(res.status, 404);
    });
});


test('data routes require a bearer token', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const missing = await fetch(`${base}/v1/memories`);
        assert.equal(missing.status, 401);
        assert.deepEqual(await missing.json(), { error: 'Unauthorized' });

        const invalid = await fetch(`${base}/v1/memories`, {
            headers: { Authorization: 'Bearer wrong-token' },
        });
        assert.equal(invalid.status, 401);

        const malformed = await fetch(`${base}/v1/memories`, {
            headers: { Authorization: 'Basic test-token' },
        });
        assert.equal(malformed.status, 401);
    });
});

test('data routes accept the configured bearer token', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            headers: { Authorization: 'Bearer test-token' },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { memories: [] });
    });
});

test('unsafe dev mode permits data routes without auth', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`);
        assert.equal(res.status, 200);
    }, { unsafeDevNoAuth: true });
});

test('CORS preflight allows a configured origin and Authorization header', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://app.example.test',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization, content-type',
            },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.test');
        assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test'] });
});

test('CORS matches a configured origin that has a trailing slash', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://app.example.test',
                'Access-Control-Request-Method': 'GET',
            },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.test');
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test/'] });
});

test('CORS preflight rejects a disallowed origin', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://evil.example.test',
                'Access-Control-Request-Method': 'GET',
            },
        });
        assert.equal(res.status, 403);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test'] });
});

test('CORS actual requests include headers only for allowed origins', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const allowed = await fetch(`${base}/v1/memories`, {
            headers: {
                Origin: 'https://app.example.test',
                Authorization: 'Bearer test-token',
            },
        });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');

        const disallowed = await fetch(`${base}/v1/memories`, {
            headers: {
                Origin: 'https://evil.example.test',
                Authorization: 'Bearer test-token',
            },
        });
        assert.equal(disallowed.status, 403);
        assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test'] });
});
