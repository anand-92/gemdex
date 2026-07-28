import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    createMemoryApiHandler,
    sendJson,
} from '../http';
import {
    RemoteMemoryBackend,
    RemoteMemoryError,
} from './remote-backend';
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
} from './index';

class FakeRemoteStore implements MemoryBackend {
    private readonly memories = new Map<string, Memory>();
    private readonly attachmentData = new Map<string, Buffer>();
    private counter = 0;

    async save(input: SaveMemoryInput): Promise<Memory> {
        const id = `memory-${++this.counter}`;
        const now = Date.now();
        const attachments = (input.attachments ?? []).map((attachment, index) => {
            const data = Buffer.from(attachment.data, 'base64');
            this.attachmentData.set(`${id}:${index}`, data);
            return {
                id: String(index),
                kind: 'image' as const,
                mimeType: attachment.mimeType,
                byteLength: data.length,
                caption: attachment.caption,
            };
        });
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
        limit = 10,
        _queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        return Array.from(this.memories.values())
            .filter((memory) => !query || memory.content.includes(query))
            .slice(0, limit)
            .map((memory) => ({ ...memory, score: 1 }));
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = this.memories.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        const memory = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.title !== undefined && { title: input.title }),
            updatedAt: Date.now(),
        };
        this.memories.set(id, memory);
        return memory;
    }

    async updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const existing = this.memories.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        const byId = new Map(captions.map((caption) => [caption.id, caption.caption]));
        const memory = {
            ...existing,
            attachments: existing.attachments.map((attachment) => (
                byId.has(attachment.id)
                    ? { ...attachment, caption: byId.get(attachment.id) }
                    : attachment
            )),
            updatedAt: Date.now(),
        };
        this.memories.set(id, memory);
        return memory;
    }

    async get(id: string): Promise<Memory | null> {
        return this.memories.get(id) ?? null;
    }

    async list(): Promise<MemorySummary[]> {
        return Array.from(this.memories.values()).map((memory) => ({
            id: memory.id,
            title: memory.title,
            preview: memory.content.slice(0, 100),
            attachments: memory.attachments,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
        }));
    }

    async delete(id: string): Promise<void> {
        this.memories.delete(id);
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        return Promise.all(Array.from(this.memories.values()).map(async (memory) => ({
            id: memory.id,
            title: memory.title,
            content: memory.content,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            attachments: memory.attachments.map((attachment) => ({
                id: attachment.id,
                mimeType: attachment.mimeType,
                data: this.attachmentData.get(`${memory.id}:${attachment.id}`)!.toString('base64'),
                caption: attachment.caption,
            })),
        })));
    }

    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        for (const record of records) {
            const attachments = (record.attachments ?? []).map((attachment, index) => {
                const id = attachment.id ?? String(index);
                const data = Buffer.from(attachment.data, 'base64');
                this.attachmentData.set(`${record.id}:${id}`, data);
                return {
                    id,
                    kind: 'image' as const,
                    mimeType: attachment.mimeType,
                    byteLength: data.length,
                    caption: attachment.caption,
                };
            });
            this.memories.set(record.id, { ...record, attachments });
        }
        return { imported: records.length, failed: 0, errors: [] };
    }

    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const memory = this.memories.get(memoryId);
        const attachment = memory?.attachments.find((item) => item.id === attachmentId);
        const data = this.attachmentData.get(`${memoryId}:${attachmentId}`);
        if (!attachment || !data) return null;
        return {
            mimeType: attachment.mimeType,
            byteLength: data.length,
            caption: attachment.caption,
            data,
        };
    }
}

async function listen(listener: http.RequestListener): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const server = http.createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function listenMemoryApi(token = 'secret'): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const handler = createMemoryApiHandler({ store: new FakeRemoteStore() });
    return listen((req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) {
            sendJson(res, 401, { error: 'Unauthorized remote token' }, {});
            return;
        }
        req.url = req.url?.replace(/^\/v1/, '') ?? '/';
        handler(req, res);
    });
}

describe('RemoteMemoryBackend', () => {
    it('passes the MemoryBackend lifecycle against the shared HTTP API', async () => {
        const server = await listenMemoryApi();
        const backend = new RemoteMemoryBackend({ url: server.url, token: 'secret' });
        const bytes = Buffer.from('attachment bytes');
        try {
            const created = await backend.save({
                title: 'Remote',
                content: 'full parent memory content',
                attachments: [{
                    mimeType: 'image/png',
                    data: bytes.toString('base64'),
                    caption: 'before',
                }],
            });
            expect(created.attachments).toHaveLength(1);
            expect((await backend.get(created.id))?.content).toBe('full parent memory content');
            expect(await backend.list()).toHaveLength(1);

            const updated = await backend.update(created.id, { title: 'Updated' });
            expect(updated.title).toBe('Updated');
            const captioned = await backend.updateAttachmentCaptions(created.id, [{
                id: '0',
                caption: 'after',
            }]);
            expect(captioned.attachments[0].caption).toBe('after');

            const recalled = await backend.recall('parent', 5, [{
                mimeType: 'image/png',
                data: bytes.toString('base64'),
            }]);
            expect(recalled[0].id).toBe(created.id);
            expect(recalled[0].content).toBe('full parent memory content');

            const attachment = await backend.readAttachment(created.id, '0');
            expect(attachment?.mimeType).toBe('image/png');
            expect(attachment?.data.equals(bytes)).toBe(true);
            expect(await backend.readAttachment(created.id, 'missing')).toBeNull();

            const exported = await backend.exportAll();
            expect(exported).toHaveLength(1);
            await backend.delete(created.id);
            expect(await backend.get(created.id)).toBeNull();
            expect(await backend.importRecords(exported)).toEqual({ imported: 1, failed: 0, errors: [] });
            expect((await backend.get(created.id))?.content).toBe('full parent memory content');
        } finally {
            await server.close();
        }
    });

    it('passes through per-record import errors and defaults them for legacy servers', async () => {
        // Servers pre-dating per-record import errors return only { imported }.
        const legacy = await listen((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ imported: 3 }));
        });
        try {
            const backend = new RemoteMemoryBackend({ url: legacy.url, token: 'secret' });
            expect(await backend.importRecords([])).toEqual({ imported: 3, failed: 0, errors: [] });
        } finally {
            await legacy.close();
        }

        const withErrors = await listen((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                imported: 1,
                failed: 1,
                errors: [{ index: 1, id: 'bad-record', error: 'embedding exploded' }],
            }));
        });
        try {
            const backend = new RemoteMemoryBackend({ url: withErrors.url, token: 'secret' });
            expect(await backend.importRecords([])).toEqual({
                imported: 1,
                failed: 1,
                errors: [{ index: 1, id: 'bad-record', error: 'embedding exploded' }],
            });
        } finally {
            await withErrors.close();
        }
    });

    it('sends bearer auth and maps server errors', async () => {
        const server = await listenMemoryApi('correct-token');
        const backend = new RemoteMemoryBackend({ url: server.url, token: 'wrong-token' });
        try {
            await expect(backend.list()).rejects.toMatchObject({
                name: 'RemoteMemoryError',
                status: 401,
                message: 'Unauthorized remote token',
            });
        } finally {
            await server.close();
        }
    });

    it('reports invalid JSON responses', async () => {
        const server = await listen((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('not-json');
        });
        const backend = new RemoteMemoryBackend({ url: server.url, token: 'secret' });
        try {
            await expect(backend.list()).rejects.toMatchObject({
                code: 'invalid_response',
                status: 200,
            });
        } finally {
            await server.close();
        }
    });

    it('enforces request and response body limits', async () => {
        const server = await listen((_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': '100',
            });
            res.end(JSON.stringify({ memories: [] }));
        });
        try {
            const requestLimited = new RemoteMemoryBackend({
                url: server.url,
                token: 'secret',
                maxRequestBytes: 10,
            });
            await expect(requestLimited.save({ content: 'this request is too large' }))
                .rejects.toMatchObject({ code: 'body_too_large' });

            const responseLimited = new RemoteMemoryBackend({
                url: server.url,
                token: 'secret',
                maxResponseBytes: 10,
            });
            await expect(responseLimited.list()).rejects.toMatchObject({ code: 'body_too_large' });
        } finally {
            await server.close();
        }
    });

    it('reports timeouts and network failures clearly', async () => {
        const slowServer = await listen((_req, res) => {
            setTimeout(() => res.end('{}'), 200);
        });
        try {
            const backend = new RemoteMemoryBackend({
                url: slowServer.url,
                token: 'secret',
                timeoutMs: 20,
            });
            await expect(backend.list()).rejects.toMatchObject({ code: 'timeout' });
        } finally {
            await slowServer.close();
        }

        const closedServer = await listen((_req, res) => res.end());
        const closedUrl = closedServer.url;
        await closedServer.close();
        const backend = new RemoteMemoryBackend({ url: closedUrl, token: 'secret', timeoutMs: 100 });
        await expect(backend.list()).rejects.toMatchObject({ code: 'network' });
    });

    it('rejects invalid remote configuration without inspecting local paths', () => {
        expect(() => new RemoteMemoryBackend({ url: 'file:///tmp/gemdex', token: 'secret' }))
            .toThrow(RemoteMemoryError);
        expect(() => new RemoteMemoryBackend({ url: 'https://example.test', token: ' ' }))
            .toThrow(/bearer token/);
    });
});
