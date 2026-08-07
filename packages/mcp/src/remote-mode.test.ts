import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Memory } from 'gemdex-core';
import { MemoryStatsStore } from 'gemdex-core';
import { createConfig } from './config.js';
import { MemoryToolHandlers } from './handlers.js';
import { createMemoryBackend } from './memory.js';
import { MCP_TOOL_NAMES } from './tool-names.js';

interface RecordedRequest {
    method: string;
    path: string;
    body: any;
    authorization?: string;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function startFakeRemote(): Promise<{
    url: string;
    requests: RecordedRequest[];
    close: () => Promise<void>;
}> {
    const requests: RecordedRequest[] = [];
    let memory: Memory | null = null;
    const server = http.createServer(async (req, res) => {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '')
            ? await readJson(req)
            : {};
        requests.push({
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            body,
            authorization: req.headers.authorization,
        });
        if (req.headers.authorization !== 'Bearer remote-token') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/memories') {
            memory = {
                id: 'remote-1',
                title: body.title ?? 'Remote memory',
                content: body.content ?? '',
                attachments: (body.attachments ?? []).map((attachment: any, index: number) => ({
                    id: String(index),
                    kind: 'image',
                    mimeType: attachment.mimeType,
                    byteLength: Buffer.from(attachment.data, 'base64').length,
                    caption: attachment.caption,
                })),
                createdAt: 1,
                updatedAt: 1,
            };
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ memory }));
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/recall') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: memory ? [{ ...memory, score: 1 }] : [] }));
            return;
        }
        if (req.method === 'GET' && req.url === '/v1/memories/remote-1') {
            if (!memory) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ memory }));
            return;
        }
        if (req.method === 'PUT' && req.url === '/v1/memories/remote-1' && memory) {
            memory = {
                ...memory,
                ...(body.content !== undefined && { content: body.content }),
                ...(body.title !== undefined && { title: body.title }),
                updatedAt: 2,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ memory }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

test('MCP public tool surface remains save_memory, recall, get_memory, update_memory, report_outcome, read_attachment', () => {
    assert.deepEqual(
        [...MCP_TOOL_NAMES],
        ['save_memory', 'recall', 'get_memory', 'update_memory', 'report_outcome', 'read_attachment'],
    );
});

test('remote-mode MCP handlers save, title-recall, get_memory, and update through HTTP', async () => {
    const remote = await startFakeRemote();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-mcp-remote-'));
    const imagePath = path.join(tmpDir, 'example.png');
    const imageBytes = Buffer.from('path attachment bytes');
    await fs.writeFile(imagePath, imageBytes);
    const config = createConfig((name) => ({
        GEMDEX_MODE: 'remote',
        GEMDEX_REMOTE_URL: remote.url,
        GEMDEX_REMOTE_TOKEN: 'remote-token',
    })[name]);
    const statsPath = path.join(tmpDir, 'stats.json');
    const handlers = new MemoryToolHandlers(createMemoryBackend(config), new MemoryStatsStore(statsPath));

    try {
        const saved = await handlers.handleSaveMemory({
            content: 'full remote parent',
            attachments: [{ path: imagePath, caption: 'path input' }],
        });
        assert.equal(saved.isError, undefined);
        assert.match(saved.content[0].text, /id: remote-1/);
        assert.equal(remote.requests[0].authorization, 'Bearer remote-token');
        assert.equal(remote.requests[0].body.attachments[0].path, undefined);
        assert.equal(
            Buffer.from(remote.requests[0].body.attachments[0].data, 'base64').toString(),
            imageBytes.toString(),
        );

        const recalled = await handlers.handleRecall({
            query: 'remote parent',
        });
        assert.equal(recalled.isError, undefined);
        assert.match(recalled.content[0].text, /id: remote-1/);
        assert.ok(!recalled.content[0].text.includes('full remote parent'), 'title index must not include body');
        assert.equal(remote.requests[1].body.query, 'remote parent');
        assert.equal(remote.requests[1].body.limit, 10);

        const opened = await handlers.handleGetMemory({ id: 'remote-1' });
        assert.equal(opened.isError, undefined);
        assert.match(opened.content[0].text, /full remote parent/);

        const updated = await handlers.handleUpdateMemory({
            id: 'remote-1',
            content: 'updated remote parent',
            attachments: [{ path: imagePath }],
        });
        assert.equal(updated.isError, undefined);
        assert.match(updated.content[0].text, /Updated memory/);
        const putReq = remote.requests.find((r) => r.method === 'PUT' && r.path === '/v1/memories/remote-1');
        assert.equal(putReq?.body.content, 'updated remote parent');
        assert.equal(putReq?.body.attachments[0].path, undefined);

        // Partial edit: handler fetches the memory (GET), applies the
        // find-and-replace client-side, then PUTs the reconstructed content.
        const edited = await handlers.handleUpdateMemory({
            id: 'remote-1',
            edits: [{ oldText: 'updated', newText: 'partially edited' }],
        });
        assert.equal(edited.isError, undefined);
        assert.match(edited.content[0].text, /Updated memory/);
        const getReqs = remote.requests.filter((r) => r.method === 'GET' && r.path === '/v1/memories/remote-1');
        assert.ok(getReqs.length >= 2, 'expected GETs for get_memory and edit fetch');
        const lastPut = remote.requests.filter((r) => r.method === 'PUT').at(-1);
        assert.equal(lastPut?.body.content, 'partially edited remote parent');
    } finally {
        await remote.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});
