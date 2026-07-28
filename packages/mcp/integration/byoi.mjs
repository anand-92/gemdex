import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
    Embedding,
    RemoteMemoryBackend,
} from 'gemdex-core';
import {
    createPostgresPool,
} from '../../server/dist/postgres.js';
import {
    createConfiguredStore,
    createServer as createRemoteServer,
} from '../../server/dist/server.js';
import { createServer as createSidecarServer } from '../dist/serve.js';

const DATABASE_URL = process.env.BYOI_TEST_DATABASE_URL;
const REMOTE_TOKEN = 'byoi-integration-remote-token';
const SIDECAR_TOKEN = 'byoi-integration-sidecar-token';
const DIMENSION = 3072;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixturePath = path.join(
    repoRoot,
    'packages/app/assets/brand/logo-mark-256.png',
);

if (!DATABASE_URL) {
    throw new Error(
        'BYOI_TEST_DATABASE_URL is required. Start Postgres with pgvector and ' +
        'set a dedicated test database URL.',
    );
}

function log(message) {
    process.stderr.write(`[byoi-integration] ${message}\n`);
}

function hash(value) {
    let result = 2166136261;
    for (const byte of Buffer.from(value)) {
        result ^= byte;
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
}

function vectorFor(value) {
    const vector = new Array(DIMENSION).fill(0);
    const first = hash(`a:${value}`) % DIMENSION;
    const second = hash(`b:${value}`) % DIMENSION;
    vector[first] = 1;
    vector[second] += 0.5;
    return { vector, dimension: DIMENSION };
}

class DeterministicEmbedding extends Embedding {
    maxTokens = 8192;

    async detectDimension() {
        return DIMENSION;
    }

    async embed(text) {
        return vectorFor(`text:${this.preprocessText(text).toLowerCase()}`);
    }

    async embedBatch(texts) {
        return Promise.all(texts.map((text) => this.embed(text)));
    }

    async embedContentBatch(contents) {
        return contents.map((content) => {
            if (typeof content === 'string') {
                return vectorFor(`text:${content.toLowerCase()}`);
            }
            return vectorFor(
                `media:${content.inlineData.mimeType}:${content.inlineData.data}`,
            );
        });
    }

    getDimension() {
        return DIMENSION;
    }

    getProvider() {
        return 'deterministic-byoi-test';
    }

    isMultimodal() {
        return true;
    }
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
    if (!server) return;
    if (!server.listening) return;
    await new Promise((resolve) => server.close(resolve));
}

function toolText(result) {
    const text = result.content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
    assert.notEqual(result.isError, true, text || 'MCP tool returned an error');
    assert(text);
    return text;
}

function memoryIdFrom(text) {
    const match = /^id: (.+)$/m.exec(text);
    assert(match, `MCP result did not include a memory id:\n${text}`);
    return match[1].trim();
}

async function sidecarJson(baseUrl, route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: {
            'X-Gemdex-Token': SIDECAR_TOKEN,
            ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
            ...options.headers,
        },
    });
    const body = await response.json();
    assert.equal(
        response.ok,
        true,
        `${options.method ?? 'GET'} ${route} returned ${response.status}: ${JSON.stringify(body)}`,
    );
    return body;
}

async function run() {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-byoi-'));
    const blobDir = path.join(tempRoot, 'blobs');
    const pool = createPostgresPool(DATABASE_URL);
    let remoteServer;
    let sidecarServer;
    let mcpClient;
    let mcpTransport;
    let mcpStderr = '';

    try {
        log('creating real Postgres/pgvector backend with deterministic embedding');
        const store = await createConfiguredStore(
            {
                host: '127.0.0.1',
                port: 0,
                token: REMOTE_TOKEN,
                unsafeDevNoAuth: false,
                allowedOrigins: [],
                databaseUrl: DATABASE_URL,
                embeddingModel: 'deterministic-byoi-test',
                blobStore: { kind: 'file', directory: blobDir },
            },
            {
                pool,
                embedding: new DeterministicEmbedding(),
            },
        );
        assert(store, 'configured BYOI backend was not created');

        remoteServer = createRemoteServer({
            store,
            token: REMOTE_TOKEN,
        });
        const remoteUrl = await listen(remoteServer);
        log(`remote server listening at ${remoteUrl}`);

        const health = await fetch(`${remoteUrl}/v1/health`);
        assert.deepEqual(await health.json(), { ok: true });
        const unauthorized = await fetch(`${remoteUrl}/v1/memories`);
        assert.equal(unauthorized.status, 401, 'remote data route must require auth');

        const childEnv = Object.fromEntries(
            Object.entries(process.env).filter(
                ([name, value]) => name !== 'GEMINI_API_KEY' && value !== undefined,
            ),
        );
        Object.assign(childEnv, {
            GEMDEX_MODE: 'remote',
            GEMDEX_REMOTE_NAME: 'integration',
            GEMDEX_REMOTE_URL: remoteUrl,
            GEMDEX_REMOTE_TOKEN: REMOTE_TOKEN,
        });

        log('starting the built MCP stdio server without GEMINI_API_KEY');
        mcpTransport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(repoRoot, 'packages/mcp/dist/index.js')],
            cwd: repoRoot,
            env: childEnv,
            stderr: 'pipe',
        });
        mcpTransport.stderr?.on('data', (chunk) => {
            mcpStderr += chunk.toString();
        });
        mcpClient = new Client(
            { name: 'gemdex-byoi-integration', version: '1.0.0' },
            { capabilities: {} },
        );
        await mcpClient.connect(mcpTransport);

        const fixtureBytes = await fs.readFile(fixturePath);
        const longContent = [
            'START-OF-PARENT: deployment handbook.',
            'a'.repeat(1800),
            'The deep retrieval marker is ORBITAL-CEDAR-9417.',
            'b'.repeat(1800),
            'END-OF-PARENT: recovery checklist.',
        ].join('\n\n');

        log('saving a long parent memory through MCP with a path attachment');
        const saveText = toolText(await mcpClient.callTool({
            name: 'save_memory',
            arguments: {
                title: 'BYOI integration parent',
                content: longContent,
                attachments: [{
                    path: fixturePath,
                    caption: 'Gemdex logo integration fixture',
                }],
            },
        }));
        const memoryId = memoryIdFrom(saveText);

        log('verifying a deep chunk hit returns the full parent through MCP');
        const recallText = toolText(await mcpClient.callTool({
            name: 'recall',
            arguments: {
                query: 'ORBITAL-CEDAR-9417',
                limit: 5,
            },
        }));
        assert.match(recallText, /START-OF-PARENT/);
        assert.match(recallText, /END-OF-PARENT/);
        assert.match(recallText, new RegExp(memoryId));

        log('updating the remote memory through MCP');
        const updateText = toolText(await mcpClient.callTool({
            name: 'update_memory',
            arguments: {
                id: memoryId,
                title: 'BYOI integration parent updated',
            },
        }));
        assert.match(updateText, /Updated memory/);

        const remote = new RemoteMemoryBackend({
            url: remoteUrl,
            token: REMOTE_TOKEN,
        });
        const stored = await remote.get(memoryId);
        assert(stored);
        assert.equal(stored.title, 'BYOI integration parent updated');
        assert.equal(stored.content, longContent);
        assert.equal(stored.attachments.length, 1);

        log('recalling by media through the remote server API');
        const mediaResults = await remote.recall(undefined, 5, [{
            mimeType: 'image/png',
            data: fixtureBytes.toString('base64'),
        }]);
        assert.equal(mediaResults[0]?.id, memoryId);
        assert.equal(mediaResults[0]?.content, longContent);

        log('routing desktop management calls through the real sidecar');
        sidecarServer = createSidecarServer({
            config: {
                name: 'integration-sidecar',
                version: '1.0.0',
                embeddingModel: 'remote-owned',
                mode: 'remote',
                remoteName: 'integration',
                remote: { url: remoteUrl, token: REMOTE_TOKEN },
            },
            store: remote,
            token: SIDECAR_TOKEN,
        });
        const sidecarUrl = await listen(sidecarServer);

        const list = await sidecarJson(sidecarUrl, '/memories');
        assert.equal(list.memories.some((memory) => memory.id === memoryId), true);

        const attachmentId = stored.attachments[0].id;
        const attachmentResponse = await fetch(
            `${sidecarUrl}/memories/${encodeURIComponent(memoryId)}` +
            `/attachments/${encodeURIComponent(attachmentId)}`,
            { headers: { 'X-Gemdex-Token': SIDECAR_TOKEN } },
        );
        assert.equal(attachmentResponse.status, 200);
        assert.deepEqual(
            Buffer.from(await attachmentResponse.arrayBuffer()),
            fixtureBytes,
        );

        log('exporting, deleting, and importing through the desktop sidecar');
        const exported = await sidecarJson(sidecarUrl, '/export');
        assert.equal(exported.records.length, 1);
        assert.equal(exported.records[0].attachments[0].data, fixtureBytes.toString('base64'));

        await sidecarJson(sidecarUrl, `/memories/${encodeURIComponent(memoryId)}`, {
            method: 'DELETE',
        });
        assert.equal(await remote.get(memoryId), null);

        const imported = await sidecarJson(sidecarUrl, '/import', {
            method: 'POST',
            body: JSON.stringify(exported),
        });
        assert.deepEqual(imported, { imported: 1, failed: 0, errors: [] });
        const restored = await remote.get(memoryId);
        assert(restored);
        assert.equal(restored.content, longContent);
        const restoredBytes = await remote.readAttachment(
            memoryId,
            restored.attachments[0].id,
        );
        assert(restoredBytes);
        assert.deepEqual(restoredBytes.data, fixtureBytes);

        const blobFiles = await fs.readdir(
            path.join(blobDir, memoryId),
            { recursive: true },
        );
        assert(blobFiles.length > 0, 'file blob store did not persist attachment bytes');

        log('PASS: server, MCP, sidecar, pgvector, and file blob flows completed');
    } catch (error) {
        log(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
        if (mcpStderr.trim()) {
            process.stderr.write(`\n--- MCP stderr ---\n${mcpStderr}\n--- end MCP stderr ---\n`);
        }
        try {
            const dbState = await pool.query(`
                SELECT
                    (SELECT count(*) FROM gemdex_memory_documents) AS documents,
                    (SELECT count(*) FROM gemdex_memory_chunks) AS chunks,
                    (SELECT count(*) FROM gemdex_memory_attachments) AS attachments
            `);
            log(`database state: ${JSON.stringify(dbState.rows[0])}`);
        } catch (diagnosticError) {
            log(`database diagnostics failed: ${String(diagnosticError)}`);
        }
        try {
            const blobState = await fs.readdir(blobDir, { recursive: true });
            log(`blob files: ${JSON.stringify(blobState)}`);
        } catch (diagnosticError) {
            log(`blob diagnostics failed: ${String(diagnosticError)}`);
        }
        throw error;
    } finally {
        await mcpClient?.close().catch(() => undefined);
        await mcpTransport?.close().catch(() => undefined);
        await closeServer(sidecarServer);
        await closeServer(remoteServer);
        await pool.end().catch(() => undefined);
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

await run();
