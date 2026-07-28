import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    BlobStore,
    chunkMemory,
    DEFAULT_ATTACHMENT_LIMITS,
    deriveTitle,
    Embedding,
    ImportRecordError,
    ImportRecordsResult,
    Memory,
    MemoryAttachment,
    MemoryAttachmentInput,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    SaveMemoryInput,
    UpdateMemoryInput,
    validateAttachments,
} from 'gemdex-core';
import { MIGRATIONS, SqlMigration } from './postgres-migrations.js';

export interface Queryable {
    query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DatabasePool extends Queryable {
    connect(): Promise<DatabaseClient>;
    end(): Promise<void>;
}

export interface DatabaseClient extends Queryable {
    release(): void;
}

export interface PostgresMemoryBackendOptions {
    pool: DatabasePool;
    blobStore?: BlobStore;
    blobStorageProvider?: string;
    embedding?: Embedding;
    /** pg-mem cannot parse pgvector's <=> operator; tests opt into the fallback. */
    usePgVectorQueries?: boolean;
}

interface DocumentRow extends QueryResultRow {
    id: string;
    title: string;
    content: string;
    created_at: Date | string | number;
    updated_at: Date | string | number;
}

interface AttachmentRow extends QueryResultRow {
    id: string;
    kind: MemoryAttachment['kind'];
    mime_type: string;
    byte_length: number;
    caption: string | null;
}

interface AttachmentExportRow extends AttachmentRow {
    storage_key: string;
    data: Buffer | Uint8Array | string | null;
}

interface StoredAttachmentInput extends MemoryAttachmentInput {
    id?: string;
}

interface PreparedAttachment {
    id: string;
    ordinal: number;
    kind: MemoryAttachment['kind'];
    mimeType: string;
    byteLength: number;
    data: Buffer;
    caption?: string;
}

interface RecallChunkRow extends QueryResultRow {
    id: string;
    memory_id: string;
    content?: string;
    embedding_vector?: string | number[] | null;
}

interface RankedChunk {
    id: string;
    memoryId: string;
}

export class MigrationError extends Error {
    constructor(public readonly version: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Migration ${version} failed: ${detail}`);
        this.name = 'MigrationError';
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

function checksum(sql: string): string {
    return createHash('sha256').update(sql).digest('hex');
}

export async function migrateDatabase(pool: DatabasePool, migrations: SqlMigration[] = MIGRATIONS): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
CREATE TABLE IF NOT EXISTS gemdex_schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

        for (const migration of migrations) {
            const sum = checksum(migration.sql);
            const existing = await client.query<{ checksum: string }>(
                'SELECT checksum FROM gemdex_schema_migrations WHERE version = $1',
                [migration.version],
            );
            if (existing.rows.length > 0) {
                if (existing.rows[0].checksum !== sum) {
                    throw new Error(
                        `Migration ${migration.version} checksum mismatch. ` +
                        'Refusing to continue; restore from backup or reconcile migration history.',
                    );
                }
                continue;
            }

            try {
                await client.query(migration.sql);
                await client.query(
                    'INSERT INTO gemdex_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
                    [migration.version, migration.name, sum],
                );
            } catch (error) {
                throw new MigrationError(migration.version, error);
            }
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export function createPostgresPool(config: PoolConfig | string): DatabasePool {
    return new Pool(typeof config === 'string' ? { connectionString: config } : config) as DatabasePool;
}

function timestampToMs(value: Date | string | number): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return new Date(value).getTime();
}

function toDate(ms: number): Date {
    return new Date(ms);
}

function bytesFromDatabase(value: Buffer | Uint8Array | string | null): Buffer {
    if (value === null) return Buffer.alloc(0);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
    return Buffer.from(value, 'base64');
}

function vectorLiteral(vector: number[]): string {
    return `[${vector.join(',')}]`;
}

function parseVector(value: string | number[] | null | undefined): number[] | null {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    return trimmed.slice(1, -1).split(',').map(Number);
}

function cosineSimilarity(left: number[], right: number[]): number {
    if (left.length !== right.length || left.length === 0) return -1;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let i = 0; i < left.length; i++) {
        dot += left[i] * right[i];
        leftNorm += left[i] * left[i];
        rightNorm += right[i] * right[i];
    }
    if (leftNorm === 0 || rightNorm === 0) return -1;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function lexicalScore(content: string, query: string): number {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (terms.length === 0) return 0;
    const haystack = content.toLowerCase();
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) / terms.length;
}

function fuseRanks(branches: RankedChunk[][], k = 100): Map<string, number> {
    const scores = new Map<string, number>();
    for (const branch of branches) {
        branch.forEach((chunk, index) => {
            scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (k + index + 1));
        });
    }
    return scores;
}

function toRankedChunks(rows: RecallChunkRow[]): RankedChunk[] {
    return rows.map((row) => ({ id: row.id, memoryId: row.memory_id }));
}

/** Order in-memory scored chunks by descending score, keep positives, cap at limit. */
function rankByScore(scored: Array<RankedChunk & { score: number }>, limit: number): RankedChunk[] {
    return scored
        .filter((chunk) => chunk.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ id, memoryId }) => ({ id, memoryId }));
}

/**
 * Build a comma-separated list of positional placeholders ($1, $2, ...) for an
 * `IN (...)` clause. We expand to scalar placeholders rather than `= ANY($1)`
 * with an array param: the array form is unsupported by the pg-mem engine used
 * in tests (it silently matches nothing), while expanded placeholders behave
 * identically on real Postgres and pg-mem.
 */
function inPlaceholders(count: number, start = 1): string {
    return Array.from({ length: count }, (_, index) => `$${start + index}`).join(', ');
}

function toMemoryAttachment(row: AttachmentRow): MemoryAttachment {
    return {
        id: row.id,
        kind: row.kind,
        mimeType: row.mime_type,
        byteLength: Number(row.byte_length),
        ...(row.caption ? { caption: row.caption } : {}),
    };
}

async function loadAttachments(db: Queryable, memoryId: string): Promise<MemoryAttachment[]> {
    const result = await db.query<AttachmentRow>(
        `SELECT id, kind, mime_type, byte_length, caption
         FROM gemdex_memory_attachments
         WHERE memory_id = $1
         ORDER BY ordinal ASC`,
        [memoryId],
    );
    return result.rows.map(toMemoryAttachment);
}

function attachmentTitle(attachments: PreparedAttachment[]): string {
    const captioned = attachments.find((a) => a.caption && a.caption.trim().length > 0);
    if (captioned?.caption) return deriveTitle(captioned.caption);
    if (attachments.length === 1) return `${attachments[0].kind} attachment`;
    return `${attachments.length} attachments`;
}

function resolveTitle(explicit: string | undefined, content: string, attachments: PreparedAttachment[]): string {
    const trimmed = explicit?.trim();
    if (trimmed) return trimmed;
    if (content.trim().length > 0) return deriveTitle(content);
    if (attachments.length > 0) return attachmentTitle(attachments);
    return deriveTitle(content);
}

export class PostgresMemoryBackend implements MemoryBackend {
    private pool: DatabasePool;
    private blobStore?: BlobStore;
    private blobStorageProvider: string;
    private embedding?: Embedding;
    private usePgVectorQueries: boolean;

    constructor(options: PostgresMemoryBackendOptions) {
        this.pool = options.pool;
        this.blobStore = options.blobStore;
        this.blobStorageProvider = options.blobStorageProvider ?? 'external';
        this.embedding = options.embedding;
        this.usePgVectorQueries = options.usePgVectorQueries ?? true;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    /**
     * Delete a memory document and the attachment blob rows it owned. The
     * documents/attachments cascade handles attachment + chunk rows, but blob
     * rows are RESTRICT-protected, so they must be removed explicitly once no
     * attachment references them.
     */
    private async deleteDocumentAndBlobs(client: DatabaseClient, id: string): Promise<void> {
        const oldBlobs = await client.query<{ blob_ref_id: string }>(
            'SELECT blob_ref_id FROM gemdex_memory_attachments WHERE memory_id = $1',
            [id],
        );
        await client.query('DELETE FROM gemdex_memory_documents WHERE id = $1', [id]);
        if (oldBlobs.rows.length > 0) {
            const blobIds = oldBlobs.rows.map((oldBlob) => oldBlob.blob_ref_id);
            await client.query(`DELETE FROM gemdex_attachment_blobs WHERE id IN (${inPlaceholders(blobIds.length)})`, blobIds);
        }
    }

    async save(input: SaveMemoryInput): Promise<Memory> {
        const id = randomUUID();
        const now = Date.now();
        return this.writeMemory(id, input.content ?? '', input.title, input.attachments ?? [], now, now);
    }

    async recall(
        query?: string,
        limit?: number,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        const trimmed = (query ?? '').trim();
        const attachments = queryAttachments ?? [];
        if (trimmed.length === 0 && attachments.length === 0) return [];
        const max = Math.max(1, Math.min(limit ?? 10, 50));
        const chunkLimit = Math.max(max * 4, 20);
        const branches: RankedChunk[][] = [];

        if (trimmed.length > 0) {
            if (this.embedding) {
                const vector = await this.embedding.embed(trimmed);
                branches.push(await this.denseRank(vector.vector, chunkLimit));
            }
            branches.push(await this.fullTextRank(trimmed, chunkLimit));
        }

        if (attachments.length > 0) {
            if (!this.embedding) {
                throw new Error('Recall-by-media requires a configured server embedding provider.');
            }
            if (!this.embedding.isMultimodal()) {
                throw new Error('Recall-by-media requires a multimodal server embedding provider.');
            }
            const validated = await validateAttachments(attachments, DEFAULT_ATTACHMENT_LIMITS);
            const vectors = await this.embedding.embedContentBatch(validated.map((attachment) => ({
                inlineData: {
                    mimeType: attachment.mimeType,
                    data: attachment.bytes.toString('base64'),
                },
            })));
            for (const vector of vectors) {
                branches.push(await this.denseRank(vector.vector, chunkLimit));
            }
        }

        const fused = fuseRanks(branches);
        const parentScores = new Map<string, number>();
        for (const branch of branches) {
            for (const chunk of branch) {
                const score = fused.get(chunk.id) ?? 0;
                if (score > (parentScores.get(chunk.memoryId) ?? 0)) {
                    parentScores.set(chunk.memoryId, score);
                }
            }
        }
        const rankedParents = Array.from(parentScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, max);
        if (rankedParents.length === 0) return [];
        const ids = rankedParents.map(([id]) => id);
        const rows = await this.pool.query<DocumentRow>(
            `SELECT id, title, content, created_at, updated_at
             FROM gemdex_memory_documents
             WHERE id IN (${inPlaceholders(ids.length)})`,
            ids,
        );
        const memories = await this.rowsToMemories(rows.rows);
        const byId = new Map(memories.map((memory) => [memory.id, memory]));
        return rankedParents.flatMap(([id, score]) => {
            const memory = byId.get(id);
            return memory ? [{ ...memory, score }] : [];
        });
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = await this.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        const content = input.content ?? existing.content;
        const title = input.title ?? existing.title;
        const attachments = input.attachments !== undefined
            ? input.attachments
            : await this.exportAttachmentsAsInputs(id);
        return this.writeMemory(id, content, title, attachments, existing.createdAt, Date.now());
    }

    async updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const exists = await client.query('SELECT id FROM gemdex_memory_documents WHERE id = $1', [id]);
            if (exists.rows.length === 0) throw new Error(`Memory ${id} not found`);

            for (const item of captions) {
                const caption = item.caption?.trim();
                const updated = await client.query(
                    `UPDATE gemdex_memory_attachments
                     SET caption = $3, updated_at = $4
                     WHERE memory_id = $1 AND id = $2`,
                    [id, item.id, caption && caption.length > 0 ? caption : null, new Date()],
                );
                if (updated.rowCount === 0) throw new Error(`Attachment ${item.id} not found`);
            }

            await this.rebuildAttachmentChunks(client, id);
            await client.query('COMMIT');
            const memory = await this.get(id);
            if (!memory) throw new Error(`Memory ${id} not found`);
            return memory;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async get(id: string): Promise<Memory | null> {
        const result = await this.pool.query<DocumentRow>(
            'SELECT id, title, content, created_at, updated_at FROM gemdex_memory_documents WHERE id = $1',
            [id],
        );
        if (result.rows.length === 0) return null;
        return this.rowToMemory(result.rows[0]);
    }

    async list(): Promise<MemorySummary[]> {
        const result = await this.pool.query<DocumentRow>(
            `SELECT id, title, content, created_at, updated_at
             FROM gemdex_memory_documents
             ORDER BY updated_at DESC, id ASC`,
        );
        const memories = await this.rowsToMemories(result.rows);
        return memories.map((memory) => ({
            id: memory.id,
            title: memory.title,
            preview: memory.content.slice(0, 100),
            attachments: memory.attachments,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
        }));
    }

    async delete(id: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await this.deleteDocumentAndBlobs(client, id);
            await client.query('COMMIT');
            await this.blobStore?.deleteParent(id);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        const result = await this.pool.query<DocumentRow>(
            `SELECT id, title, content, created_at, updated_at
             FROM gemdex_memory_documents
             ORDER BY updated_at DESC, id ASC`,
        );
        return Promise.all(result.rows.map(async (row) => ({
            id: row.id,
            title: row.title,
            content: row.content,
            createdAt: timestampToMs(row.created_at),
            updatedAt: timestampToMs(row.updated_at),
            ...await this.exportAttachmentsRecord(row.id),
        })));
    }

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        let imported = 0;
        const errors: ImportRecordError[] = [];
        for (let index = 0; index < records.length; index++) {
            const record = records[index];
            const content = record.content ?? '';
            const attachments = Array.isArray(record.attachments)
                ? record.attachments.map((attachment) => ({
                    id: attachment.id,
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                    ...(attachment.caption !== undefined && { caption: attachment.caption }),
                }))
                : [];
            if (content.trim().length === 0 && attachments.length === 0) continue;
            // Per-record fault tolerance, mirroring MemoryStore.importRecords:
            // collect the failure and keep importing the remaining records.
            try {
                const id = record.id || randomUUID();
                await this.writeMemory(
                    id,
                    content,
                    record.title,
                    attachments,
                    Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
                    Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
                );
                imported += 1;
            } catch (error) {
                errors.push({
                    index,
                    ...(record.id && { id: record.id }),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return { imported, failed: errors.length, errors };
    }

    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const result = await this.pool.query<AttachmentExportRow>(
            `SELECT a.mime_type, a.byte_length, a.caption, b.storage_key, b.data
             FROM gemdex_memory_attachments a
             JOIN gemdex_attachment_blobs b ON b.id = a.blob_ref_id
             WHERE a.memory_id = $1 AND a.id = $2`,
            [memoryId, attachmentId],
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        return {
            mimeType: row.mime_type,
            byteLength: Number(row.byte_length),
            ...(row.caption ? { caption: row.caption } : {}),
            data: await this.readBlob(row),
        };
    }

    private async writeMemory(
        id: string,
        content: string,
        explicitTitle: string | undefined,
        attachmentsInput: StoredAttachmentInput[],
        createdAt: number,
        updatedAt: number,
    ): Promise<Memory> {
        const text = content ?? '';
        const validated = await validateAttachments(attachmentsInput, DEFAULT_ATTACHMENT_LIMITS);
        if (text.trim().length === 0 && validated.length === 0) {
            throw new Error('Cannot persist an empty memory (no content and no attachments)');
        }

        const prepared: PreparedAttachment[] = validated.map((attachment, index) => ({
            id: attachmentsInput[index].id ?? String(index),
            ordinal: index,
            kind: attachment.kind,
            mimeType: attachment.mimeType,
            byteLength: attachment.byteLength,
            data: attachment.bytes,
            ...(attachment.caption && { caption: attachment.caption }),
        }));
        const title = resolveTitle(explicitTitle, text, prepared);
        const chunks = text.trim().length > 0 ? chunkMemory(text) : [];
        const textEmbeddings = this.embedding && chunks.length > 0
            ? await this.embedding.embedBatch(chunks)
            : [];
        const attachmentEmbeddings = this.embedding && prepared.length > 0
            ? await this.embedding.embedContentBatch(prepared.map((attachment) => ({
                inlineData: {
                    mimeType: attachment.mimeType,
                    data: attachment.data.toString('base64'),
                },
            })))
            : [];
        const client = await this.pool.connect();
        const externalRefs = new Map<string, string>();

        if (this.blobStore) {
            await this.blobStore.deleteParent(id);
            for (const attachment of prepared) {
                externalRefs.set(
                    attachment.id,
                    await this.blobStore.put(id, attachment.id, attachment.data),
                );
            }
        }

        try {
            await client.query('BEGIN');
            await this.deleteDocumentAndBlobs(client, id);
            await client.query(
                `INSERT INTO gemdex_memory_documents (id, title, content, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, title, text, toDate(createdAt), toDate(updatedAt)],
            );

            for (let i = 0; i < chunks.length; i++) {
                await client.query(
                    `INSERT INTO gemdex_memory_chunks
                        (id, memory_id, chunk_index, chunk_kind, content, start_offset, end_offset,
                         embedding_vector, created_at, updated_at)
                     VALUES ($1, $2, $3, 'text', $4, NULL, NULL, $5, $6, $7)`,
                    [
                        randomUUID(),
                        id,
                        i,
                        chunks[i],
                        textEmbeddings[i] ? vectorLiteral(textEmbeddings[i].vector) : null,
                        toDate(createdAt),
                        toDate(updatedAt),
                    ],
                );
            }

            for (const attachment of prepared) {
                const blobId = randomUUID();
                const storageKey = externalRefs.get(attachment.id) ?? `${id}/${attachment.id}`;
                const hash = createHash('sha256').update(attachment.data).digest('hex');
                await client.query(
                    `INSERT INTO gemdex_attachment_blobs
                        (id, storage_provider, storage_key, sha256, byte_length, data)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        blobId,
                        this.blobStore ? this.blobStorageProvider : 'postgres',
                        storageKey,
                        hash,
                        attachment.byteLength,
                        this.blobStore ? null : attachment.data,
                    ],
                );
                await client.query(
                    `INSERT INTO gemdex_memory_attachments
                        (memory_id, id, ordinal, kind, mime_type, byte_length, caption, blob_ref_id, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        id,
                        attachment.id,
                        attachment.ordinal,
                        attachment.kind,
                        attachment.mimeType,
                        attachment.byteLength,
                        attachment.caption ?? null,
                        blobId,
                        toDate(createdAt),
                        toDate(updatedAt),
                    ],
                );
            }
            await this.rebuildAttachmentChunks(client, id, attachmentEmbeddings.map((item) => item.vector));

            await client.query('COMMIT');
            const memory = await this.get(id);
            if (!memory) throw new Error(`Memory ${id} not found after write`);
            return memory;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async rebuildAttachmentChunks(
        db: Queryable,
        id: string,
        embeddings?: number[][],
    ): Promise<void> {
        const priorEmbeddings = embeddings === undefined
            ? await db.query<{ attachment_id: string; embedding_vector: string | number[] | null }>(
                `SELECT attachment_id, embedding_vector
                 FROM gemdex_memory_chunks
                 WHERE memory_id = $1 AND chunk_kind = 'attachment'`,
                [id],
            )
            : null;
        const priorByAttachment = new Map(
            priorEmbeddings?.rows.map((row) => [row.attachment_id, row.embedding_vector]) ?? [],
        );
        await db.query('DELETE FROM gemdex_memory_chunks WHERE memory_id = $1 AND chunk_kind = $2', [id, 'attachment']);
        const result = await db.query<AttachmentRow>(
            `SELECT id, kind, mime_type, byte_length, caption
             FROM gemdex_memory_attachments
             WHERE memory_id = $1
             ORDER BY ordinal ASC`,
            [id],
        );
        const doc = await db.query<DocumentRow>(
            'SELECT title, created_at, updated_at FROM gemdex_memory_documents WHERE id = $1',
            [id],
        );
        const title = doc.rows[0]?.title ?? '';
        const createdAt = doc.rows[0]?.created_at ?? new Date();
        const updatedAt = doc.rows[0]?.updated_at ?? new Date();
        for (let i = 0; i < result.rows.length; i++) {
            const attachment = result.rows[i];
            const text = attachment.caption?.trim() || title || `${attachment.kind} attachment`;
            await db.query(
                `INSERT INTO gemdex_memory_chunks
                    (id, memory_id, attachment_id, chunk_index, chunk_kind, content,
                     embedding_vector, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'attachment', $5, $6, $7, $8)`,
                [
                    randomUUID(),
                    id,
                    attachment.id,
                    i,
                    text,
                    embeddings?.[i] ? vectorLiteral(embeddings[i]) : priorByAttachment.get(attachment.id) ?? null,
                    createdAt,
                    updatedAt,
                ],
            );
        }
    }

    private async denseRank(vector: number[], limit: number): Promise<RankedChunk[]> {
        if (this.usePgVectorQueries) {
            const result = await this.pool.query<RecallChunkRow>(
                `SELECT id, memory_id
                 FROM gemdex_memory_chunks
                 WHERE embedding_vector IS NOT NULL
                   AND (embedding_vector <=> $1::vector) < 1
                 ORDER BY embedding_vector <=> $1::vector
                 LIMIT $2`,
                [vectorLiteral(vector), limit],
            );
            return toRankedChunks(result.rows);
        }
        const result = await this.pool.query<RecallChunkRow>(
            `SELECT id, memory_id, embedding_vector
             FROM gemdex_memory_chunks
             WHERE embedding_vector IS NOT NULL`,
        );
        return rankByScore(
            result.rows.map((row) => ({
                id: row.id,
                memoryId: row.memory_id,
                score: cosineSimilarity(parseVector(row.embedding_vector) ?? [], vector),
            })),
            limit,
        );
    }

    private async fullTextRank(query: string, limit: number): Promise<RankedChunk[]> {
        if (this.usePgVectorQueries) {
            const result = await this.pool.query<RecallChunkRow>(
                `SELECT id, memory_id
                 FROM gemdex_memory_chunks
                 WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
                 ORDER BY ts_rank_cd(
                    to_tsvector('english', content),
                    plainto_tsquery('english', $1)
                 ) DESC, id ASC
                 LIMIT $2`,
                [query, limit],
            );
            return toRankedChunks(result.rows);
        }
        const result = await this.pool.query<RecallChunkRow>(
            'SELECT id, memory_id, content FROM gemdex_memory_chunks',
        );
        return rankByScore(
            result.rows.map((row) => ({
                id: row.id,
                memoryId: row.memory_id,
                score: lexicalScore(row.content ?? '', query),
            })),
            limit,
        );
    }

    private async rowToMemory(row: DocumentRow): Promise<Memory> {
        return {
            id: row.id,
            title: row.title,
            content: row.content,
            attachments: await loadAttachments(this.pool, row.id),
            createdAt: timestampToMs(row.created_at),
            updatedAt: timestampToMs(row.updated_at),
        };
    }

    /**
     * Batch-load attachments for many documents in a single query, then map
     * each row to a Memory. Avoids the N+1 query pattern that arises when
     * list()/recall() call rowToMemory() (one attachment query per row) in a
     * loop.
     */
    private async rowsToMemories(rows: DocumentRow[]): Promise<Memory[]> {
        if (rows.length === 0) return [];
        const ids = rows.map((row) => row.id);
        const attachmentResult = await this.pool.query<AttachmentRow & { memory_id: string }>(
            `SELECT memory_id, id, kind, mime_type, byte_length, caption
             FROM gemdex_memory_attachments
             WHERE memory_id IN (${inPlaceholders(ids.length)})
             ORDER BY memory_id, ordinal ASC`,
            ids,
        );
        const attachmentsByMemoryId = new Map<string, MemoryAttachment[]>();
        for (const row of attachmentResult.rows) {
            const list = attachmentsByMemoryId.get(row.memory_id) ?? [];
            list.push(toMemoryAttachment(row));
            attachmentsByMemoryId.set(row.memory_id, list);
        }
        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            content: row.content,
            attachments: attachmentsByMemoryId.get(row.id) ?? [],
            createdAt: timestampToMs(row.created_at),
            updatedAt: timestampToMs(row.updated_at),
        }));
    }

    private async exportAttachmentRowToInput(row: AttachmentExportRow): Promise<StoredAttachmentInput> {
        return {
            id: row.id,
            mimeType: row.mime_type,
            data: (await this.readBlob(row)).toString('base64'),
            ...(row.caption ? { caption: row.caption } : {}),
        };
    }

    private async exportAttachmentsRecord(id: string): Promise<{ attachments?: MemoryExportRecord['attachments'] }> {
        const rows = await this.exportAttachmentRows(id);
        if (rows.length === 0) return {};
        return {
            attachments: await Promise.all(rows.map((row) => this.exportAttachmentRowToInput(row))),
        };
    }

    private async exportAttachmentsAsInputs(id: string): Promise<StoredAttachmentInput[]> {
        const rows = await this.exportAttachmentRows(id);
        return Promise.all(rows.map((row) => this.exportAttachmentRowToInput(row)));
    }

    private async exportAttachmentRows(id: string): Promise<AttachmentExportRow[]> {
        const result = await this.pool.query<AttachmentExportRow>(
            `SELECT a.id, a.kind, a.mime_type, a.byte_length, a.caption, b.storage_key, b.data
             FROM gemdex_memory_attachments a
             JOIN gemdex_attachment_blobs b ON b.id = a.blob_ref_id
             WHERE a.memory_id = $1
             ORDER BY a.ordinal ASC`,
            [id],
        );
        return result.rows;
    }

    private async readBlob(row: AttachmentExportRow): Promise<Buffer> {
        if (row.data !== null) return bytesFromDatabase(row.data);
        if (!this.blobStore) {
            throw new Error(`Attachment blob ${row.storage_key} is external but no blob store is configured`);
        }
        return this.blobStore.get(row.storage_key);
    }
}
