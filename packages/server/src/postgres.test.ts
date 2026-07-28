import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataType, newDb } from 'pg-mem';
import {
    Embedding,
    EmbeddingContent,
    EmbeddingVector,
    FileBlobStore,
} from 'gemdex-core';
import { migrateDatabase, PostgresMemoryBackend, type DatabasePool } from './postgres.js';

function createPool(): DatabasePool {
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

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 4;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return (await this.embedBatch([text]))[0];
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((text) => ({
            vector: text.toLowerCase().includes('alpha')
                ? [1, 0, 0, 0]
                : text.toLowerCase().includes('beta')
                    ? [0, 1, 0, 0]
                    : [0, 0, 0, 1],
            dimension: 4,
        }));
    }

    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return Promise.all(contents.map(async (content) => {
            if (typeof content === 'string') return this.embed(content);
            const decoded = Buffer.from(content.inlineData.data, 'base64').toString();
            return {
                vector: decoded.includes('red') ? [0, 0, 1, 0] : [0, 0, 0, 1],
                dimension: 4,
            };
        }));
    }

    getDimension(): number {
        return 4;
    }

    getProvider(): string {
        return 'fake';
    }

    isMultimodal(): boolean {
        return true;
    }
}

async function withMigratedBackend<T>(fn: (backend: PostgresMemoryBackend, pool: DatabasePool) => Promise<T>): Promise<T> {
    const pool = createPool();
    await migrateDatabase(pool);
    const backend = new PostgresMemoryBackend({ pool, usePgVectorQueries: false });
    try {
        return await fn(backend, pool);
    } finally {
        await backend.close();
    }
}

test('migrations create a clean database from scratch and record bookkeeping', async () => {
    const pool = createPool();
    try {
        await migrateDatabase(pool);
        await migrateDatabase(pool);
        const tables = await pool.query<{ table_name: string }>(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name LIKE 'gemdex_%'
             ORDER BY table_name`,
        );
        assert.deepEqual(tables.rows.map((row) => row.table_name), [
            'gemdex_attachment_blobs',
            'gemdex_memory_attachments',
            'gemdex_memory_chunks',
            'gemdex_memory_documents',
            'gemdex_schema_migrations',
        ]);

        const migrations = await pool.query<{ version: string }>(
            'SELECT version FROM gemdex_schema_migrations ORDER BY version',
        );
        assert.deepEqual(migrations.rows.map((row) => row.version), ['001', '002']);
    } finally {
        await pool.end();
    }
});

test('PostgresMemoryBackend persists save/update/delete/list/export/import across backend instances', async () => {
    await withMigratedBackend(async (backend, pool) => {
        const png = Buffer.from('not-a-real-png-but-valid-base64-for-storage');
        const created = await backend.save({
            title: 'Original title',
            content: 'alpha remote memory content',
            attachments: [{ mimeType: 'image/png', data: png.toString('base64'), caption: 'Architecture diagram' }],
        });
        assert.equal(created.title, 'Original title');
        assert.equal(created.attachments.length, 1);
        assert.equal(created.attachments[0].id, '0');

        const afterRestart = new PostgresMemoryBackend({ pool });
        const restored = await afterRestart.get(created.id);
        assert.equal(restored?.content, 'alpha remote memory content');
        assert.equal(restored?.attachments[0].caption, 'Architecture diagram');

        const blob = await afterRestart.readAttachment(created.id, '0');
        assert.equal(blob?.mimeType, 'image/png');
        assert.equal(blob?.data.toString(), png.toString());

        const updated = await afterRestart.update(created.id, { content: 'beta updated memory content' });
        assert.equal(updated.content, 'beta updated memory content');
        assert.equal(updated.attachments[0].id, '0');

        const listed = await afterRestart.list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].preview, 'beta updated memory content');
        assert.equal(listed[0].attachments.length, 1);

        const exported = await afterRestart.exportAll();
        assert.equal(exported.length, 1);
        assert.equal(exported[0].id, created.id);
        assert.equal(exported[0].attachments?.[0]?.data, png.toString('base64'));

        await afterRestart.delete(created.id);
        assert.equal(await afterRestart.get(created.id), null);
        assert.deepEqual(await afterRestart.list(), []);

        const result = await afterRestart.importRecords(exported);
        assert.deepEqual(result, { imported: 1, failed: 0, errors: [] });

        const importedBackend = new PostgresMemoryBackend({ pool });
        const imported = await importedBackend.get(created.id);
        assert.equal(imported?.content, 'beta updated memory content');
        assert.equal(imported?.attachments[0].caption, 'Architecture diagram');
        assert.equal((await importedBackend.exportAll()).length, 1);
    });
});

test('schema stores chunks separately while recall returns full parent memories', async () => {
    const pool = createPool();
    await migrateDatabase(pool);
    const backend = new PostgresMemoryBackend({
        pool,
        embedding: new FakeEmbedding(),
        usePgVectorQueries: false,
    });
    try {
        const longContent = `${'intro '.repeat(400)}needle-section ${'details '.repeat(400)}`;
        const memory = await backend.save({ content: longContent, title: 'Chunked parent' });

        const chunks = await pool.query<{ content: string }>(
            'SELECT content FROM gemdex_memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
            [memory.id],
        );
        assert.ok(chunks.rows.length > 1, 'long memory should be split into multiple retrieval chunks');
        assert.ok(chunks.rows.every((row) => row.content.length < longContent.length));

        const results = await backend.recall('needle-section alpha', 5);
        assert.equal(results.length, 1);
        assert.equal(results[0].id, memory.id);
        assert.equal(results[0].content, longContent);
    } finally {
        await backend.close();
    }
});

test('hybrid recall supports text, media, mixed RRF, and parent dedupe', async () => {
    const pool = createPool();
    await migrateDatabase(pool);
    const backend = new PostgresMemoryBackend({
        pool,
        embedding: new FakeEmbedding(),
        usePgVectorQueries: false,
    });
    try {
        const red = Buffer.from('red image bytes').toString('base64');
        const alphaWithMedia = await backend.save({
            title: 'Alpha with media',
            content: `alpha ${'details '.repeat(500)}`,
            attachments: [{ mimeType: 'image/png', data: red }],
        });
        const alphaTextOnly = await backend.save({
            title: 'Alpha text only',
            content: 'alpha reference',
        });
        const beta = await backend.save({
            title: 'Beta',
            content: 'beta reference',
        });

        const textResults = await backend.recall('alpha', 10);
        assert.deepEqual(new Set(textResults.map((result) => result.id)), new Set([
            alphaWithMedia.id,
            alphaTextOnly.id,
        ]));
        assert.equal(textResults.filter((result) => result.id === alphaWithMedia.id).length, 1);

        const mediaResults = await backend.recall(undefined, 10, [{ mimeType: 'image/png', data: red }]);
        assert.equal(mediaResults[0].id, alphaWithMedia.id);

        const mixedResults = await backend.recall('alpha', 10, [{ mimeType: 'image/png', data: red }]);
        assert.equal(mixedResults[0].id, alphaWithMedia.id);
        assert.ok(mixedResults[0].score > mixedResults.find((result) => result.id === alphaTextOnly.id)!.score);
        assert.ok(!mixedResults.some((result) => result.id === beta.id));
    } finally {
        await backend.close();
    }
});

test('list and recall batch-load attachments and group them by their own memory', async () => {
    await withMigratedBackend(async (backend) => {
        const a = await backend.save({
            content: 'alpha shared-token apple',
            title: 'Alpha',
            attachments: [{ mimeType: 'image/png', data: Buffer.from('img-a').toString('base64'), caption: 'cap-a' }],
        });
        const b = await backend.save({ content: 'beta shared-token banana', title: 'Beta' });
        const c = await backend.save({
            content: 'gamma shared-token cherry',
            title: 'Gamma',
            attachments: [
                { mimeType: 'image/png', data: Buffer.from('img-c0').toString('base64'), caption: 'cap-c0' },
                { mimeType: 'image/png', data: Buffer.from('img-c1').toString('base64'), caption: 'cap-c1' },
            ],
        });

        const listed = await backend.list();
        const listedById = new Map(listed.map((m) => [m.id, m]));
        assert.equal(listed.length, 3);
        assert.equal(listedById.get(a.id)?.attachments.length, 1);
        assert.equal(listedById.get(a.id)?.attachments[0].caption, 'cap-a');
        assert.equal(listedById.get(b.id)?.attachments.length, 0);
        assert.deepEqual(listedById.get(c.id)?.attachments.map((x) => x.caption), ['cap-c0', 'cap-c1']);

        const recalled = await backend.recall('shared-token', 10);
        const recalledById = new Map(recalled.map((m) => [m.id, m]));
        assert.equal(recalled.length, 3);
        assert.equal(recalledById.get(a.id)?.attachments.length, 1);
        assert.equal(recalledById.get(b.id)?.attachments.length, 0);
        assert.equal(recalledById.get(c.id)?.attachments.length, 2);
    });
});

test('external blob store backs save, read, export, import, and delete', async () => {
    const pool = createPool();
    const blobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-postgres-blobs-'));
    const blobStore = new FileBlobStore(blobDir);
    await migrateDatabase(pool);
    const backend = new PostgresMemoryBackend({
        pool,
        blobStore,
        blobStorageProvider: 'file',
    });

    try {
        const bytes = Buffer.from('external attachment bytes');
        const memory = await backend.save({
            content: 'external blob memory',
            attachments: [{ mimeType: 'image/png', data: bytes.toString('base64') }],
        });

        const blobRow = await pool.query<{ storage_provider: string; storage_key: string; data: Buffer | null }>(
            'SELECT storage_provider, storage_key, data FROM gemdex_attachment_blobs',
        );
        assert.equal(blobRow.rows[0].storage_provider, 'file');
        assert.equal(blobRow.rows[0].data, null);
        assert.equal(await blobStore.has(blobRow.rows[0].storage_key), true);
        assert.equal((await backend.readAttachment(memory.id, '0'))?.data.toString(), bytes.toString());

        const exported = await backend.exportAll();
        assert.equal(exported[0].attachments?.[0].data, bytes.toString('base64'));

        await backend.delete(memory.id);
        assert.equal(await blobStore.has(blobRow.rows[0].storage_key), false);

        assert.deepEqual(await backend.importRecords(exported), { imported: 1, failed: 0, errors: [] });
        assert.equal((await backend.readAttachment(memory.id, '0'))?.data.toString(), bytes.toString());
    } finally {
        await backend.close();
        await fs.rm(blobDir, { recursive: true, force: true });
    }
});
