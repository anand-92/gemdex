import { MemoryStore, MemoryStoreConfig } from './memory-store';
import {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    ImportRecordsResult,
    Memory,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    MemoryAttachmentInput,
    SaveMemoryInput,
    SaveResult,
    UpdateMemoryInput,
} from './types';

/**
 * Storage boundary used by MCP and app callers. Implementations may be the
 * embedded LanceDB/FileBlobStore path, or a future remote Gemdex service, but
 * must preserve the public memory model: one global pool, parent-document
 * chunking with full-parent recall results, and attachment reads by memory id.
 */
export interface MemoryBackend {
    save(input: SaveMemoryInput): Promise<SaveResult>;
    recall(query?: string, limit?: number, queryAttachments?: MemoryAttachmentInput[]): Promise<MemoryRecallResult[]>;
    update(id: string, input: UpdateMemoryInput): Promise<Memory>;
    updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory>;
    get(id: string): Promise<Memory | null>;
    list(): Promise<MemorySummary[]>;
    delete(id: string): Promise<void>;
    exportAll(): Promise<MemoryExportRecord[]>;
    importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult>;
    readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null>;
}

/**
 * Local backend adapter for the existing embedded storage path:
 * Gemini embeddings + LanceDB hybrid vectors + FileBlobStore attachment blobs.
 */
export class LocalMemoryBackend implements MemoryBackend {
    private store: MemoryStore;

    constructor(storeOrConfig: MemoryStore | MemoryStoreConfig) {
        this.store = storeOrConfig instanceof MemoryStore ? storeOrConfig : new MemoryStore(storeOrConfig);
    }

    /** Direct access to the underlying local store (e.g. for hygiene scans). */
    getStore(): MemoryStore {
        return this.store;
    }

    save(input: SaveMemoryInput): Promise<SaveResult> {
        return this.store.save(input);
    }

    recall(
        query?: string,
        limit?: number,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        return this.store.recall(query, limit, queryAttachments);
    }

    update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        return this.store.update(id, input);
    }

    updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        return this.store.updateAttachmentCaptions(id, captions);
    }

    get(id: string): Promise<Memory | null> {
        return this.store.get(id);
    }

    list(): Promise<MemorySummary[]> {
        return this.store.list();
    }

    delete(id: string): Promise<void> {
        return this.store.delete(id);
    }

    exportAll(): Promise<MemoryExportRecord[]> {
        return this.store.exportAll();
    }

    importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        return this.store.importRecords(records);
    }

    readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        return this.store.readAttachment(memoryId, attachmentId);
    }
}
