import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LanceDBVectorDatabase } from '../vectordb';
import { Embedding, EmbeddingVector } from '../embedding';
import type { EmbeddingContent } from '../embedding';
import { MemoryStore } from './memory-store';
import { FileBlobStore, S3BlobStore } from './blob-store';

const DIM = 16;

function vectorizeTokens(text: string): number[] {
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

/**
 * Deterministic offline embedding: hashes word tokens into a fixed-dim vector
 * so semantically-overlapping text lands near each other, without hitting the
 * Gemini API. Good enough to exercise dense ranking in tests.
 */
class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return DIM;
    }

    getDimension(): number {
        return DIM;
    }

    getProvider(): string {
        return 'Fake';
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: this.vectorize(text), dimension: DIM };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: this.vectorize(t), dimension: DIM }));
    }

    private vectorize(text: string): number[] {
        const vec: number[] = [];
        for (let i = 0; i < DIM; i++) vec.push(0);
        const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
        let total = 0;
        for (const token of tokens) {
            let hash = 0;
            for (let i = 0; i < token.length; i++) {
                hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
            }
            vec[hash % DIM] += 1;
            total += 1;
        }
        // Avoid an all-zero vector (cosine/L2 degenerate).
        if (total === 0) vec[0] = 1;
        return vec;
    }
}

describe('MemoryStore', () => {
    let tmpDir: string;
    let store: MemoryStore;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-memory-test-'));
        const db = new LanceDBVectorDatabase({ uri: tmpDir });
        store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('saves a memory and returns an id + derived title', async () => {
        const mem = await store.save({ content: 'Notarize builds with the gemdex signing identity' });
        expect(mem.id).toBeTruthy();
        expect(mem.title).toBe('Notarize builds with the gemdex signing identity');
        expect(mem.createdAt).toBeGreaterThan(0);
        expect(mem.updatedAt).toBe(mem.createdAt);
    });

    it('uses an explicit title when provided', async () => {
        const mem = await store.save({ content: 'some content', title: 'My Title' });
        expect(mem.title).toBe('My Title');
    });

    it('gets a full memory back by id', async () => {
        const saved = await store.save({ content: 'the answer is 42', title: 'Answer' });
        const fetched = await store.get(saved.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.content).toBe('the answer is 42');
        expect(fetched!.title).toBe('Answer');
    });

    it('recall returns the FULL parent memory, never a fragment, for long content', async () => {
        // Build a long memory whose unique phrase sits deep inside it.
        const filler = 'general setup notes about the project environment\n'.repeat(120);
        const needle = 'the secret deployment token is alpha-bravo-charlie';
        const content = `${filler}\n${needle}\n${filler}`;
        const saved = await store.save({ content, title: 'Deployment playbook' });

        const results = await store.recall('secret deployment token', 5);
        expect(results.length).toBeGreaterThan(0);
        const hit = results.find((r) => r.id === saved.id);
        expect(hit).toBeDefined();
        // Full content stitched back — not just the matching chunk.
        expect(hit!.content).toBe(content);
        expect(hit!.content).toContain(needle);
    });

    it('recall dedupes by parent (one entry per memory)', async () => {
        const content = 'repeated keyword keyword keyword '.repeat(200);
        const saved = await store.save({ content, title: 'Repeated' });
        const results = await store.recall('keyword', 10);
        const matches = results.filter((r) => r.id === saved.id);
        expect(matches.length).toBe(1);
    });

    it('updates a memory in place under the same id and bumps updatedAt', async () => {
        const saved = await store.save({ content: 'original', title: 'T' });
        await new Promise((r) => setTimeout(r, 5));
        const updated = await store.update(saved.id, { content: 'revised content', title: 'T2' });
        expect(updated.id).toBe(saved.id);
        expect(updated.content).toBe('revised content');
        expect(updated.title).toBe('T2');
        expect(updated.createdAt).toBe(saved.createdAt);
        expect(updated.updatedAt).toBeGreaterThanOrEqual(saved.createdAt);

        const fetched = await store.get(saved.id);
        expect(fetched!.content).toBe('revised content');
    });

    it('update throws for an unknown id', async () => {
        await expect(store.update('does-not-exist', { content: 'x' })).rejects.toThrow(/not found/i);
    });

    it('lists memories sorted by updatedAt desc', async () => {
        const a = await store.save({ content: 'first memory' });
        await new Promise((r) => setTimeout(r, 5));
        const b = await store.save({ content: 'second memory' });
        const list = await store.list();
        expect(list.length).toBe(2);
        expect(list[0].id).toBe(b.id);
        expect(list[1].id).toBe(a.id);
        expect(list[0].preview).toContain('second memory');
    });

    it('deletes a memory', async () => {
        const saved = await store.save({ content: 'delete me' });
        await store.delete(saved.id);
        expect(await store.get(saved.id)).toBeNull();
        expect(await store.list()).toHaveLength(0);
    });

    it('exports and re-imports memories (upsert by id)', async () => {
        const a = await store.save({ content: 'export A', title: 'A' });
        const b = await store.save({ content: 'export B', title: 'B' });
        const records = await store.exportAll();
        expect(records.length).toBe(2);

        await store.delete(a.id);
        await store.delete(b.id);
        expect(await store.list()).toHaveLength(0);

        const { imported } = await store.importRecords(records);
        expect(imported).toBe(2);
        const restored = await store.get(a.id);
        expect(restored!.content).toBe('export A');
    });

    it('importRecords collects per-record failures and imports the rest', async () => {
        const result = await store.importRecords([
            { id: 'import-ok-1', title: 'OK 1', content: 'first good record', createdAt: 1, updatedAt: 2 },
            {
                id: 'import-bad-media',
                title: 'Bad media',
                content: 'record whose attachment cannot embed',
                createdAt: 3,
                updatedAt: 4,
                attachments: [{ mimeType: 'image/png', data: Buffer.from('img').toString('base64') }],
            },
            { id: 'import-ok-2', title: 'OK 2', content: 'second good record', createdAt: 5, updatedAt: 6 },
        ]);

        // FakeEmbedding is not multimodal, so the media record throws inside
        // writeMemory — it must be collected without aborting the loop.
        expect(result.imported).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].index).toBe(1);
        expect(result.errors[0].id).toBe('import-bad-media');
        expect(result.errors[0].error).toMatch(/multimodal/i);

        expect((await store.get('import-ok-1'))?.content).toBe('first good record');
        expect((await store.get('import-ok-2'))?.content).toBe('second good record');
        expect(await store.get('import-bad-media')).toBeNull();
    });

    it('lists parents with all their row vectors', async () => {
        const short = await store.save({ content: 'short memory', title: 'Short' });
        // Long enough to chunk into multiple rows (~1500 chars per chunk).
        const long = await store.save({ content: 'long filler line\n'.repeat(200), title: 'Long' });

        const parents = await store.listParentsWithVectors();
        expect(parents).toHaveLength(2);
        const shortParent = parents.find((p) => p.id === short.id)!;
        expect(shortParent.title).toBe('Short');
        expect(shortParent.fullContent).toBe('short memory');
        expect(shortParent.vectors).toHaveLength(1);
        expect(shortParent.vectors[0]).toHaveLength(DIM);
        expect(shortParent.createdAt).toBe(short.createdAt);

        const longParent = parents.find((p) => p.id === long.id)!;
        expect(longParent.vectors.length).toBeGreaterThan(1);
    });

    it('returns an empty attachments array for text-only memories', async () => {
        const mem = await store.save({ content: 'plain text memory' });
        expect(mem.attachments).toEqual([]);
        const fetched = await store.get(mem.id);
        expect(fetched!.attachments).toEqual([]);
    });
});

/**
 * Like FakeEmbedding, but advertises multimodal support and can embed inline
 * media (it hashes the mimeType + base64 payload into the same fixed-dim space).
 */
class FakeMultimodalEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'FakeMultimodal'; }
    isMultimodal(): boolean { return true; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: vectorizeTokens(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: vectorizeTokens(t), dimension: DIM }));
    }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return contents.map((c) => {
            const seed = typeof c === 'string' ? c : `${c.inlineData.mimeType}:${c.inlineData.data}`;
            return { vector: vectorizeTokens(seed), dimension: DIM };
        });
    }
}

/** Like FakeMultimodalEmbedding, but counts every embedding call so a test can
 *  prove the caption-only path performs NO embedding. */
class CountingMultimodalEmbedding extends FakeMultimodalEmbedding {
    embedCalls = 0;
    async embed(text: string): Promise<EmbeddingVector> {
        this.embedCalls += 1;
        return super.embed(text);
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.embedCalls += 1;
        return super.embedBatch(texts);
    }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        this.embedCalls += 1;
        return super.embedContentBatch(contents);
    }
}



class FakeS3Client {
    readonly objects = new Map<string, Buffer>();

    async send(command: { constructor: { name: string }; input?: Record<string, any> }): Promise<Record<string, any>> {
        const input = command.input ?? {};
        const key = input.Key as string | undefined;
        if (command.constructor.name === 'PutObjectCommand') {
            this.objects.set(key!, Buffer.from(input.Body as Buffer));
            return {};
        }
        if (command.constructor.name === 'GetObjectCommand') {
            const object = this.objects.get(key!);
            if (!object) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
            return { Body: object };
        }
        if (command.constructor.name === 'HeadObjectCommand') {
            if (!this.objects.has(key!)) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
            return {};
        }
        if (command.constructor.name === 'ListObjectsV2Command') {
            const prefix = input.Prefix as string;
            const keys = Array.from(this.objects.keys()).filter((candidate) => candidate.startsWith(prefix));
            return { Contents: keys.map((candidate) => ({ Key: candidate })), IsTruncated: false };
        }
        if (command.constructor.name === 'DeleteObjectsCommand') {
            const objectsToDelete = (input.Delete?.Objects ?? []) as Array<{ Key?: string }>;
            for (const obj of objectsToDelete) {
                if (obj.Key) this.objects.delete(obj.Key);
            }
            return {};
        }
        throw new Error(`Unhandled command ${command.constructor.name}`);
    }
}

/** A multimodal embedding whose calls always fail — used to simulate a network error mid-write. */
class ThrowingEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'Throwing'; }
    isMultimodal(): boolean { return true; }
    async embed(): Promise<EmbeddingVector> { throw new Error('embedding backend unavailable'); }
    async embedBatch(): Promise<EmbeddingVector[]> { throw new Error('embedding backend unavailable'); }
    async embedContentBatch(): Promise<EmbeddingVector[]> { throw new Error('embedding backend unavailable'); }
}

describe('MemoryStore (attachments)', () => {
    let dbDir: string;
    let blobDir: string;
    let store: MemoryStore;

    const png = (s: string) => ({ mimeType: 'image/png', data: Buffer.from(s).toString('base64') });

    beforeEach(async () => {
        dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-mm-db-'));
        blobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-mm-blob-'));
        const db = new LanceDBVectorDatabase({ uri: dbDir });
        store = new MemoryStore({
            embedding: new FakeMultimodalEmbedding(),
            vectorDatabase: db,
            blobStore: new FileBlobStore(blobDir),
        });
    });

    afterEach(async () => {
        await fs.rm(dbDir, { recursive: true, force: true });
        await fs.rm(blobDir, { recursive: true, force: true });
    });

    it('saves a memory with an image attachment and returns its metadata', async () => {
        const mem = await store.save({
            content: 'design mock',
            attachments: [{ ...png('PNGDATA'), caption: 'login screen' }],
        });
        expect(mem.attachments).toHaveLength(1);
        expect(mem.attachments[0].kind).toBe('image');
        expect(mem.attachments[0].mimeType).toBe('image/png');
        expect(mem.attachments[0].byteLength).toBe(Buffer.from('PNGDATA').length);
        expect(mem.attachments[0].caption).toBe('login screen');

        const fetched = await store.get(mem.id);
        expect(fetched!.attachments).toHaveLength(1);
        expect(fetched!.content).toBe('design mock');
    });

    it('saves a media-only memory (no text content)', async () => {
        const mem = await store.save({ attachments: [png('AAAA')] });
        expect(mem.content).toBe('');
        expect(mem.attachments).toHaveLength(1);
        expect(mem.title).toBe('image attachment');

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].preview).toContain('📎');
        expect(list[0].attachments).toHaveLength(1);
    });

    it('reads attachment bytes back via readAttachment', async () => {
        const mem = await store.save({ content: 'x', attachments: [png('HELLO')] });
        const blob = await store.readAttachment(mem.id, mem.attachments[0].id);
        expect(blob).not.toBeNull();
        expect(blob!.mimeType).toBe('image/png');
        expect(blob!.data.toString()).toBe('HELLO');
        expect(await store.readAttachment(mem.id, 'no-such-att')).toBeNull();
    });

    it('rejects attachments when the embedding is not multimodal', async () => {
        const db = new LanceDBVectorDatabase({ uri: dbDir });
        const textStore = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            blobStore: new FileBlobStore(blobDir),
        });
        await expect(textStore.save({ content: 'x', attachments: [png('Q')] })).rejects.toThrow(/multimodal/i);
    });

    it('deletes attachment blobs along with the memory', async () => {
        const mem = await store.save({ attachments: [png('BYTES')] });
        const attId = mem.attachments[0].id;
        expect(await store.readAttachment(mem.id, attId)).not.toBeNull();
        await store.delete(mem.id);
        expect(await store.get(mem.id)).toBeNull();
        expect(await store.readAttachment(mem.id, attId)).toBeNull();
    });

    it('preserves attachments on update when omitted, replaces when provided', async () => {
        const mem = await store.save({ content: 'orig', attachments: [png('one')] });

        const kept = await store.update(mem.id, { content: 'updated text' });
        expect(kept.content).toBe('updated text');
        expect(kept.attachments).toHaveLength(1);
        const keptBlob = await store.readAttachment(mem.id, kept.attachments[0].id);
        expect(keptBlob!.data.toString()).toBe('one');

        const cleared = await store.update(mem.id, { content: 'no media now', attachments: [] });
        expect(cleared.attachments).toHaveLength(0);
    });

    it('round-trips attachments through export and import', async () => {
        const mem = await store.save({
            content: 'spec doc',
            attachments: [{ ...png('PDFISH'), caption: 'spec' }],
        });
        const records = await store.exportAll();
        expect(records[0].attachments).toHaveLength(1);

        await store.delete(mem.id);
        expect(await store.get(mem.id)).toBeNull();

        await store.importRecords(records);
        const restored = await store.get(mem.id);
        expect(restored!.attachments).toHaveLength(1);
        expect(restored!.attachments[0].caption).toBe('spec');
        const blob = await store.readAttachment(mem.id, restored!.attachments[0].id);
        expect(blob!.data.toString()).toBe('PDFISH');
    });



    it('round-trips attachment import/export through an S3-compatible blob store', async () => {
        const s3Client = new FakeS3Client();
        const s3DbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-s3-db-'));
        try {
            const s3Store = new MemoryStore({
                embedding: new FakeMultimodalEmbedding(),
                vectorDatabase: new LanceDBVectorDatabase({ uri: s3DbDir }),
                blobStore: new S3BlobStore({ bucket: 'gemdex-test', prefix: 'blobs', client: s3Client }),
            });
            const mem = await s3Store.save({
                content: 's3 spec doc',
                attachments: [{ ...png('S3PDFISH'), caption: 's3 spec' }],
            });
            expect(s3Client.objects.has(`blobs/${mem.id}/0`)).toBe(true);

            const records = await s3Store.exportAll();
            await s3Store.delete(mem.id);
            expect(s3Client.objects.has(`blobs/${mem.id}/0`)).toBe(false);

            await s3Store.importRecords(records);
            const restored = await s3Store.get(mem.id);
            expect(restored!.attachments).toHaveLength(1);
            const blob = await s3Store.readAttachment(mem.id, restored!.attachments[0].id);
            expect(blob!.data.toString()).toBe('S3PDFISH');
        } finally {
            await fs.rm(s3DbDir, { recursive: true, force: true });
        }
    });

    it('recall returns attachment metadata on a matching memory', async () => {
        const mem = await store.save({
            content: 'kubernetes architecture diagram and rollout notes',
            attachments: [png('IMG')],
        });
        const results = await store.recall('kubernetes architecture diagram', 5);
        const hit = results.find((r) => r.id === mem.id);
        expect(hit).toBeDefined();
        expect(hit!.attachments).toHaveLength(1);
    });

    it('recalls by media alone (query attachment, no text)', async () => {
        // The fake multimodal embedding seeds its vector on mimeType+base64, so
        // the same bytes embed to the same vector — a media-only query finds it.
        const bytes = png('UNIQUE-DIAGRAM-BYTES');
        const mem = await store.save({ content: 'rollout notes', attachments: [bytes] });
        const results = await store.recall(undefined, 5, [bytes]);
        const hit = results.find((r) => r.id === mem.id);
        expect(hit).toBeDefined();
        expect(hit!.attachments).toHaveLength(1);
    });

    it('recalls by text + media, fusing both branches', async () => {
        const bytes = png('FUSION-IMAGE');
        const mem = await store.save({
            content: 'deployment runbook for the gateway service',
            attachments: [bytes],
        });
        const results = await store.recall('deployment runbook', 5, [bytes]);
        const hit = results.find((r) => r.id === mem.id);
        expect(hit).toBeDefined();
        expect(hit!.score).toBeGreaterThan(0);
    });

    it('rejects recall-by-media on a non-multimodal embedding model', async () => {
        const textOnly = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: new LanceDBVectorDatabase({ uri: dbDir }),
            blobStore: new FileBlobStore(blobDir),
        });
        await expect(textOnly.recall(undefined, 5, [png('X')])).rejects.toThrow(/multimodal/i);
    });

    it('preserves the existing memory when a re-embed fails mid-update', async () => {
        const mem = await store.save({ content: 'original text', attachments: [{ ...png('keepbytes'), caption: 'keep' }] });

        // A second store over the SAME db + blobs whose embedding always throws,
        // simulating a network failure during the update's re-embed step.
        const failing = new MemoryStore({
            embedding: new ThrowingEmbedding(),
            vectorDatabase: new LanceDBVectorDatabase({ uri: dbDir }),
            blobStore: new FileBlobStore(blobDir),
        });
        await expect(failing.update(mem.id, { content: 'replacement text' })).rejects.toThrow(/embedding backend/i);

        // The original memory and its attachment bytes must survive the failed update.
        const after = await store.get(mem.id);
        expect(after).not.toBeNull();
        expect(after!.content).toBe('original text');
        expect(after!.attachments).toHaveLength(1);
        const blob = await store.readAttachment(mem.id, after!.attachments[0].id);
        expect(blob!.data.toString()).toBe('keepbytes');
    });

    it('updateAttachmentCaptions changes a caption without re-embedding the media', async () => {
        const counting = new CountingMultimodalEmbedding();
        const captionStore = new MemoryStore({
            embedding: counting,
            vectorDatabase: new LanceDBVectorDatabase({ uri: dbDir }),
            blobStore: new FileBlobStore(blobDir),
        });
        const mem = await captionStore.save({
            content: 'design mock',
            attachments: [{ ...png('PNGDATA'), caption: 'old caption' }],
        });
        const attId = mem.attachments[0].id;

        // Capture the stored attachment vector before the caption edit.
        const before = await captionStore.recall(undefined, 1, [png('PNGDATA')]);
        const callsAfterSave = counting.embedCalls;
        expect(callsAfterSave).toBeGreaterThan(0);

        await new Promise((r) => setTimeout(r, 5));
        const updated = await captionStore.updateAttachmentCaptions(mem.id, [
            { id: attId, caption: 'new caption' },
        ]);

        // The caption path must not invoke the embedding model at all.
        expect(counting.embedCalls).toBe(callsAfterSave);
        expect(updated.attachments[0].caption).toBe('new caption');
        expect(updated.updatedAt).toBeGreaterThan(mem.updatedAt);
        expect(updated.createdAt).toBe(mem.createdAt);

        const fetched = await captionStore.get(mem.id);
        expect(fetched!.attachments[0].caption).toBe('new caption');
        expect(fetched!.updatedAt).toBe(updated.updatedAt);

        // The media vector is reused unchanged: recall-by-media still resolves
        // to the same memory with the same bytes.
        const after = await captionStore.recall(undefined, 1, [png('PNGDATA')]);
        expect(after[0].id).toBe(mem.id);
        expect(before[0].id).toBe(mem.id);
    });

    it('updateAttachmentCaptions clearing a caption falls back to the title for BM25', async () => {
        const mem = await store.save({
            content: '',
            title: 'Architecture diagram',
            attachments: [{ ...png('DIAGRAM'), caption: 'old' }],
        });
        const attId = mem.attachments[0].id;

        const cleared = await store.updateAttachmentCaptions(mem.id, [{ id: attId, caption: '   ' }]);
        expect(cleared.attachments[0].caption).toBeUndefined();

        const fetched = await store.get(mem.id);
        expect(fetched!.attachments[0].caption).toBeUndefined();

        // BM25 text for the attachment row falls back to the title, so a text
        // recall on the title still finds the memory.
        const results = await store.recall('Architecture diagram', 5);
        expect(results.some((r) => r.id === mem.id)).toBe(true);
    });

    it('updateAttachmentCaptions throws for an unknown attachment id', async () => {
        const mem = await store.save({ content: 'x', attachments: [png('Z')] });
        await expect(
            store.updateAttachmentCaptions(mem.id, [{ id: 'no-such-att', caption: 'nope' }]),
        ).rejects.toThrow(/not found/i);
    });

    it('updateAttachmentCaptions throws for an unknown memory id', async () => {
        await expect(
            store.updateAttachmentCaptions('does-not-exist', [{ id: '0', caption: 'x' }]),
        ).rejects.toThrow(/not found/i);
    });
});

/** Counts embedding calls so a test can prove detection costs zero extras. */
class CountingEmbedding extends FakeEmbedding {
    embedCalls = 0;
    async embed(text: string): Promise<EmbeddingVector> {
        this.embedCalls += 1;
        return super.embed(text);
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.embedCalls += 1;
        return super.embedBatch(texts);
    }
}

describe('MemoryStore (save-time similar-memory detection)', () => {
    let tmpDir: string;
    let store: MemoryStore;
    const ENV_KEYS = ['GEMDEX_SIMILAR_ON_SAVE', 'GEMDEX_SIMILAR_THRESHOLD'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(async () => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-similar-test-'));
        const db = new LanceDBVectorDatabase({ uri: tmpDir });
        store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });
    });

    afterEach(async () => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    const NOTARIZE_A = 'Notarize builds with the gemdex signing identity and the xcrun notarytool submit command';
    const NOTARIZE_B = 'Notarize builds with the gemdex signing identity and the xcrun notarytool submit tool';
    const UNRELATED = 'The quick brown fox jumps over the lazy dog in the meadow near the river';

    it('the first save into an empty store has no similar candidates', async () => {
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.similar).toBeUndefined();
    });

    it('a near-identical save surfaces the earlier memory as similar (>= 0.90)', async () => {
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const b = await store.save({ content: NOTARIZE_B, title: 'Notarization B' });

        expect(b.similar).toBeDefined();
        expect(b.similar).toHaveLength(1);
        expect(b.similar![0].id).toBe(a.id);
        expect(b.similar![0].title).toBe('Notarization A');
        expect(b.similar![0].similarity).toBeGreaterThanOrEqual(0.90);
        expect(b.similar![0].updatedAt).toBe(a.updatedAt);
    });

    it('distinct content has no similar candidates', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const c = await store.save({ content: UNRELATED, title: 'Unrelated' });
        expect(c.similar).toBeUndefined();
    });

    it('GEMDEX_SIMILAR_ON_SAVE=false disables detection entirely', async () => {
        process.env.GEMDEX_SIMILAR_ON_SAVE = 'false';
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const b = await store.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.similar).toBeUndefined();
    });

    it('GEMDEX_SIMILAR_THRESHOLD loosens the match bar', async () => {
        process.env.GEMDEX_SIMILAR_THRESHOLD = '0.3';
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        // UNRELATED does not clear the default 0.90 bar, but does clear 0.3.
        const c = await store.save({ content: UNRELATED, title: 'Unrelated' });
        expect(c.similar).toBeDefined();
        expect(c.similar![0].id).toBe(a.id);
        expect(c.similar![0].similarity).toBeLessThan(0.90);
    });

    it('an invalid GEMDEX_SIMILAR_THRESHOLD fails fast with a clear error, but never breaks the save', async () => {
        process.env.GEMDEX_SIMILAR_THRESHOLD = 'not-a-number';
        // The save itself must still succeed — detection failure is advisory-only.
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.id).toBeTruthy();
        expect(a.similar).toBeUndefined();
    });

    it('a threshold outside (0, 1] is rejected the same way (never breaks the save)', async () => {
        process.env.GEMDEX_SIMILAR_THRESHOLD = '1.5';
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.id).toBeTruthy();
        expect(a.similar).toBeUndefined();
    });

    it('a db.search failure during detection never fails the save', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });

        // A second store over the SAME on-disk db whose `search` (the
        // detection step's ANN query) always throws, simulating a local
        // failure mid-detection. writeMemory's own collection plumbing
        // (query/insert/hasCollection) is untouched.
        const db = new LanceDBVectorDatabase({ uri: tmpDir });
        let searchCallCount = 0;
        db.search = async () => {
            searchCallCount += 1;
            throw new Error('simulated ANN failure');
        };
        const failingStore = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });

        const b = await failingStore.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.id).toBeTruthy();
        expect(b.similar).toBeUndefined();
        expect(searchCallCount).toBeGreaterThan(0);
    });

    it('costs zero extra embedding calls (reuses the vectors save already computed)', async () => {
        const counting = new CountingEmbedding();
        const db = new LanceDBVectorDatabase({ uri: tmpDir });
        const countingStore = new MemoryStore({ embedding: counting, vectorDatabase: db });

        await countingStore.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const callsAfterFirstSave = counting.embedCalls;
        expect(callsAfterFirstSave).toBeGreaterThan(0);

        // The second save embeds its OWN content once (via embedBatch for its
        // chunk(s)) and detection must add nothing on top of that.
        await countingStore.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(counting.embedCalls).toBe(callsAfterFirstSave + 1);
    });

    it('update never reports similar candidates (detection is save-only)', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const b = await store.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.similar).toBeDefined();

        // Updating B to be even MORE similar to A must not gain a `similar`
        // field — update() returns a plain Memory, which has no such field.
        const updated = await store.update(b.id, { content: NOTARIZE_A });
        expect((updated as { similar?: unknown }).similar).toBeUndefined();
    });

    it('importRecords never reports similar candidates (detection is save-only)', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const { imported } = await store.importRecords([
            {
                id: 'imported-near-dup',
                title: 'Imported near-dup',
                content: NOTARIZE_B,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]);
        expect(imported).toBe(1);
        // importRecords' return type has no `similar` field at all — the type
        // system already enforces this; this test documents the behavior.
    });

    it('a saved memory never reports itself as similar to itself', async () => {
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.similar).toBeUndefined();
    });
});
