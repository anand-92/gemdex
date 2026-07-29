import * as http from "http";
import * as crypto from "crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    attachTranscriptToRecord,
    HygieneManager,
    HygieneReport,
    HygieneReportStore,
    IngestManager,
    IngestSourceFolder,
    LocalMemoryBackend,
    MemoryBackend,
    MemoryStore,
    RemoteMemoryBackend,
    envManager,
} from "gemdex-core";
import {
    DIGEST_MODELS,
    DEFAULT_DIGEST_MODEL,
    DIGEST_PRICING_AS_OF,
    antigravityPresetFolder,
    buildCorsHeaders,
    claudePresetFolder,
    codexPresetFolder,
    discoverSessionFiles,
    factoryPresetFolder,
    handleMemoryApiRequest,
    readBody,
    sendJson,
} from "gemdex-core";
import { ClientConfigStore, StoredRemote, tokenEnvVarForRemote } from "./cli-config.js";
import { createConfig, GemdexConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createEmbeddingInstance } from "./embedding.js";
import { createMemoryBackend } from "./memory.js";

/** Read a string field from a parsed JSON body, trimmed; '' when absent or non-string. */
function trimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Mutable server context. The sidecar boots even when no GEMINI_API_KEY is
 * configured yet (a .app launched from Finder doesn't inherit the user's
 * interactive shell env), so the desktop app can prompt for the key and POST
 * it to /config. Until then `store` is null and the data routes answer 503.
 */
export interface ServeContext {
    config: GemdexConfig;
    store: MemoryBackend | null;
    clientConfigStore?: ClientConfigStore;
    createBackend?: (config: GemdexConfig) => MemoryBackend;
    fetch?: typeof fetch;
    /**
     * When set, the server enforces two security controls:
     *  1. `Origin` header on every non-OPTIONS request must match this value
     *     (or be absent — a same-origin WebView request has no Origin header).
     *  2. Every data route (all routes except /health, /config*, and
     *     OPTIONS pre-flight) must carry `X-Gemdex-Token: <token>`.
     *
     * Both values are minted per-launch by `runServe` and handed to the
     * WebView via the Zig shell's `gemdex.getApiBase` bridge command. The
     * desktop app embeds them in every fetch call; external pages cannot
     * obtain them through normal browser APIs, so cross-origin requests are
     * effectively blocked even without relying on the browser's CORS
     * enforcement (which is the attacker-controlled layer).
     */
    allowedOrigin?: string;
    token?: string;
    /** Lazily created chat-history ingestion orchestrator. */
    ingestManager?: IngestManager;
    /** The Gemini key the current ingest manager was built with. */
    ingestManagerKey?: string;
    /** Lazily created memory-hygiene orchestrator. */
    hygieneManager?: HygieneManager;
    /** The Gemini key the current hygiene manager was built with. */
    hygieneManagerKey?: string;
    /** Per-launch proof that the configured Gemini key can perform embedding work. */
    geminiReadiness?: GeminiReadiness;
    /** In-flight validation for the currently configured key. */
    geminiValidation?: Promise<void>;
    /** Injectable validation probe for tests. */
    validateGeminiKey?: (config: GemdexConfig) => Promise<void>;
}

function buildStore(
    config: GemdexConfig,
    createBackend: (config: GemdexConfig) => MemoryBackend = createMemoryBackend,
): MemoryBackend | null {
    if (config.mode === 'local' && !config.geminiApiKey) return null;
    return createBackend(config);
}

export type GeminiReadinessStatus = 'missing' | 'checking' | 'valid' | 'invalid' | 'unavailable';

export interface GeminiReadiness {
    status: GeminiReadinessStatus;
    message?: string;
    validatedAt?: number;
    keyFingerprint?: string;
}

const GEMINI_VALIDATION_TIMEOUT_MS = 12_000;
const GEMINI_VALIDATION_TEXT = 'Gemdex API key readiness check';

function configuredGeminiKey(ctx: ServeContext): string | undefined {
    const trimmed = ctx.config.geminiApiKey?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function keyFingerprint(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function publicGeminiReadiness(ctx: ServeContext): Omit<GeminiReadiness, 'keyFingerprint'> {
    const key = configuredGeminiKey(ctx);
    if (!key) return { status: 'missing', message: 'Add a Gemini API key to continue.' };
    const readiness = ctx.geminiReadiness;
    if (!readiness || readiness.keyFingerprint !== keyFingerprint(key)) {
        return { status: 'checking', message: 'Gemini API key validation has not completed.' };
    }
    return {
        status: readiness.status,
        ...(readiness.message && { message: readiness.message }),
        ...(readiness.validatedAt !== undefined && { validatedAt: readiness.validatedAt }),
    };
}

function classifyGeminiValidationError(error: unknown): GeminiReadiness {
    const raw = errorMessage(error);
    const normalized = raw.toLowerCase();
    const unavailable = normalized.includes('timed out')
        || normalized.includes('timeout')
        || normalized.includes('network')
        || normalized.includes('fetch failed')
        || normalized.includes('econn')
        || normalized.includes('enotfound')
        || normalized.includes('temporarily unavailable')
        || normalized.includes('service unavailable')
        || normalized.includes('429')
        || normalized.includes('resource_exhausted');
    if (unavailable) {
        return {
            status: 'unavailable',
            message: `Gemini could not be reached to validate this key. ${raw}`,
        };
    }
    return {
        status: 'invalid',
        message: `Gemini rejected this API key. ${raw}`,
    };
}

async function defaultValidateGeminiKey(config: GemdexConfig): Promise<void> {
    const embedding = createEmbeddingInstance(config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            embedding.embed(GEMINI_VALIDATION_TEXT),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Gemini validation timed out after ${GEMINI_VALIDATION_TIMEOUT_MS / 1000} seconds.`)),
                    GEMINI_VALIDATION_TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function validateGeminiKey(ctx: ServeContext, apiKey: string): Promise<GeminiReadiness> {
    const fingerprint = keyFingerprint(apiKey);
    const candidateConfig = { ...ctx.config, geminiApiKey: apiKey };
    try {
        await (ctx.validateGeminiKey ?? defaultValidateGeminiKey)(candidateConfig);
        return { status: 'valid', validatedAt: Date.now(), keyFingerprint: fingerprint };
    } catch (error) {
        return { ...classifyGeminiValidationError(error), keyFingerprint: fingerprint };
    }
}

function startConfiguredKeyValidation(ctx: ServeContext): void {
    const apiKey = configuredGeminiKey(ctx);
    if (!apiKey) {
        ctx.geminiReadiness = { status: 'missing' };
        ctx.geminiValidation = undefined;
        return;
    }
    const fingerprint = keyFingerprint(apiKey);
    // Reuse an in-flight validation for the same key so concurrent retries
    // cannot resolve out of order and clobber a newer result.
    if (ctx.geminiValidation && ctx.geminiReadiness?.keyFingerprint === fingerprint) {
        return;
    }
    ctx.geminiReadiness = {
        status: 'checking',
        message: 'Validating the saved Gemini API key…',
        keyFingerprint: fingerprint,
    };
    // Reserve the slot synchronously before any async work so two concurrent
    // first-starts cannot both pass the in-flight check above.
    let settle!: () => void;
    const validation = new Promise<void>((resolve) => { settle = resolve; });
    ctx.geminiValidation = validation;
    void validateGeminiKey(ctx, apiKey)
        .then((readiness) => {
            if (configuredGeminiKey(ctx) === apiKey && ctx.geminiValidation === validation) {
                ctx.geminiReadiness = readiness;
            }
        })
        .finally(() => {
            if (ctx.geminiValidation === validation) ctx.geminiValidation = undefined;
            settle();
        });
}

async function waitForConfiguredKeyValidation(ctx: ServeContext): Promise<void> {
    if (!ctx.geminiValidation) startConfiguredKeyValidation(ctx);
    await ctx.geminiValidation;
}

function geminiIsReady(ctx: ServeContext): boolean {
    return publicGeminiReadiness(ctx).status === 'valid';
}

/** Persist a validated key, expose it to this process, and rebuild the local store. */
function configureApiKey(ctx: ServeContext, apiKey: string, readiness: GeminiReadiness): void {
    envManager.set('GEMINI_API_KEY', apiKey);
    process.env['GEMINI_API_KEY'] = apiKey;
    ctx.config = {
        ...ctx.config,
        geminiApiKey: apiKey,
    };
    // Drop any in-flight validation so a stale resolve cannot overwrite this result.
    ctx.geminiValidation = undefined;
    ctx.geminiReadiness = readiness;
    // The ingest manager is rebuilt lazily when its recorded key goes stale
    // (see ingestManager()), so an in-flight run keeps its manager while any
    // later run picks up the new key.
    if (ctx.config.mode === 'local') {
        ctx.store = buildStore(ctx.config, ctx.createBackend);
    }
}

interface DesktopRemoteSummary extends StoredRemote {
    name: string;
    hasToken: boolean;
}

interface DesktopSettingsSummary {
    mode: 'local' | 'remote';
    activeRemote?: string;
    configured: boolean;
    localConfigured: boolean;
    gemini: Omit<GeminiReadiness, 'keyFingerprint'>;
    remotes: DesktopRemoteSummary[];
}

interface DesktopConfigSummary {
    configured: boolean;
    mode: 'local' | 'remote';
    needsKey: boolean;
    gemini: Omit<GeminiReadiness, 'keyFingerprint'>;
    activeRemote?: Pick<DesktopRemoteSummary, 'name' | 'url' | 'hasToken'>;
}

function clientConfigStore(ctx: ServeContext): ClientConfigStore {
    ctx.clientConfigStore ??= new ClientConfigStore();
    return ctx.clientConfigStore;
}

function createBackend(ctx: ServeContext, config: GemdexConfig): MemoryBackend {
    return (ctx.createBackend ?? createMemoryBackend)(config);
}

function localConfig(ctx: ServeContext): GemdexConfig {
    return {
        ...ctx.config,
        mode: 'local',
        geminiApiKey: ctx.config.geminiApiKey ?? envManager.get('GEMINI_API_KEY'),
        remoteName: undefined,
        remote: undefined,
    };
}

function resolveStoredRemote(
    ctx: ServeContext,
    name: string,
): { remote: StoredRemote; token: string } {
    const configStore = clientConfigStore(ctx);
    const remote = configStore.get(name);
    if (!remote) throw new Error(`Remote "${name}" is not configured.`);
    const token = configStore.getEnv(remote.tokenEnvVar)?.trim();
    if (!token) throw new Error(`Remote "${name}" does not have a configured bearer token.`);
    return { remote, token };
}

function remoteConfig(ctx: ServeContext, name: string): GemdexConfig {
    const { remote, token } = resolveStoredRemote(ctx, name);
    return {
        ...ctx.config,
        mode: 'remote',
        remoteName: name,
        remote: { url: remote.url, token },
    };
}

function settingsSummary(ctx: ServeContext): DesktopSettingsSummary {
    const configStore = clientConfigStore(ctx);
    const gemini = publicGeminiReadiness(ctx);
    const configured = ctx.config.mode === 'local'
        ? ctx.store !== null && gemini.status === 'valid'
        : ctx.store !== null;
    return {
        mode: ctx.config.mode,
        ...(ctx.config.mode === 'remote' && ctx.config.remoteName && { activeRemote: ctx.config.remoteName }),
        configured,
        localConfigured: gemini.status === 'valid',
        gemini,
        remotes: configStore.list().map((remote) => ({
            ...remote,
            hasToken: Boolean(configStore.getEnv(remote.tokenEnvVar)?.trim()),
        })),
    };
}

function activeRemoteSummary(ctx: ServeContext): Pick<DesktopRemoteSummary, 'name' | 'url' | 'hasToken'> | undefined {
    if (ctx.config.mode !== 'remote' || !ctx.config.remoteName) return undefined;
    const configStore = clientConfigStore(ctx);
    const remote = configStore.get(ctx.config.remoteName);
    const url = remote?.url ?? ctx.config.remote?.url;
    if (!url) return undefined;
    return {
        name: ctx.config.remoteName,
        url,
        hasToken: Boolean(remote
            ? configStore.getEnv(remote.tokenEnvVar)?.trim()
            : ctx.config.remote?.token.trim()),
    };
}

function configSummary(ctx: ServeContext): DesktopConfigSummary {
    const activeRemote = activeRemoteSummary(ctx);
    const gemini = publicGeminiReadiness(ctx);
    const configured = ctx.config.mode === 'local'
        ? ctx.store !== null && gemini.status === 'valid'
        : ctx.store !== null;
    return {
        configured,
        mode: ctx.config.mode,
        needsKey: ctx.config.mode === 'local' && gemini.status !== 'valid',
        gemini,
        ...(activeRemote && { activeRemote }),
    };
}

async function testRemoteConnection(
    ctx: ServeContext,
    name: string,
): Promise<{ reachable: boolean; authenticated: boolean; detail?: string }> {
    const { remote, token } = resolveStoredRemote(ctx, name);
    try {
        const response = await (ctx.fetch ?? fetch)(`${remote.url}/v1/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return {
                reachable: false,
                authenticated: false,
                detail: `Health check returned HTTP ${response.status}.`,
            };
        }
    } catch (error) {
        return {
            reachable: false,
            authenticated: false,
            detail: errorMessage(error),
        };
    }

    try {
        await new RemoteMemoryBackend({ url: remote.url, token, fetch: ctx.fetch }).list();
        return { reachable: true, authenticated: true };
    } catch (error) {
        return {
            reachable: true,
            authenticated: false,
            detail: errorMessage(error),
        };
    }
}

async function migrateLocalToRemote(
    ctx: ServeContext,
    name: string,
): Promise<{ created: number; updated: number; skipped: number }> {
    const sourceConfig = localConfig(ctx);
    if (!sourceConfig.geminiApiKey) {
        throw new Error('Configure GEMINI_API_KEY before importing local memories.');
    }
    const local = ctx.config.mode === 'local' && ctx.store
        ? ctx.store
        : createBackend(ctx, sourceConfig);
    const targetConfig = remoteConfig(ctx, name);
    const remote = ctx.config.mode === 'remote' && ctx.config.remoteName === name && ctx.store
        ? ctx.store
        : createBackend(ctx, targetConfig);
    const records = await local.exportAll();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const record of records) {
        try {
            // Prefer attaching full transcripts when digests only have a path footer
            // so remote clients can fetch bytes via read_attachment / HTTP.
            const prepared = attachTranscriptToRecord(record).record;
            const existed = await remote.get(prepared.id) !== null;
            const result = await remote.importRecords([prepared]);
            if (result.imported !== 1) {
                skipped += 1;
            } else if (existed) {
                updated += 1;
            } else {
                created += 1;
            }
        } catch {
            skipped += 1;
        }
    }
    return { created, updated, skipped };
}

/**
 * The Gemini key used for digesting transcripts. Digestion always runs
 * client-side (the BYOI server only embeds), so ingestion needs a local key
 * even when the memory backend is remote.
 */
function ingestApiKey(ctx: ServeContext): string {
    const key = configuredGeminiKey(ctx);
    if (!key) {
        throw new Error('Chat-history ingestion needs a local GEMINI_API_KEY (digests are generated client-side).');
    }
    if (!geminiIsReady(ctx)) {
        throw new Error('Chat-history ingestion is blocked until the Gemini API key is validated.');
    }
    return key;
}

function ingestManager(ctx: ServeContext): IngestManager {
    const key = ingestApiKey(ctx);
    // Rebuild on key change, but never yank the manager out from under a
    // live run — that run already holds its digester.
    if (ctx.ingestManager && ctx.ingestManagerKey !== key && !ctx.ingestManager.isRunning()) {
        ctx.ingestManager = undefined;
    }
    if (!ctx.ingestManager) {
        ctx.ingestManager = new IngestManager({
            apiKey: key,
            geminiBaseUrl: ctx.config.geminiBaseUrl,
        });
        ctx.ingestManagerKey = key;
    }
    return ctx.ingestManager;
}

/**
 * The Gemini key used for hygiene cluster judging. Judging always runs
 * client-side (the BYOI server only embeds), so hygiene needs a local key
 * even when the memory backend is remote.
 */
function hygieneApiKey(ctx: ServeContext): string {
    const key = configuredGeminiKey(ctx);
    if (!key) {
        throw new Error('Memory hygiene needs a local GEMINI_API_KEY (cluster judging runs client-side).');
    }
    if (!geminiIsReady(ctx)) {
        throw new Error('Memory hygiene is blocked until the Gemini API key is validated.');
    }
    return key;
}

function hygieneManager(ctx: ServeContext): HygieneManager {
    const key = hygieneApiKey(ctx);
    // Rebuild on key change, but never yank the manager out from under a
    // live run — that run already holds its judge.
    if (ctx.hygieneManager && ctx.hygieneManagerKey !== key && !ctx.hygieneManager.isRunning()) {
        ctx.hygieneManager = undefined;
    }
    if (!ctx.hygieneManager) {
        ctx.hygieneManager = new HygieneManager({
            apiKey: key,
            geminiBaseUrl: ctx.config.geminiBaseUrl,
        });
        ctx.hygieneManagerKey = key;
    }
    return ctx.hygieneManager;
}

/** Hygiene is local-only in v1: clustering reads vectors straight out of LanceDB. */
function localStore(ctx: ServeContext): MemoryStore {
    if (!(ctx.store instanceof LocalMemoryBackend)) {
        throw new Error('Memory hygiene requires local storage mode (remote hygiene is not supported yet).');
    }
    return ctx.store.getStore();
}

/**
 * The persisted hygiene report, readable without a validated Gemini key —
 * browsing past results is read-only. Falls back to reading the report file
 * directly when the manager cannot be built (missing/unvalidated key).
 */
function hygieneReport(ctx: ServeContext): HygieneReport | null {
    try {
        return hygieneManager(ctx).getReport();
    } catch {
        return new HygieneReportStore().getReport() ?? null;
    }
}

function hygieneReportSummary(ctx: ServeContext): unknown {
    return {
        report: hygieneReport(ctx),
        models: Object.entries(DIGEST_MODELS).map(([model, info]) => ({
            model,
            description: info.description,
            inputUsdPerMTok: info.inputUsdPerMTok,
            outputUsdPerMTok: info.outputUsdPerMTok,
            isDefault: model === DEFAULT_DIGEST_MODEL,
        })),
        pricingAsOf: DIGEST_PRICING_AS_OF,
        hygieneReady: geminiIsReady(ctx),
    };
}

/** Validate a JSON body field as a non-empty array of non-empty strings. */
function stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length === 0
        || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        throw new Error(`'${field}' must be a non-empty array of strings.`);
    }
    return value;
}

/**
 * Resolve the request's `sources` array into scan folders. Presets resolve to
 * their well-known dot-folders; custom entries must carry an absolute path.
 */
function resolveIngestFolders(ctx: ServeContext, sources: unknown): IngestSourceFolder[] {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error("'sources' must be a non-empty array.");
    }
    const folders: IngestSourceFolder[] = [];
    for (const entry of sources) {
        const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const source = record.source;
        if (source === 'claude') {
            folders.push(claudePresetFolder());
        } else if (source === 'factory') {
            folders.push(factoryPresetFolder());
        } else if (source === 'codex') {
            folders.push(codexPresetFolder());
        } else if (source === 'antigravity') {
            folders.push(antigravityPresetFolder());
        } else if (source === 'custom') {
            const folderPath = trimmedString(record.path);
            if (!folderPath || !path.isAbsolute(folderPath)) {
                throw new Error("Custom sources require an absolute 'path'.");
            }
            folders.push({ source: 'custom', path: folderPath });
        } else {
            throw new Error("Each source must be 'claude', 'factory', 'codex', 'antigravity', or 'custom'.");
        }
    }
    return folders;
}

function folderSummary(folder: IngestSourceFolder): { source: string; path: string; exists: boolean; sessionCount: number } {
    const exists = fs.existsSync(folder.path);
    return {
        source: folder.source,
        path: folder.path,
        exists,
        sessionCount: exists ? discoverSessionFiles([folder]).length : 0,
    };
}

function ingestSourcesSummary(ctx: ServeContext): unknown {
    const configStore = clientConfigStore(ctx);
    return {
        presets: [claudePresetFolder(), factoryPresetFolder(), codexPresetFolder(), antigravityPresetFolder()]
            .map(folderSummary),
        customFolders: configStore.listIngestFolders()
            .map((folderPath) => folderSummary({ source: 'custom', path: folderPath })),
        models: Object.entries(DIGEST_MODELS).map(([model, info]) => ({
            model,
            description: info.description,
            inputUsdPerMTok: info.inputUsdPerMTok,
            outputUsdPerMTok: info.outputUsdPerMTok,
            isDefault: model === DEFAULT_DIGEST_MODEL,
        })),
        pricingAsOf: DIGEST_PRICING_AS_OF,
        ingestReady: geminiIsReady(ctx),
        gemini: publicGeminiReadiness(ctx),
    };
}

/**
 * `gemdex serve` — the localhost HTTP/JSON sidecar that backs the desktop
 * manager app. It wraps the same gemdex-core MemoryBackend + LanceDB store the
 * MCP server uses, binds 127.0.0.1 only, and exposes the management surface
 * (no semantic search — that is MCP-only).
 *
 * Using localhost HTTP (not the Zig bridge) sidesteps the bridge's 16 KiB
 * request/response cap so a 300-line memory is never truncated.
 */

interface ServeOptions {
    port: number;
}

function parseArgs(args: string[]): ServeOptions {
    let port: number | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--port' || arg === '-p') {
            port = parseInt(args[++i], 10);
        } else if (arg.startsWith('--port=')) {
            port = parseInt(arg.slice('--port='.length), 10);
        }
    }

    if (port === undefined) {
        const fromEnv = process.env.GEMDEX_SERVE_PORT;
        port = fromEnv ? parseInt(fromEnv, 10) : 0; // 0 = OS picks a free port
    }
    if (!Number.isFinite(port) || port < 0) port = 0;

    return { port };
}

/**
 * Check whether the request's `Origin` header is acceptable.
 *
 * - If no `allowedOrigin` is configured (standalone / test mode) all origins
 *   pass so existing behaviour is preserved.
 * - If an `allowedOrigin` is configured, requests whose `Origin` header is
 *   present and does not match are rejected. Requests with *no* `Origin`
 *   header (same-origin WebView loads, CLI tools, curl) are allowed through
 *   — a browser will always set `Origin` on a cross-origin request, so the
 *   absence of the header is a reliable signal that the request is *not*
 *   coming from a foreign web page.
 */
function isOriginAllowed(req: http.IncomingMessage, allowedOrigin: string | undefined): boolean {
    if (!allowedOrigin) return true;
    const origin = req.headers['origin'];
    if (!origin) return true; // absent = same-origin or non-browser caller
    return origin === allowedOrigin;
}

/**
 * Check whether the request carries the correct app token.
 *
 * - If no token is configured all requests pass (standalone / test mode).
 * - The token must appear in the `X-Gemdex-Token` request header.
 * - The comparison is timing-safe to prevent timing oracle attacks.
 */
function isTokenValid(req: http.IncomingMessage, token: string | undefined): boolean {
    if (!token) return true;
    const provided = req.headers['x-gemdex-token'];
    if (typeof provided !== 'string' || provided.length === 0) return false;
    // Constant-time comparison to resist timing attacks.
    try {
        return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    } catch {
        // Buffers of different lengths — timingSafeEqual would throw.
        return false;
    }
}

export function createServer(ctx: ServeContext): http.Server {
    // Never mark a configured key valid without a real embedding proof. Tests that
    // need an unlocked local backend must pass an explicit validated readiness.
    if (!ctx.geminiReadiness) {
        if (configuredGeminiKey(ctx)) {
            startConfiguredKeyValidation(ctx);
        } else {
            ctx.geminiReadiness = { status: 'missing' };
        }
    }
    return http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = buildCorsHeaders(ctx.allowedOrigin);

        // Reject requests from unexpected origins before doing any work.
        if (!isOriginAllowed(req, ctx.allowedOrigin)) {
            sendJson(res, 403, { error: 'Forbidden' }, corsHeaders);
            return;
        }

        // Handle pre-flight. No token check — the browser sends OPTIONS before
        // it has a chance to include custom headers.
        if (method === 'OPTIONS') {
            sendJson(res, 204, {}, corsHeaders);
            return;
        }

        try {
            // GET /health — unauthenticated; the desktop app polls this before
            // it has a token to send (the token arrives via the bridge after
            // health resolves).
            if (method === 'GET' && pathname === '/health') {
                sendJson(res, 200, { ok: true }, corsHeaders);
                return;
            }

            // Configuration routes are intentionally excluded from the token
            // requirement: the desktop app must be able to repair a missing or
            // rejected key before data-route authentication is established.
            if (method === 'GET' && pathname === '/config') {
                sendJson(res, 200, configSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/config') {
                const body = await readBody(req);
                const apiKey = trimmedString(body?.apiKey);
                if (apiKey.length === 0) {
                    sendJson(res, 400, { error: "'apiKey' is required" }, corsHeaders);
                    return;
                }
                const readiness = await validateGeminiKey(ctx, apiKey);
                if (readiness.status !== 'valid') {
                    const status = readiness.status === 'unavailable' ? 503 : 401;
                    sendJson(res, status, {
                        error: readiness.message ?? 'Gemini API key validation failed.',
                        configured: false,
                        needsKey: true,
                        gemini: {
                            status: readiness.status,
                            ...(readiness.message && { message: readiness.message }),
                        },
                    }, corsHeaders);
                    return;
                }
                try {
                    configureApiKey(ctx, apiKey, readiness);
                    sendJson(res, 200, configSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 500, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/config/validate') {
                if (!configuredGeminiKey(ctx)) {
                    sendJson(res, 400, {
                        error: 'No Gemini API key is configured.',
                        needsKey: true,
                        gemini: { status: 'missing', message: 'Add a Gemini API key to continue.' },
                    }, corsHeaders);
                    return;
                }
                startConfiguredKeyValidation(ctx);
                await waitForConfiguredKeyValidation(ctx);
                const summary = configSummary(ctx);
                if (summary.gemini.status === 'valid') {
                    sendJson(res, 200, summary, corsHeaders);
                } else {
                    sendJson(res, 503, {
                        ...summary,
                        error: summary.gemini.message ?? 'Gemini API key validation failed.',
                        needsKey: true,
                    }, corsHeaders);
                }
                return;
            }

            // All remaining routes require a valid token when the server was
            // started with one. This prevents any page the user visits from
            // reading or mutating their memory layer via cross-origin requests.
            if (!isTokenValid(req, ctx.token)) {
                sendJson(res, 401, { error: 'Unauthorized' }, corsHeaders);
                return;
            }

            if (method === 'GET' && pathname === '/settings') {
                sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/settings/remotes') {
                const body = await readBody(req);
                const name = trimmedString(body?.name);
                const remoteUrl = trimmedString(body?.url);
                const token = trimmedString(body?.token);
                if (!name || !remoteUrl) {
                    sendJson(res, 400, { error: "'name' and 'url' are required" }, corsHeaders);
                    return;
                }
                const configStore = clientConfigStore(ctx);
                try {
                    const existing = configStore.get(name);
                    if (!existing && !token) {
                        throw new Error("'token' is required for a new remote");
                    }
                    if (existing && !token && !configStore.getEnv(existing.tokenEnvVar)?.trim()) {
                        throw new Error("'token' is required because this remote does not have one configured");
                    }
                    const tokenEnvVar = existing?.tokenEnvVar ?? tokenEnvVarForRemote(name);
                    configStore.add(name, remoteUrl, tokenEnvVar);
                    if (token) {
                        configStore.setEnv(tokenEnvVar, token);
                        process.env[tokenEnvVar] = token;
                    }
                    if (ctx.config.mode === 'remote' && ctx.config.remoteName === name) {
                        ctx.config = remoteConfig(ctx, name);
                        ctx.store = createBackend(ctx, ctx.config);
                    }
                    sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            const remoteSettingsMatch = pathname.match(/^\/settings\/remotes\/([^/]+)$/);
            if (method === 'DELETE' && remoteSettingsMatch) {
                const name = decodeURIComponent(remoteSettingsMatch[1]);
                const configStore = clientConfigStore(ctx);
                try {
                    const existing = configStore.get(name);
                    if (!configStore.remove(name)) {
                        sendJson(res, 404, { error: `Remote "${name}" is not configured.` }, corsHeaders);
                        return;
                    }
                    if (existing?.tokenEnvVar === tokenEnvVarForRemote(name)) {
                        delete process.env[existing.tokenEnvVar];
                    }
                    if (ctx.config.mode === 'remote' && ctx.config.remoteName === name) {
                        ctx.config = localConfig(ctx);
                        ctx.store = buildStore(ctx.config, ctx.createBackend);
                    }
                    sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/settings/mode') {
                const body = await readBody(req);
                const mode = trimmedString(body?.mode).toLowerCase();
                try {
                    if (mode === 'local') {
                        clientConfigStore(ctx).activateLocal();
                        ctx.config = localConfig(ctx);
                        ctx.store = buildStore(ctx.config, ctx.createBackend);
                    } else if (mode === 'remote') {
                        const name = trimmedString(body?.name);
                        if (!name) throw new Error("'name' is required for remote mode.");
                        const nextConfig = remoteConfig(ctx, name);
                        clientConfigStore(ctx).activateRemote(name);
                        ctx.config = nextConfig;
                        ctx.store = createBackend(ctx, ctx.config);
                    } else {
                        throw new Error("'mode' must be local or remote.");
                    }
                    sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/settings/test') {
                const body = await readBody(req);
                const name = typeof body?.name === 'string' ? body.name.trim() : ctx.config.remoteName ?? '';
                if (!name) {
                    sendJson(res, 400, { error: "'name' is required" }, corsHeaders);
                    return;
                }
                try {
                    sendJson(res, 200, await testRemoteConnection(ctx, name), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/settings/import-local') {
                const body = await readBody(req);
                const name = typeof body?.name === 'string' ? body.name.trim() : ctx.config.remoteName ?? '';
                if (!name) {
                    sendJson(res, 400, { error: "'name' is required" }, corsHeaders);
                    return;
                }
                try {
                    sendJson(res, 200, await migrateLocalToRemote(ctx, name), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            // Local memory operations are blocked until the configured key has
            // completed a real Gemini embedding request during this sidecar run.
            if (ctx.config.mode === 'local' && !geminiIsReady(ctx)) {
                const gemini = publicGeminiReadiness(ctx);
                sendJson(res, 503, {
                    error: gemini.message ?? 'Gemini API key validation is required.',
                    needsKey: true,
                    gemini,
                }, corsHeaders);
                return;
            }

            if (ctx.store === null) {
                sendJson(res, 503, { error: 'No memory backend configured' }, corsHeaders);
                return;
            }

            if (method === 'GET' && pathname === '/ingest/sources') {
                sendJson(res, 200, ingestSourcesSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/ingest/folders') {
                const body = await readBody(req);
                const folderPath = trimmedString(body?.path);
                try {
                    if (!folderPath) throw new Error("'path' is required");
                    clientConfigStore(ctx).addIngestFolder(folderPath);
                    sendJson(res, 200, ingestSourcesSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'DELETE' && pathname === '/ingest/folders') {
                const body = await readBody(req);
                const folderPath = trimmedString(body?.path);
                if (!folderPath) {
                    sendJson(res, 400, { error: "'path' is required" }, corsHeaders);
                    return;
                }
                clientConfigStore(ctx).removeIngestFolder(folderPath);
                sendJson(res, 200, ingestSourcesSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/ingest/scan') {
                const body = await readBody(req);
                try {
                    const folders = resolveIngestFolders(ctx, body?.sources);
                    sendJson(res, 200, ingestManager(ctx).scan(folders), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/ingest/start') {
                const body = await readBody(req);
                try {
                    const folders = resolveIngestFolders(ctx, body?.sources);
                    const model = trimmedString(body?.model) || undefined;
                    const mode = trimmedString(body?.mode) === 'batch' ? 'batch' as const : 'standard' as const;
                    const manager = ingestManager(ctx);
                    if (manager.isRunning()) {
                        sendJson(res, 409, { error: 'An ingestion run is already in progress.' }, corsHeaders);
                        return;
                    }
                    const store = ctx.store;
                    // Fire and forget: the run is polled via GET /ingest/status.
                    // Errors are captured in the manager's progress state.
                    void manager.run({ folders, model, mode }, store).catch(() => undefined);
                    sendJson(res, 200, { started: true }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'GET' && pathname === '/ingest/status') {
                try {
                    sendJson(res, 200, ingestManager(ctx).getProgress(), corsHeaders);
                } catch {
                    // No local key (remote mode) — nothing can be running.
                    sendJson(res, 200, { state: 'idle', processed: 0, failed: 0, skipped: 0, total: 0 }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/ingest/collect') {
                try {
                    sendJson(res, 200, await ingestManager(ctx).collect(ctx.store), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/ingest/cancel') {
                try {
                    const manager = ingestManager(ctx);
                    if (manager.isRunning()) {
                        manager.cancel();
                        sendJson(res, 200, { cancelled: 'run' }, corsHeaders);
                        return;
                    }
                    const cancelledBatch = await manager.cancelBatch();
                    sendJson(res, 200, { cancelled: cancelledBatch ? 'batch' : 'none' }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'GET' && pathname === '/hygiene/report') {
                sendJson(res, 200, hygieneReportSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/scan') {
                const body = await readBody(req);
                try {
                    const threshold = typeof body?.threshold === 'number' ? body.threshold : undefined;
                    sendJson(res, 200, await hygieneManager(ctx).scan(localStore(ctx), threshold), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/start') {
                const body = await readBody(req);
                try {
                    const model = trimmedString(body?.model) || undefined;
                    const threshold = typeof body?.threshold === 'number' ? body.threshold : undefined;
                    const manager = hygieneManager(ctx);
                    const store = localStore(ctx);
                    if (manager.isRunning()) {
                        sendJson(res, 409, { error: 'A hygiene run is already in progress.' }, corsHeaders);
                        return;
                    }
                    // Fire and forget: the run is polled via GET /hygiene/status.
                    // Errors are captured in the manager's progress state.
                    void manager.run({ model, threshold }, store).catch(() => undefined);
                    sendJson(res, 200, { started: true }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'GET' && pathname === '/hygiene/status') {
                try {
                    sendJson(res, 200, hygieneManager(ctx).getProgress(), corsHeaders);
                } catch {
                    // No local key (remote mode) — nothing can be running.
                    sendJson(res, 200, { state: 'idle', judged: 0, failed: 0, total: 0 }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/cancel') {
                try {
                    const manager = hygieneManager(ctx);
                    if (manager.isRunning()) {
                        manager.cancel();
                        sendJson(res, 200, { cancelled: true }, corsHeaders);
                    } else {
                        sendJson(res, 200, { cancelled: false }, corsHeaders);
                    }
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/apply') {
                const body = await readBody(req);
                try {
                    const ids = stringArray(body?.ids, 'ids');
                    sendJson(res, 200, await hygieneManager(ctx).apply(ids, ctx.store), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/dismiss') {
                const body = await readBody(req);
                try {
                    const clusterIds = stringArray(body?.clusterIds, 'clusterIds');
                    hygieneManager(ctx).dismiss(clusterIds);
                    sendJson(res, 200, { dismissed: clusterIds.length }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            const handled = await handleMemoryApiRequest(req, res, {
                store: ctx.store,
                corsHeaders,
            });
            if (!handled) {
                sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
            }
        } catch (error: any) {
            const message = error?.message ?? 'Internal error';
            if (message === 'Request body too large') {
                sendJson(res, 413, { error: message }, corsHeaders);
                return;
            }
            if (message === 'Invalid JSON body') {
                sendJson(res, 400, { error: message }, corsHeaders);
                return;
            }
            console.error('[serve] request error:', error);
            sendJson(res, 500, { error: message }, corsHeaders);
        }
    });
}

export async function runServe(args: string[]): Promise<void> {
    const { port } = parseArgs(args);
    const config = createConfig();
    // Boot even without a key; the desktop app will POST one to /config.

    // Mint a per-launch token. 32 random bytes → 64 hex characters. This is
    // handed to the WebView via the `PORT=N TOKEN=<hex>` handshake line and
    // embedded in every fetch call by the frontend. Any other page on the
    // machine cannot obtain the token without reading local process state.
    const token = crypto.randomBytes(32).toString('hex');

    // The allowed origin is the WebView's custom scheme. The zero-native shell
    // loads the frontend from `zero://app` on production and
    // `http://127.0.0.1:5173` in dev. If GEMDEX_WEBVIEW_ORIGIN is set in the
    // environment (injected by the Zig shell in a future build) we honour it;
    // otherwise we accept only `zero://app` as the production origin.
    const allowedOrigin = process.env.GEMDEX_WEBVIEW_ORIGIN ?? 'zero://app';

    const ctx: ServeContext = {
        config,
        store: buildStore(config),
        token,
        allowedOrigin,
        clientConfigStore: new ClientConfigStore(),
    };
    startConfiguredKeyValidation(ctx);
    const server = createServer(ctx);

    await new Promise<void>((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : port;
            // The shell reads this line from stdout to discover the port AND
            // the token. Format: `PORT=<n> TOKEN=<hex>` followed by a newline.
            // console.log is redirected to stderr by index.ts, so write the
            // machine-readable handshake line directly to the real stdout.
            process.stdout.write(`PORT=${boundPort} TOKEN=${token}\n`);
            console.error(`[serve] Gemdex sidecar listening on http://127.0.0.1:${boundPort}`);
            resolve();
        });
    });

    const shutdown = () => {
        console.error('[serve] shutting down sidecar...');
        server.close(() => process.exit(0));
        // Force-exit if close hangs on keep-alive sockets.
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
