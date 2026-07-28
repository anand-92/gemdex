import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type {
    HygieneManager,
    HygieneProgress,
    HygieneScanResult,
    MemoryBackend,
    MemoryStore,
} from "gemdex-core";
import { LocalMemoryBackend } from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createServer, ServeContext } from "./serve.js";

const TOKEN = "hygiene-test-token";

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
    scans: Array<{ store: unknown; threshold: unknown }>;
    runs: Array<{ options: unknown; store: unknown }>;
    applies: Array<{ ids: string[]; backend: unknown }>;
    dismissals: string[][];
    cancels: number;
}

const calls: FakeManagerCalls = { scans: [], runs: [], applies: [], dismissals: [], cancels: 0 };
let running = false;
let progress: HygieneProgress = { state: "idle", judged: 0, failed: 0, total: 0 };

const scanResult: HygieneScanResult = {
    scannedAt: 123,
    threshold: 0.85,
    memoryCount: 4,
    clusters: [],
    dismissedCount: 0,
    estimatedInputTokens: 10,
    estimatedOutputTokens: 20,
    estimates: [],
};

const fakeManager = {
    getReport(): null {
        return null;
    },
    async scan(store: MemoryStore, threshold?: number): Promise<HygieneScanResult> {
        calls.scans.push({ store, threshold });
        return scanResult;
    },
    async run(options: unknown, store: MemoryStore): Promise<HygieneProgress> {
        calls.runs.push({ options, store });
        progress = { state: "done", judged: 3, failed: 0, total: 3 };
        return progress;
    },
    getProgress(): HygieneProgress {
        return progress;
    },
    isRunning(): boolean {
        return running;
    },
    cancel(): void {
        calls.cancels += 1;
    },
    async apply(ids: string[], backend: MemoryBackend): Promise<{ deleted: number }> {
        calls.applies.push({ ids, backend });
        return { deleted: ids.length };
    },
    dismiss(clusterIds: string[]): void {
        calls.dismissals.push(clusterIds);
    },
} as unknown as HygieneManager;

const fakeMemoryStore = {} as unknown as MemoryStore;

// localStore() gates on `instanceof LocalMemoryBackend`, so the fake must
// carry the real prototype; Object.create skips the constructor.
const fakeStore = Object.create(LocalMemoryBackend.prototype) as LocalMemoryBackend;
Object.assign(fakeStore, { getStore: () => fakeMemoryStore });

function authed(input: string, init: RequestInit = {}): Promise<Response> {
    return fetch(input, {
        ...init,
        headers: { "Content-Type": "application/json", "X-Gemdex-Token": TOKEN, ...(init.headers ?? {}) },
    });
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-hygiene-"));
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
        hygieneManager: fakeManager,
        // Matches config.geminiApiKey so the key-staleness check keeps the fake.
        hygieneManagerKey: "local-key",
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

test("hygiene routes require the token", async () => {
    const res = await fetch(`${base}/hygiene/status`);
    assert.equal(res.status, 401);
});

test("GET /hygiene/report returns the persisted report, models, and readiness", async () => {
    const res = await authed(`${base}/hygiene/report`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.report, null);
    assert.equal(body.hygieneReady, true);
    assert.ok(Array.isArray(body.models));
    assert.ok(body.models.some((m: any) => m.isDefault));
    assert.ok(body.pricingAsOf);
});

test("POST /hygiene/scan delegates to the manager with the store and threshold", async () => {
    const res = await authed(`${base}/hygiene/scan`, {
        method: "POST",
        body: JSON.stringify({ threshold: 0.9 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as HygieneScanResult;
    assert.equal(body.memoryCount, 4);
    const call = calls.scans.at(-1)!;
    assert.equal(call.store, fakeMemoryStore);
    assert.equal(call.threshold, 0.9);
});

test("POST /hygiene/start kicks off a run and /hygiene/status reports it", async () => {
    const res = await authed(`${base}/hygiene/start`, {
        method: "POST",
        body: JSON.stringify({ model: "gemini-3.5-flash-lite", threshold: 0.8 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { started: true });
    // run() is fired asynchronously; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const call = calls.runs.at(-1)!;
    assert.deepEqual(call.options, { model: "gemini-3.5-flash-lite", threshold: 0.8 });
    assert.equal(call.store, fakeMemoryStore);

    const status = await authed(`${base}/hygiene/status`);
    assert.equal(status.status, 200);
    const statusBody = (await status.json()) as HygieneProgress;
    assert.equal(statusBody.state, "done");
    assert.equal(statusBody.judged, 3);
});

test("POST /hygiene/start returns 409 while a run is in progress", async () => {
    running = true;
    try {
        const res = await authed(`${base}/hygiene/start`, { method: "POST", body: JSON.stringify({}) });
        assert.equal(res.status, 409);
    } finally {
        running = false;
    }
});

test("POST /hygiene/cancel cancels only a live run", async () => {
    const idle = await authed(`${base}/hygiene/cancel`, { method: "POST" });
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), { cancelled: false });
    assert.equal(calls.cancels, 0);

    running = true;
    try {
        const live = await authed(`${base}/hygiene/cancel`, { method: "POST" });
        assert.equal(live.status, 200);
        assert.deepEqual(await live.json(), { cancelled: true });
        assert.equal(calls.cancels, 1);
    } finally {
        running = false;
    }
});

test("POST /hygiene/apply deletes the given ids via the backend", async () => {
    const res = await authed(`${base}/hygiene/apply`, {
        method: "POST",
        body: JSON.stringify({ ids: ["a", "b"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 2 });
    const call = calls.applies.at(-1)!;
    assert.deepEqual(call.ids, ["a", "b"]);
    assert.equal(call.backend, fakeStore);

    const missing = await authed(`${base}/hygiene/apply`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(missing.status, 400);

    const empty = await authed(`${base}/hygiene/apply`, { method: "POST", body: JSON.stringify({ ids: [] }) });
    assert.equal(empty.status, 400);
});

test("POST /hygiene/dismiss records dismissals", async () => {
    const res = await authed(`${base}/hygiene/dismiss`, {
        method: "POST",
        body: JSON.stringify({ clusterIds: ["c1", "c2", "c3"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { dismissed: 3 });
    assert.deepEqual(calls.dismissals.at(-1), ["c1", "c2", "c3"]);

    const empty = await authed(`${base}/hygiene/dismiss`, { method: "POST", body: JSON.stringify({ clusterIds: [] }) });
    assert.equal(empty.status, 400);
});

test("remote storage mode blocks hygiene", async () => {
    const remote = createServer({
        config: {
            name: "test",
            version: "1",
            embeddingModel: "fake",
            geminiApiKey: "local-key",
            mode: "remote",
            remote: { url: "https://memory.example.test", token: "remote-token" },
        } as ServeContext["config"],
        store: { importRecords: async () => ({ imported: 0 }) } as unknown as MemoryBackend,
        token: TOKEN,
        clientConfigStore: new ClientConfigStore({ rootDir: tmpDir }),
        hygieneManager: fakeManager,
        hygieneManagerKey: "local-key",
        geminiReadiness: validGeminiReadiness("local-key"),
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const addr = remote.address() as AddressInfo;
    const remoteBase = `http://127.0.0.1:${addr.port}`;
    try {
        const res = await authed(`${remoteBase}/hygiene/scan`, { method: "POST", body: JSON.stringify({}) });
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /local storage/i);
    } finally {
        await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
});

test("missing local key blocks judging but still serves the report", async () => {
    const remote = createServer({
        config: {
            name: "test",
            version: "1",
            embeddingModel: "fake",
            mode: "remote",
            remote: { url: "https://memory.example.test", token: "remote-token" },
        } as ServeContext["config"],
        store: { importRecords: async () => ({ imported: 0 }) } as unknown as MemoryBackend,
        token: TOKEN,
        clientConfigStore: new ClientConfigStore({ rootDir: tmpDir }),
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const addr = remote.address() as AddressInfo;
    const remoteBase = `http://127.0.0.1:${addr.port}`;
    try {
        const started = await authed(`${remoteBase}/hygiene/start`, { method: "POST", body: JSON.stringify({}) });
        assert.equal(started.status, 400);
        assert.match(((await started.json()) as { error: string }).error, /GEMINI_API_KEY/);

        const report = await authed(`${remoteBase}/hygiene/report`);
        assert.equal(report.status, 200);
        const reportBody = (await report.json()) as any;
        assert.equal(reportBody.hygieneReady, false);
        assert.ok(Array.isArray(reportBody.models));

        const status = await authed(`${remoteBase}/hygiene/status`);
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { state: "idle", judged: 0, failed: 0, total: 0 });
    } finally {
        await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
});

test("hygiene routes answer 503 needsKey when the store is missing", async () => {
    const bare = createServer({ config: { mode: "local" } as ServeContext["config"], store: null });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const addr = bare.address() as AddressInfo;
    try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/hygiene/report`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { needsKey?: boolean };
        assert.equal(body.needsKey, true);
    } finally {
        await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
});
