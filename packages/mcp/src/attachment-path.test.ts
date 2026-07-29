import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentValidationError } from "gemdex-core";
import { resolveAttachmentInputs } from "./attachment-path.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// A real PNG (tiny placeholders are rejected by Gemini, but for fs resolution
// any real file works); reused as the canonical on-disk attachment fixture.
const REAL_IMAGE = path.resolve(here, "../../app/assets/brand/logo-mark-256.png");

test("reads a path-backed attachment into base64 with mimeType inferred from the extension", async () => {
    const [a] = await resolveAttachmentInputs([{ path: REAL_IMAGE, caption: "logo" }]);
    assert.equal(a.mimeType, "image/png");
    assert.equal(a.caption, "logo");
    const expected = fs.readFileSync(REAL_IMAGE).toString("base64");
    assert.equal(a.data, expected);
    assert.equal((a as { path?: string }).path, undefined);
});

test("honors an explicit mimeType override for a path attachment", async () => {
    const [a] = await resolveAttachmentInputs([{ path: REAL_IMAGE, mimeType: "image/jpeg" }]);
    assert.equal(a.mimeType, "image/jpeg");
});

test("passes inline base64 data through untouched", async () => {
    const data = Buffer.from("hello").toString("base64");
    const [a] = await resolveAttachmentInputs([{ mimeType: "image/png", data, caption: "c" }]);
    assert.equal(a.data, data);
    assert.equal(a.mimeType, "image/png");
    assert.equal(a.caption, "c");
});

test("rejects an attachment carrying both data and path", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: REAL_IMAGE, data: "abc", mimeType: "image/png" }]),
        (err: unknown) => err instanceof AttachmentValidationError && /exactly one/.test((err as Error).message),
    );
});

test("rejects an invalid file:// URL with a clear validation error", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: "file://%%not-a-url" }]),
        (err: unknown) => err instanceof AttachmentValidationError && /Invalid file:\/\/ URL/.test((err as Error).message),
    );
});

test("rejects a missing file", async () => {
    const missing = path.join(os.tmpdir(), `gemdex-missing-${Date.now()}.png`);
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: missing }]),
        (err: unknown) => err instanceof AttachmentValidationError && /file not found/.test((err as Error).message),
    );
});

test("rejects a path with an unknown extension and no explicit mimeType", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-att-"));
    // .gif is intentionally unsupported (unlike .txt/.jsonl which map to blob-only file).
    const file = path.join(tmp, "notes.gif");
    fs.writeFileSync(file, "hi");
    try {
        await assert.rejects(
            () => resolveAttachmentInputs([{ path: file }]),
            (err: unknown) => err instanceof AttachmentValidationError && /could not infer mimeType/.test((err as Error).message),
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("rejects an oversized file via stat before reading", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-att-"));
    const file = path.join(tmp, "big.png");
    // One byte over the 20 MiB per-attachment ceiling; sparse so the test stays fast.
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    try {
        await assert.rejects(
            () => resolveAttachmentInputs([{ path: file }]),
            (err: unknown) => err instanceof AttachmentValidationError && /per-attachment limit/.test((err as Error).message),
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("resolves a directory path to a not-a-file error", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-att-"));
    try {
        await assert.rejects(
            () => resolveAttachmentInputs([{ path: tmp, mimeType: "image/png" }]),
            (err: unknown) => err instanceof AttachmentValidationError && /is not a file/.test((err as Error).message),
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
