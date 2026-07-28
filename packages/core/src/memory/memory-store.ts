import * as crypto from 'crypto';
import { Embedding, EmbeddingVector } from '../embedding';
import {
    VectorDatabase,
    VectorDocument,
    HybridSearchRequest,
    HybridSearchResult,
} from '../vectordb';
import { envManager } from '../utils/env-manager';
import { DEFAULT_HYGIENE_THRESHOLD, normalizedCentroid, cosine } from '../utils/centroid';
import { chunkMemory, deriveTitle, ChunkOptions } from './chunker';
import { BlobStore, FileBlobStore } from './blob-store';
import {
    AttachmentLimits,
    DEFAULT_ATTACHMENT_LIMITS,
    ValidatedAttachment,
    mimeToKind,
    validateAttachments,
} from './attachment-validator';
import {
    AttachmentKind,
    AttachmentCaptionUpdate,
    ImportRecordError,
    ImportRecordsResult,
    Memory,
    MemoryAttachment,
    MemoryAttachmentInput,
    MemorySummary,
    MemoryRecallResult,
    SaveMemoryInput,
    SaveResult,
    SimilarMemoryRef,
    UpdateMemoryInput,
    MemoryExportRecord,
    MemoryExportAttachment,
    AttachmentBytes,
} from './types';
export type { AttachmentBytes } from './types';

const DEFAULT_COLLECTION = 'memories';
const DEFAULT_PREVIEW_LENGTH = 200;
const LIST_FETCH_LIMIT = 100000;
/** Reciprocal Rank Fusion constant, shared by the hybrid text path and the
 *  cross-branch fusion used by recall-by-media. */
const RECALL_RRF_K = 100;
/**
 * Save-time similar-memory detection: how many ANN candidates to pull for
 * discovery (cheap, approximate — only used to shortlist parent ids) and how
 * many of those candidates get an exact centroid-vs-centroid rescoring (the
 * one authoritative "similarity" number reported back to the caller).
 */
const SIMILAR_ANN_CANDIDATES = 20;
const SIMILAR_MAX_RESCORED = 8;
const SIMILAR_MAX_RESULTS = 3;

/**
 * Internal mapping between the memory model and the generic hybrid vector
 * store. Each retrieval chunk OR attachment is one stored row. The generic
 * store's columns are reused as typed, filterable storage slots:
 *
 *   id            -> `${parentId}::${chunkIndex}`        (text chunk row)
 *                 -> `${parentId}::att::${attachIndex}`  (attachment row)
 *   vector        -> chunk text embedding | attachment media embedding
 *   content       -> chunk text | attachment caption/title (the BM25 target)
 *   relativePath  -> parentId        (filterable: get / list / delete grouping)
 *   startLine     -> chunk/attachment index
 *   endLine       -> chunk/attachment count
 *   fileExtension -> "" (unused)
 *   metadata.json -> { title, fullContent, createdAt, updatedAt, attachments }
 *
 * Recall ranks chunks/attachments then resolves + dedupes back to whole parent
 * memories, so the caller never receives a fragment (the "parent document
 * retriever" pattern). Media is one embedding unit — attachments bypass text
 * chunking (one row per attachment); only their caption/title feeds BM25.
 */
interface StoredAttachment {
    /** Stable within the parent memory (the attachment's index as a string). */
    id: string;
    kind: AttachmentKind;
    mimeType: string;
    byteLength: number;
    caption?: string;
    /** Opaque ref into the BlobStore where the raw bytes live. */
    blobRef: string;
}

interface ParentMeta {
    title: string;
    fullContent: string;
    createdAt: number;
    updatedAt: number;
    attachments: StoredAttachment[];
}

/**
 * One parent memory with every stored row vector it owns (text chunks +
 * attachments). Used by the hygiene feature to cluster similar memories
 * from the vectors already in LanceDB, without any embedding API calls.
 */
export interface ParentVectorData {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    fullContent: string;
    /** All row vectors for this parent (chunks + attachments). */
    vectors: number[][];
}

export interface MemoryStoreConfig {
    embedding: Embedding;
    vectorDatabase: VectorDatabase;
    /** Override the single global table name. Defaults to `memories`. */
    collectionName?: string;
    /** Chunking parameters; sensible defaults applied when omitted. */
    chunkOptions?: ChunkOptions;
    /** Where attachment bytes are stored. Defaults to `~/.gemdex/blobs`. */
    blobStore?: BlobStore;
    /** Per-modality attachment limits. Defaults applied when omitted. */
    attachmentLimits?: AttachmentLimits;
}

export class MemoryStore {
    private embedding: Embedding;
    private db: VectorDatabase;
    private collectionName: string;
    private chunkOptions: ChunkOptions;
    private blobStore: BlobStore;
    private attachmentLimits: AttachmentLimits;
    private collectionReady?: Promise<void>;

    constructor(config: MemoryStoreConfig) {
        this.embedding = config.embedding;
        this.db = config.vectorDatabase;
        this.collectionName = config.collectionName ?? DEFAULT_COLLECTION;
        this.chunkOptions = config.chunkOptions ?? {};
        this.blobStore = config.blobStore ?? new FileBlobStore();
        this.attachmentLimits = config.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
    }

    private getIsHybrid(): boolean {
        return (envManager.get('HYBRID_MODE') ?? 'true').toLowerCase() === 'true';
    }

    /** Ensure the single global collection exists (idempotent, deduped). */
    private async ensureCollection(): Promise<void> {
        if (!this.collectionReady) {
            this.collectionReady = (async () => {
                const dimension = this.embedding.getDimension();
                await this.db.createHybridCollection(this.collectionName, dimension, 'Gemdex memory layer');
            })();
        }
        return this.collectionReady;
    }

    private static newId(): string {
        return crypto.randomUUID();
    }

    private static chunkRowId(parentId: string, chunkIndex: number): string {
        return `${parentId}::${chunkIndex}`;
    }

    private static attachmentRowId(parentId: string, attachmentIndex: number): string {
        return `${parentId}::att::${attachmentIndex}`;
    }

    private static escapeLiteral(value: string): string {
        return value.replace(/'/g, "''");
    }

    private metaToRecord(meta: ParentMeta): Record<string, any> {
        return {
            title: meta.title,
            fullContent: meta.fullContent,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            attachments: meta.attachments,
        };
    }

    private buildChunkRows(
        parentId: string,
        chunks: string[],
        vectors: EmbeddingVector[],
        meta: ParentMeta,
    ): VectorDocument[] {
        const record = this.metaToRecord(meta);
        return chunks.map((chunk, index) => ({
            id: MemoryStore.chunkRowId(parentId, index),
            vector: vectors[index].vector,
            content: chunk,
            relativePath: parentId,
            startLine: index,
            endLine: chunks.length,
            fileExtension: '',
            metadata: record,
        }));
    }

    private buildAttachmentRows(
        parentId: string,
        stored: StoredAttachment[],
        vectors: EmbeddingVector[],
        meta: ParentMeta,
    ): VectorDocument[] {
        const record = this.metaToRecord(meta);
        return stored.map((att, index) => ({
            id: MemoryStore.attachmentRowId(parentId, index),
            vector: vectors[index].vector,
            // BM25 text for a media row is its caption, falling back to the title.
            content: att.caption ?? meta.title,
            relativePath: parentId,
            startLine: index,
            endLine: stored.length,
            fileExtension: '',
            metadata: record,
        }));
    }

    private async embedChunks(chunks: string[]): Promise<EmbeddingVector[]> {
        if (chunks.length === 0) return [];
        return this.embedding.embedContentBatch(chunks);
    }

    private async embedAttachments(attachments: ValidatedAttachment[]): Promise<EmbeddingVector[]> {
        if (attachments.length === 0) return [];
        return this.embedding.embedContentBatch(
            attachments.map((att) => ({
                inlineData: { mimeType: att.mimeType, data: att.bytes.toString('base64') },
            })),
        );
    }

    private rowToParentMeta(metadata: Record<string, any>): ParentMeta {
        const attachments = Array.isArray(metadata.attachments)
            ? metadata.attachments
                .map((raw: unknown) => MemoryStore.normalizeStoredAttachment(raw))
                .filter((a: StoredAttachment | null): a is StoredAttachment => a !== null)
            : [];
        return {
            title: typeof metadata.title === 'string' ? metadata.title : '',
            fullContent: typeof metadata.fullContent === 'string' ? metadata.fullContent : '',
            createdAt: Number(metadata.createdAt) || 0,
            updatedAt: Number(metadata.updatedAt) || 0,
            attachments,
        };
    }

    private static normalizeStoredAttachment(raw: unknown): StoredAttachment | null {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, any>;
        if (typeof r.blobRef !== 'string' || typeof r.mimeType !== 'string') return null;
        const kinds: AttachmentKind[] = ['image', 'audio', 'video', 'pdf'];
        const kind = kinds.includes(r.kind) ? (r.kind as AttachmentKind) : mimeToKind(r.mimeType);
        if (!kind) return null;
        const caption = typeof r.caption === 'string' && r.caption.length > 0 ? r.caption : undefined;
        return {
            id: typeof r.id === 'string' ? r.id : '0',
            kind,
            mimeType: r.mimeType,
            byteLength: Number(r.byteLength) || 0,
            ...(caption && { caption }),
            blobRef: r.blobRef,
        };
    }

    private static toPublicAttachments(stored: StoredAttachment[]): MemoryAttachment[] {
        return stored.map((a) => ({
            id: a.id,
            kind: a.kind,
            mimeType: a.mimeType,
            byteLength: a.byteLength,
            ...(a.caption && { caption: a.caption }),
        }));
    }

    private static resolveTitle(
        explicit: string | undefined,
        content: string,
        attachments: { kind: AttachmentKind; caption?: string }[],
    ): string {
        const trimmed = explicit?.trim();
        if (trimmed) return trimmed;
        if (content.trim().length > 0) return deriveTitle(content);
        // Media-only memory: derive from the first caption, else a kind summary.
        const captioned = attachments.find((a) => a.caption && a.caption.trim().length > 0);
        if (captioned?.caption) return deriveTitle(captioned.caption);
        if (attachments.length === 1) return `${attachments[0].kind} attachment`;
        if (attachments.length > 1) return `${attachments.length} attachments`;
        return deriveTitle(content);
    }

    /**
     * The single write path shared by save/update/import. Overwrites any rows +
     * blobs already under `id`, then persists the supplied text + attachments.
     * Throws if attachments are supplied to a non-multimodal embedding model, or
     * if the resulting memory would be completely empty.
     *
     * Also returns the vectors it just computed (`chunkVectors`,
     * `attachmentVectors`) so `save` can reuse them for similar-memory
     * detection with zero extra embedding calls; `update`/`importRecords`
     * simply ignore them.
     */
    private async writeMemory(
        id: string,
        content: string,
        explicitTitle: string | undefined,
        attachmentsInput: MemoryAttachmentInput[],
        createdAt: number,
        updatedAt: number,
    ): Promise<{ memory: Memory; chunkVectors: EmbeddingVector[]; attachmentVectors: EmbeddingVector[] }> {
        const text = content ?? '';
        const validated = attachmentsInput.length > 0
            ? await validateAttachments(attachmentsInput, this.attachmentLimits)
            : [];

        if (validated.length > 0 && !this.embedding.isMultimodal()) {
            throw new Error(
                'Attachments require a multimodal embedding model (e.g. gemini-embedding-2); ' +
                `the current ${this.embedding.getProvider()} model does not accept inline media.`,
            );
        }

        // Guard BEFORE any destructive work: an empty payload must never wipe an
        // existing memory on an update/import overwrite.
        if (text.trim().length === 0 && validated.length === 0) {
            throw new Error('Cannot persist an empty memory (no content and no attachments)');
        }

        await this.ensureCollection();
        const title = MemoryStore.resolveTitle(explicitTitle, text, validated);

        // Embed FIRST — this is the failure-prone (network) step. Computing the
        // vectors before deleting the prior rows/blobs means a failed
        // update/import leaves the existing memory intact instead of destroying
        // it. (Overwrite is still not fully atomic, but the failure window
        // shrinks to the local LanceDB insert.)
        const chunks = text.trim().length > 0 ? chunkMemory(text, this.chunkOptions) : [];
        const chunkVectors = await this.embedChunks(chunks);
        const attachmentVectors = await this.embedAttachments(validated);

        // Embedding succeeded — only now is it safe to clear prior state for this id.
        await this.deleteChunkRows(id);
        await this.blobStore.deleteParent(id);

        try {
            // Persist blob bytes so metadata can reference them.
            const stored: StoredAttachment[] = [];
            for (let i = 0; i < validated.length; i++) {
                const att = validated[i];
                const blobRef = await this.blobStore.put(id, String(i), att.bytes);
                stored.push({
                    id: String(i),
                    kind: att.kind,
                    mimeType: att.mimeType,
                    byteLength: att.byteLength,
                    ...(att.caption && { caption: att.caption }),
                    blobRef,
                });
            }

            const meta: ParentMeta = { title, fullContent: text, createdAt, updatedAt, attachments: stored };

            const rows = [
                ...this.buildChunkRows(id, chunks, chunkVectors, meta),
                ...this.buildAttachmentRows(id, stored, attachmentVectors, meta),
            ];

            await this.db.insertHybrid(this.collectionName, rows);

            return {
                memory: {
                    id,
                    title,
                    content: text,
                    attachments: MemoryStore.toPublicAttachments(stored),
                    createdAt,
                    updatedAt,
                },
                chunkVectors,
                attachmentVectors,
            };
        } catch (error) {
            // Don't leave orphan blobs behind if blob writes or the insert failed.
            await this.blobStore.deleteParent(id).catch(() => undefined);
            throw error;
        }
    }

    /**
     * Persist a new memory. Text is chunked + embedded; each attachment is one
     * media embedding stored as its own row with its bytes on disk. Returns the
     * created memory (including the resolved title + attachment metadata) plus
     * advisory `similar` candidates when save-time detection finds any.
     *
     * Detection runs AFTER the write succeeds (the saved memory itself is the
     * priority, and this keeps `writeMemory`'s shared save/update/import
     * semantics untouched) and is wrapped in try/catch: a detection failure of
     * any kind can never fail or delay-fail the save — see `findSimilarParents`.
     */
    async save(input: SaveMemoryInput): Promise<SaveResult> {
        const content = input.content ?? '';
        const attachmentsInput = input.attachments ?? [];
        if (content.trim().length === 0 && attachmentsInput.length === 0) {
            throw new Error('Cannot save an empty memory (provide content or at least one attachment)');
        }
        const id = MemoryStore.newId();
        const now = Date.now();
        const { memory, chunkVectors, attachmentVectors } =
            await this.writeMemory(id, content, input.title, attachmentsInput, now, now);

        let similar: SimilarMemoryRef[] = [];
        try {
            const newVectors = [...chunkVectors, ...attachmentVectors].map((v) => v.vector);
            similar = await this.findSimilarParents(newVectors, id);
        } catch (error) {
            // Advisory only — never let detection failure taint a successful save.
            console.error('[MemoryStore] Save-time similar-memory detection failed:', error);
        }

        return { ...memory, ...(similar.length > 0 && { similar }) };
    }

    /** Read the `GEMDEX_SIMILAR_THRESHOLD` override, validating it fails fast. */
    private static resolveSimilarThreshold(): number {
        const raw = envManager.get('GEMDEX_SIMILAR_THRESHOLD');
        if (raw === undefined) return DEFAULT_HYGIENE_THRESHOLD;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
            throw new Error(
                `Invalid GEMDEX_SIMILAR_THRESHOLD '${raw}': must be a number in (0, 1].`,
            );
        }
        return parsed;
    }

    /**
     * Save-time similar-memory/conflict detection. Reuses the vectors `save`
     * already computed for the new memory — zero extra embedding/network
     * calls, one local ANN query plus a handful of filtered reads. Semantics
     * intentionally match memory hygiene (`hygiene/candidate-finder.ts`):
     * centroid-vs-centroid cosine similarity over a memory's row vectors, at
     * the same default threshold (`DEFAULT_HYGIENE_THRESHOLD`) — one mental
     * model for "similar" across the product.
     *
     * Disabled entirely when `GEMDEX_SIMILAR_ON_SAVE` is `'false'` (on by
     * default — purely additive). Returns `[]` on an empty/nonexistent
     * collection or when the new memory has no vectors (e.g. import paths
     * never call this at all). `excludeId` drops the just-saved memory itself
     * out of its own candidate list.
     */
    private async findSimilarParents(
        newVectors: number[][],
        excludeId: string,
    ): Promise<SimilarMemoryRef[]> {
        const enabled = (envManager.get('GEMDEX_SIMILAR_ON_SAVE') ?? 'true').toLowerCase() !== 'false';
        if (!enabled || newVectors.length === 0) return [];

        const threshold = MemoryStore.resolveSimilarThreshold();

        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return [];

        const centroid = normalizedCentroid(newVectors);

        // Candidate discovery: the ANN score itself is only used to shortlist
        // parent ids, never as the reported similarity (metric-agnostic — the
        // exact score always comes from the centroid-vs-centroid rescoring below).
        const annHits = await this.db.search(this.collectionName, centroid, { topK: SIMILAR_ANN_CANDIDATES });
        const candidateIds: string[] = [];
        const seen = new Set<string>();
        for (const hit of annHits) {
            const parentId = hit.document.relativePath;
            if (!parentId || parentId === excludeId || seen.has(parentId)) continue;
            seen.add(parentId);
            candidateIds.push(parentId);
            if (candidateIds.length >= SIMILAR_MAX_RESCORED) break;
        }
        if (candidateIds.length === 0) return [];

        // Exact scoring: rebuild each candidate's own centroid from ALL of its
        // row vectors (reusing the row-reading/vector-coercion pattern from
        // `listParentsWithVectors`/`updateAttachmentCaptions`) and compare.
        // Candidates are independent reads, so run them concurrently
        // (≤ `SIMILAR_MAX_RESCORED` at once) to keep the save path fast.
        const scored = await Promise.all(candidateIds.map(async (parentId): Promise<SimilarMemoryRef | null> => {
            const filter = `relativePath == '${MemoryStore.escapeLiteral(parentId)}'`;
            const rows = await this.db.query(
                this.collectionName,
                filter,
                ['vector', 'metadata'],
                LIST_FETCH_LIMIT,
            );
            if (rows.length === 0) return null;
            const parentVectors = rows.map((row) =>
                Array.isArray(row.vector) ? (row.vector as number[]) : Array.from(row.vector as Iterable<number>));
            const parentCentroid = normalizedCentroid(parentVectors);
            const similarity = cosine(centroid, parentCentroid);
            if (similarity < threshold) return null;
            const meta = this.rowToParentMeta(this.parseMetadata(rows[0].metadata));
            return { id: parentId, title: meta.title, similarity, updatedAt: meta.updatedAt };
        }));

        return scored
            .filter((r): r is SimilarMemoryRef => r !== null)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, SIMILAR_MAX_RESULTS);
    }

    /**
     * Retrieve memories by a natural-language query and/or inline media
     * (image / audio / video / PDF). Each query signal becomes its own ranked
     * branch — text takes the hybrid (dense + BM25) path; each query attachment
     * is embedded with `embedContentBatch` and runs a dense branch in the same
     * shared space. When more than one branch is present they are fused with
     * RRF (the same scale-free fusion the hybrid text path uses), then resolved
     * to full parent memories and deduped by parent id. Pure relevance ranking.
     *
     * `query` is optional when at least one query attachment is supplied
     * (recall-by-media). Supplying attachments to a non-multimodal model throws.
     */
    async recall(
        query?: string,
        limit = 10,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        const trimmed = (query ?? '').trim();
        const attachmentsInput = queryAttachments ?? [];
        const hasText = trimmed.length > 0;
        const hasAttachments = attachmentsInput.length > 0;
        if (!hasText && !hasAttachments) return [];

        // Validate query media + assert multimodal support BEFORE the
        // collection-existence shortcut, so a misused model fails fast (a clear
        // programming error) rather than silently returning [] on an empty store.
        const validatedQuery = hasAttachments
            ? await validateAttachments(attachmentsInput, this.attachmentLimits)
            : [];
        if (validatedQuery.length > 0 && !this.embedding.isMultimodal()) {
            throw new Error(
                'Recall-by-media requires a multimodal embedding model (e.g. gemini-embedding-2); ' +
                `the current ${this.embedding.getProvider()} model does not accept inline media.`,
            );
        }

        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return [];

        // Over-fetch chunks so that after dedupe-by-parent we still have enough
        // distinct memories to satisfy `limit`.
        const chunkLimit = Math.max(limit * 4, 20);

        // Text-only fast path: preserve the exact prior behavior, including the
        // per-branch subScores that callers surface beneath each hit.
        if (hasText && !hasAttachments) {
            const hits = await this.searchText(trimmed, chunkLimit);
            return this.resolveHitsToParents(hits, limit);
        }

        // Otherwise build one ranked list per query signal and fuse with RRF.
        const rankedLists: HybridSearchResult[][] = [];
        if (hasText) {
            rankedLists.push(await this.searchText(trimmed, chunkLimit));
        }
        if (validatedQuery.length > 0) {
            const vectors = await this.embedAttachments(validatedQuery);
            for (const vec of vectors) {
                const dense = await this.db.search(this.collectionName, vec.vector, { topK: chunkLimit });
                rankedLists.push(dense.map((r) => ({ document: r.document, score: r.score })));
            }
        }

        const fused = MemoryStore.fuseByRrf(rankedLists);
        return this.resolveHitsToParents(fused, limit);
    }

    /** One text branch: hybrid (dense + BM25) when enabled, else dense-only. */
    private async searchText(trimmed: string, chunkLimit: number): Promise<HybridSearchResult[]> {
        const queryEmbedding = await this.embedding.embed(trimmed);
        if (this.getIsHybrid()) {
            const requests: HybridSearchRequest[] = [
                { data: queryEmbedding.vector, anns_field: 'vector', param: {}, limit: chunkLimit },
                { data: trimmed, anns_field: 'sparse_vector', param: {}, limit: chunkLimit },
            ];
            return this.db.hybridSearch(this.collectionName, requests, {
                rerank: { strategy: 'rrf', params: { k: RECALL_RRF_K } },
                limit: chunkLimit,
            });
        }
        const dense = await this.db.search(this.collectionName, queryEmbedding.vector, { topK: chunkLimit });
        return dense.map((r) => ({ document: r.document, score: r.score }));
    }

    /**
     * Reciprocal Rank Fusion across branch result lists. Each row's score is
     * the sum of `1 / (k + rank)` over the lists that surfaced it (1-based
     * rank), deduped at the row (`document.id`) level. Scale-free, so a dense
     * media branch and a fused text branch combine without score normalization.
     */
    private static fuseByRrf(lists: HybridSearchResult[][], k = RECALL_RRF_K): HybridSearchResult[] {
        const byRow = new Map<string, HybridSearchResult>();
        for (const list of lists) {
            list.forEach((hit, index) => {
                const rowId = hit.document.id;
                if (!rowId) return;
                const contribution = 1 / (k + index + 1);
                const existing = byRow.get(rowId);
                if (existing) {
                    existing.score += contribution;
                } else {
                    byRow.set(rowId, { document: hit.document, score: contribution });
                }
            });
        }
        return Array.from(byRow.values()).sort((a, b) => b.score - a.score);
    }

    /**
     * Resolve ranked chunk/attachment rows back to full parent memories,
     * keeping the best-scoring row per parent so a caller never receives a
     * fragment. Results stay ranked by fused relevance.
     */
    private resolveHitsToParents(hits: HybridSearchResult[], limit: number): MemoryRecallResult[] {
        const byParent = new Map<string, MemoryRecallResult>();
        for (const hit of hits) {
            const parentId = hit.document.relativePath;
            if (!parentId) continue;
            const meta = this.rowToParentMeta(hit.document.metadata);
            const existing = byParent.get(parentId);
            if (!existing || hit.score > existing.score) {
                byParent.set(parentId, {
                    id: parentId,
                    title: meta.title,
                    content: meta.fullContent,
                    attachments: MemoryStore.toPublicAttachments(meta.attachments),
                    createdAt: meta.createdAt,
                    updatedAt: meta.updatedAt,
                    score: hit.score,
                    ...(hit.subScores && { subScores: hit.subScores }),
                });
            }
        }

        return Array.from(byParent.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Revise an existing memory in place under the same id. Omitted fields are
     * preserved: leaving out `content` keeps the prior text, leaving out
     * `attachments` keeps the prior media. Bumps updatedAt, preserves createdAt.
     * Throws if the id does not exist.
     */
    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = await this.loadParentMeta(id);
        if (!existing) {
            throw new Error(`Memory not found: ${id}`);
        }

        const content = input.content ?? existing.fullContent;
        const attachmentsInput = input.attachments ?? await this.attachmentsToInput(existing.attachments);
        const title = input.title ?? existing.title;

        if ((content ?? '').trim().length === 0 && attachmentsInput.length === 0) {
            throw new Error('Cannot update a memory to empty content (provide content or at least one attachment)');
        }

        const now = Date.now();
        const { memory } = await this.writeMemory(id, content, title, attachmentsInput, existing.createdAt, now);
        return memory;
    }

    /**
     * Update only attachment captions, reusing the EXISTING media vectors —
     * the no-re-embed caption path. Editing a caption is pure metadata: the
     * bytes are unchanged, so re-embedding each attachment (a network round-trip
     * to the embedding model, per attachment) would be wasted work. Instead this
     * reads every stored row for the memory back WITH its `vector` column,
     * rewrites only the caption-derived fields (the BM25 `content` of attachment
     * rows + the shared `attachments`/`updatedAt` metadata), and re-inserts the
     * rows with their original vectors intact. Blobs are never touched.
     *
     * Captions are matched by attachment id; an empty/whitespace caption clears
     * it (its BM25 text falls back to the title). Throws if the memory does not
     * exist, or if a supplied caption id matches no attachment.
     */
    async updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const exists = await this.db.hasCollection(this.collectionName);
        const filter = `relativePath == '${MemoryStore.escapeLiteral(id)}'`;
        const rows = exists
            ? await this.db.query(
                this.collectionName,
                filter,
                ['id', 'vector', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
                LIST_FETCH_LIMIT,
            )
            : [];
        if (rows.length === 0) {
            throw new Error(`Memory not found: ${id}`);
        }

        const meta = this.rowToParentMeta(this.parseMetadata(rows[0].metadata));

        // Map attachment id -> trimmed new caption (empty string => clear).
        const updates = new Map<string, string | undefined>();
        const knownIds = new Set(meta.attachments.map((a) => a.id));
        for (const update of captions) {
            if (!knownIds.has(update.id)) {
                throw new Error(`Attachment not found on memory ${id}: ${update.id}`);
            }
            const trimmed = update.caption?.trim();
            updates.set(update.id, trimmed ? trimmed : undefined);
        }

        const attachments: StoredAttachment[] = meta.attachments.map((att) => {
            if (!updates.has(att.id)) return att;
            const caption = updates.get(att.id);
            // Rebuild without spreading `att` so an undefined caption clears it.
            return {
                id: att.id,
                kind: att.kind,
                mimeType: att.mimeType,
                byteLength: att.byteLength,
                ...(caption && { caption }),
                blobRef: att.blobRef,
            };
        });

        const newMeta: ParentMeta = { ...meta, attachments, updatedAt: Date.now() };
        const record = this.metaToRecord(newMeta);

        // Rebuild every row reusing its existing vector — NO embedding call.
        const rebuilt: VectorDocument[] = rows.map((row) => {
            const rowId = row.id as string;
            const vector = Array.isArray(row.vector)
                ? (row.vector as number[])
                : Array.from(row.vector as Iterable<number>);
            const isAttachmentRow = rowId.includes('::att::');
            // Attachment rows: BM25 text = new caption (resolved by the row's
            // attachment index, which buildAttachmentRows stores in startLine)
            // or the title. Chunk rows: preserve the stored chunk text verbatim.
            const content = isAttachmentRow
                ? attachments[Number(row.startLine)]?.caption ?? newMeta.title
                : (row.content as string);
            return {
                id: rowId,
                vector,
                content,
                relativePath: row.relativePath as string,
                startLine: Number(row.startLine) || 0,
                endLine: Number(row.endLine) || 0,
                fileExtension: typeof row.fileExtension === 'string' ? row.fileExtension : '',
                metadata: record,
            };
        });

        const oldIds = rows.map((r) => r.id as string).filter(Boolean);
        await this.db.delete(this.collectionName, oldIds);
        await this.db.insertHybrid(this.collectionName, rebuilt);

        return {
            id,
            title: newMeta.title,
            content: newMeta.fullContent,
            attachments: MemoryStore.toPublicAttachments(attachments),
            createdAt: newMeta.createdAt,
            updatedAt: newMeta.updatedAt,
        };
    }

    /** Fetch a single full memory by id, or null if absent. */
    async get(id: string): Promise<Memory | null> {
        const meta = await this.loadParentMeta(id);
        if (!meta) return null;
        return {
            id,
            title: meta.title,
            content: meta.fullContent,
            attachments: MemoryStore.toPublicAttachments(meta.attachments),
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
        };
    }

    /** Read the raw bytes of one attachment, or null if the memory/blob is gone. */
    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const meta = await this.loadParentMeta(memoryId);
        if (!meta) return null;
        const att = meta.attachments.find((a) => a.id === attachmentId);
        if (!att) return null;
        try {
            const data = await this.blobStore.get(att.blobRef);
            return {
                mimeType: att.mimeType,
                byteLength: att.byteLength,
                ...(att.caption && { caption: att.caption }),
                data,
            };
        } catch {
            return null;
        }
    }

    /** Load the shared parent metadata for an id from any one of its rows. */
    private async loadParentMeta(id: string): Promise<ParentMeta | null> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return null;
        const filter = `relativePath == '${MemoryStore.escapeLiteral(id)}'`;
        const rows = await this.db.query(
            this.collectionName,
            filter,
            ['relativePath', 'metadata', 'startLine'],
            LIST_FETCH_LIMIT,
        );
        if (rows.length === 0) return null;
        return this.rowToParentMeta(this.parseMetadata(rows[0].metadata));
    }

    /** List all memories (sorted by updatedAt desc) for browsing. */
    async list(): Promise<MemorySummary[]> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return [];
        const rows = await this.db.query(
            this.collectionName,
            '',
            ['relativePath', 'metadata'],
            LIST_FETCH_LIMIT,
        );

        const byParent = new Map<string, ParentMeta>();
        for (const row of rows) {
            const parentId = row.relativePath as string;
            if (!parentId || byParent.has(parentId)) continue;
            byParent.set(parentId, this.rowToParentMeta(this.parseMetadata(row.metadata)));
        }

        return Array.from(byParent.entries())
            .map(([id, meta]) => ({
                id,
                title: meta.title,
                preview: this.previewFor(meta),
                attachments: MemoryStore.toPublicAttachments(meta.attachments),
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * List every parent memory together with ALL of its stored row vectors
     * (chunks + attachments). Reads straight from LanceDB — no embedding
     * calls — so hygiene clustering can reuse the vectors already paid for.
     */
    async listParentsWithVectors(): Promise<ParentVectorData[]> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return [];
        const rows = await this.db.query(
            this.collectionName,
            '',
            ['id', 'vector', 'relativePath', 'metadata'],
            LIST_FETCH_LIMIT,
        );

        const byParent = new Map<string, ParentVectorData>();
        for (const row of rows) {
            const parentId = row.relativePath as string;
            if (!parentId) continue;
            // Vectors may round-trip as Arrow arrays — coerce like the caption path.
            const vector = Array.isArray(row.vector)
                ? (row.vector as number[])
                : Array.from(row.vector as Iterable<number>);
            const existing = byParent.get(parentId);
            if (existing) {
                existing.vectors.push(vector);
                continue;
            }
            const meta = this.rowToParentMeta(this.parseMetadata(row.metadata));
            byParent.set(parentId, {
                id: parentId,
                title: meta.title,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                fullContent: meta.fullContent,
                vectors: [vector],
            });
        }
        return Array.from(byParent.values());
    }

    /** Delete a memory (all its chunk + attachment rows and its blobs). No-op if absent. */
    async delete(id: string): Promise<void> {
        await this.deleteChunkRows(id);
        await this.blobStore.deleteParent(id);
    }

    /** Export all memories as portable records (sorted by updatedAt desc). */
    async exportAll(): Promise<MemoryExportRecord[]> {
        const summaries = await this.list();
        const records: MemoryExportRecord[] = [];
        for (const summary of summaries) {
            const meta = await this.loadParentMeta(summary.id);
            if (!meta) continue;
            const attachments = await this.exportAttachments(meta.attachments);
            records.push({
                id: summary.id,
                title: meta.title,
                content: meta.fullContent,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                ...(attachments.length > 0 && { attachments }),
            });
        }
        return records;
    }

    /**
     * Import memories from portable records. Upsert by id (default merge
     * policy, §7.5): an existing id is replaced; a new id is inserted.
     * Re-embeds content + attachments via the configured embedding provider.
     * Per-record fault-tolerant: a record that throws is collected into
     * `errors` and the loop continues, so one bad record can't abort a large
     * restore midway.
     */
    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        await this.ensureCollection();
        let imported = 0;
        const errors: ImportRecordError[] = [];
        for (let index = 0; index < records.length; index++) {
            const record = records[index];
            const content = record.content ?? '';
            const attachmentsInput: MemoryAttachmentInput[] = Array.isArray(record.attachments)
                ? record.attachments.map((a) => ({
                    mimeType: a.mimeType,
                    data: a.data,
                    ...(a.caption && { caption: a.caption }),
                }))
                : [];
            if (content.trim().length === 0 && attachmentsInput.length === 0) continue;

            try {
                const id = record.id || MemoryStore.newId();
                const createdAt = Number(record.createdAt) || Date.now();
                const updatedAt = Number(record.updatedAt) || createdAt;
                await this.writeMemory(id, content, record.title, attachmentsInput, createdAt, updatedAt);
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

    /** Read stored attachments back into base64 inputs (for update preserve / re-embed). */
    private async attachmentsToInput(stored: StoredAttachment[]): Promise<MemoryAttachmentInput[]> {
        const out: MemoryAttachmentInput[] = [];
        for (const att of stored) {
            try {
                const bytes = await this.blobStore.get(att.blobRef);
                out.push({
                    mimeType: att.mimeType,
                    data: bytes.toString('base64'),
                    ...(att.caption && { caption: att.caption }),
                });
            } catch {
                // Blob missing on disk — drop it rather than fail the whole update.
            }
        }
        return out;
    }

    /** Read stored attachments back into portable export records (base64). */
    private async exportAttachments(stored: StoredAttachment[]): Promise<MemoryExportAttachment[]> {
        const out: MemoryExportAttachment[] = [];
        for (const att of stored) {
            try {
                const bytes = await this.blobStore.get(att.blobRef);
                out.push({
                    id: att.id,
                    mimeType: att.mimeType,
                    data: bytes.toString('base64'),
                    ...(att.caption && { caption: att.caption }),
                });
            } catch {
                // Skip an attachment whose blob is missing.
            }
        }
        return out;
    }

    private async deleteChunkRows(parentId: string): Promise<void> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return;
        const filter = `relativePath == '${MemoryStore.escapeLiteral(parentId)}'`;
        const rows = await this.db.query(this.collectionName, filter, ['id'], LIST_FETCH_LIMIT);
        const ids = rows.map((r) => r.id as string).filter(Boolean);
        if (ids.length > 0) {
            await this.db.delete(this.collectionName, ids);
        }
    }

    private parseMetadata(raw: unknown): Record<string, any> {
        if (raw && typeof raw === 'object') return raw as Record<string, any>;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw || '{}');
            } catch {
                return {};
            }
        }
        return {};
    }

    /** List preview: text excerpt, or an attachment badge for media-only memories. */
    private previewFor(meta: ParentMeta): string {
        const text = this.makePreview(meta.fullContent);
        if (text.length > 0) return text;
        if (meta.attachments.length > 0) return MemoryStore.attachmentBadge(meta.attachments);
        return text;
    }

    private static attachmentBadge(attachments: StoredAttachment[]): string {
        const counts = new Map<AttachmentKind, number>();
        for (const att of attachments) {
            counts.set(att.kind, (counts.get(att.kind) ?? 0) + 1);
        }
        const parts = Array.from(counts.entries()).map(([kind, n]) => `${n} ${kind}${n > 1 ? 's' : ''}`);
        return `📎 ${parts.join(', ')}`;
    }

    private makePreview(content: string, length = DEFAULT_PREVIEW_LENGTH): string {
        const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
        if (collapsed.length <= length) return collapsed;
        return collapsed.slice(0, length).trimEnd() + '…';
    }
}
