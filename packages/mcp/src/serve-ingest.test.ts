import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { IngestManager, IngestProgress, IngestScanResult, MemoryBackend } from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createServer, ServeContext } from "./serve.js";

const TOKEN = "ingest-test-token";

function validGeminiReadiness(apiKey: string) {
    return {
        status: "valid" as const,
        validatedAt: Date.now(),
        keyFingerprint: crypto.createHash("sha256").update(apiKey).digest("hex"),
    };
}


let tmpDir: string;
let server: Server;
let base: string;
let ctx: ServeContext;

interface FakeManagerCalls {
    scans: unknown[];
    runs: unknown[];
    collects: number;
    cancels: number;
}

const calls: FakeManagerCalls = { scans: [], runs: [], collects: 0, cancels: 0 };
let running = false;
let progress: IngestProgress = { state: "idle", processed: 0, failed: 0, skipped: 0, total: 0 };

const fakeManager = {
    scan(folders: unknown): IngestScanResult {
        calls.scans.push(folders);
        return {
            buckets: { newFiles: [], changedFiles: [], upToDate: [], skippedActive: [] },
            processableFiles: [],
            skippedTrivialFiles: [],
            pendingCount: 0,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimates: [],
        };
    },
    async run(options: unknown, _backend: MemoryBackend): Promise<IngestProgress> {
        calls.runs.push(options);
        progress = { state: "done", processed: 2, failed: 0, skipped: 0, total: 2 };
        return progress;
    },
    getProgress(): IngestProgress {
        return progress;
    },
    isRunning(): boolean {
        return running;
    },
    cancel(): void {
        calls.cancels += 1;
    },
    async cancelBatch(): Promise<boolean> {
        calls.cancels += 1;
        return false;
    },
    async collect(_backend: MemoryBackend) {
        calls.collects += 1;
        return { state: "none" as const };
    },
} as unknown as IngestManager;

const fakeStore = { importRecords: async () => ({ imported: 0 }) } as unknown as MemoryBackend;

function authed(input: string, init: RequestInit = {}): Promise<Response> {
    return fetch(input, {
        ...init,
        headers: { "Content-Type": "application/json", "X-Gemdex-Token": TOKEN, ...(init.headers ?? {}) },
    });
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-ingest-"));
    ctx = {
        config: {
            name: "test",
            version: "1",
            embeddingModel: "fake",
            geminiApiKey: "local-key",
            mode: "local",
        } as ServeContext["config"],
        store: fakeStore,
        token: TOKEN,
        clientConfigStore: new ClientConfigStore({ rootDir: tmpDir }),
        ingestManager: fakeManager,
        // Matches config.geminiApiKey so the key-staleness check keeps the fake.
        ingestManagerKey: "local-key",
        geminiReadiness: validGeminiReadiness("local-key"),
    };
    server = createServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ingest routes require the token", async () => {
    const res = await fetch(`${base}/ingest/sources`);
    assert.equal(res.status, 401);
});

test("GET /ingest/sources lists presets, custom folders, and models", async () => {
    const res = await authed(`${base}/ingest/sources`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.presets.length, 4);
    assert.deepEqual(body.presets.map((p: any) => p.source), ["claude", "factory", "codex", "antigravity"]);
    assert.ok(Array.isArray(body.customFolders));
    assert.ok(body.models.some((m: any) => m.isDefault));
    assert.equal(body.ingestReady, true);
    assert.ok(body.pricingAsOf);
});

test("POST/DELETE /ingest/folders manage custom folders", async () => {
    const folder = path.join(tmpDir, "my-sessions");
    fs.mkdirSync(folder, { recursive: true });

    const added = await authed(`${base}/ingest/folders`, {
        method: "POST",
        body: JSON.stringify({ path: folder }),
    });
    assert.equal(added.status, 200);
    const addedBody = (await added.json()) as any;
    assert.deepEqual(addedBody.customFolders.map((f: any) => f.path), [folder]);

    const rejected = await authed(`${base}/ingest/folders`, {
        method: "POST",
        body: JSON.stringify({ path: "relative/path" }),
    });
    assert.equal(rejected.status, 400);

    const removed = await authed(`${base}/ingest/folders`, {
        method: "DELETE",
        body: JSON.stringify({ path: folder }),
    });
    assert.equal(removed.status, 200);
    const removedBody = (await removed.json()) as any;
    assert.deepEqual(removedBody.customFolders, []);
});

test("POST /ingest/scan validates sources and delegates to the manager", async () => {
    const bad = await authed(`${base}/ingest/scan`, { method: "POST", body: JSON.stringify({ sources: [] }) });
    assert.equal(bad.status, 400);

    const badSource = await authed(`${base}/ingest/scan`, {
        method: "POST",
        body: JSON.stringify({ sources: [{ source: "cursor" }] }),
    });
    assert.equal(badSource.status, 400);

    const ok = await authed(`${base}/ingest/scan`, {
        method: "POST",
        body: JSON.stringify({
            sources: [
                { source: "claude" },
                { source: "codex" },
                { source: "antigravity" },
                { source: "custom", path: tmpDir },
            ],
        }),
    });
    assert.equal(ok.status, 200);
    const folders = calls.scans.at(-1) as Array<{ source: string; path: string }>;
    assert.equal(folders.length, 4);
    assert.equal(folders[0].source, "claude");
    assert.ok(folders[0].path.endsWith(path.join(".claude", "projects")));
    assert.equal(folders[1].source, "codex");
    assert.ok(folders[1].path.endsWith(path.join(".codex", "sessions")));
    assert.equal(folders[2].source, "antigravity");
    assert.ok(folders[2].path.endsWith(path.join(".gemini", "antigravity-cli", "conversations")));
    assert.deepEqual(folders[3], { source: "custom", path: tmpDir });
});

test("POST /ingest/start kicks off a new-sessions-only run and /ingest/status reports it", async () => {
    const res = await authed(`${base}/ingest/start`, {
        method: "POST",
        // A legacy client may still send newOnly:false; the sidecar must ignore it.
        body: JSON.stringify({ sources: [{ source: "factory" }], model: "gemini-3.5-flash-lite", mode: "batch", newOnly: false }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { started: true });
    // run() is fired asynchronously; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runOptions = calls.runs.at(-1) as Record<string, unknown>;
    assert.equal(runOptions.model, "gemini-3.5-flash-lite");
    assert.equal(runOptions.mode, "batch");
    assert.equal("newOnly" in runOptions, false);

    const status = await authed(`${base}/ingest/status`);
    const statusBody = (await status.json()) as IngestProgress;
    assert.equal(statusBody.state, "done");
    assert.equal(statusBody.processed, 2);

});

test("POST /ingest/start returns 409 while a run is in progress", async () => {
    running = true;
    try {
        const res = await authed(`${base}/ingest/start`, {
            method: "POST",
            body: JSON.stringify({ sources: [{ source: "factory" }] }),
        });
        assert.equal(res.status, 409);
    } finally {
        running = false;
    }
});

test("POST /ingest/collect and /ingest/cancel delegate to the manager", async () => {
    const collect = await authed(`${base}/ingest/collect`, { method: "POST" });
    assert.equal(collect.status, 200);
    assert.deepEqual(await collect.json(), { state: "none" });
    assert.equal(calls.collects, 1);

    const cancel = await authed(`${base}/ingest/cancel`, { method: "POST" });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { cancelled: "none" });
});

test("remote storage exposes readiness but blocks ingestion without a validated local key", async () => {
    const remote = createServer({
        config: {
            name: "test",
            version: "1",
            embeddingModel: "fake",
            mode: "remote",
            remote: { url: "https://memory.example.test", token: "remote-token" },
        } as ServeContext["config"],
        store: fakeStore,
        token: TOKEN,
        clientConfigStore: new ClientConfigStore({ rootDir: tmpDir }),
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const addr = remote.address() as AddressInfo;
    const remoteBase = `http://127.0.0.1:${addr.port}`;
    try {
        const sources = await authed(`${remoteBase}/ingest/sources`);
        assert.equal(sources.status, 200);
        const sourcesBody = (await sources.json()) as any;
        assert.equal(sourcesBody.ingestReady, false);
        assert.equal(sourcesBody.gemini.status, "missing");

        const started = await authed(`${remoteBase}/ingest/start`, {
            method: "POST",
            body: JSON.stringify({ sources: [{ source: "factory" }] }),
        });
        assert.equal(started.status, 400);
        assert.match(((await started.json()) as { error: string }).error, /local GEMINI_API_KEY/);
    } finally {
        await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
});

test("ingest routes answer 503 needsKey when the store is missing", async () => {
    const bare = createServer({ config: { mode: "local" } as ServeContext["config"], store: null });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const addr = bare.address() as AddressInfo;
    try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/ingest/sources`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { needsKey?: boolean };
        assert.equal(body.needsKey, true);
    } finally {
        await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
});
