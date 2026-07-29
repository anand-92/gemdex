import * as http from 'http';
import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    Embedding,
    handleMemoryApiRequest,
    sendJson,
    ServerVersionInfo,
    SUPPORTED_API_VERSION,
    SUPPORTED_PROTOCOL_VERSION,
} from 'gemdex-core';
import type { MemoryBackend } from 'gemdex-core';
import type { ServerConfig } from './config.js';
import { createBlobStore } from './blob-store.js';
import { createServerEmbedding } from './embedding.js';
import {
    createPostgresPool,
    DatabasePool,
    migrateDatabase,
    PostgresMemoryBackend,
} from './postgres.js';
import {
    handleSessionIngestRequest,
    SESSION_INGEST_PATH,
    type SessionIngestOptions,
} from './session-ingest.js';

// Read the version from package.json so it never drifts from the published
// version. createRequire works in ESM and resolves relative to this module
// (dist/server.js → ../package.json, and src/server.ts under tsx).
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json') as { version: string };

// The oldest gemdex client this server will accept. This is a deliberate
// compatibility floor, NOT the server's own version: it changes only when a
// release intentionally drops support for older clients, so it stays a literal
// rather than tracking package.json (which would reject every older-but-still-
// compatible client on each version bump).
const MIN_CLIENT_VERSION = '0.3.0';

const VERSION_INFO: ServerVersionInfo = {
    name: 'gemdex-server',
    apiVersion: SUPPORTED_API_VERSION,
    serverVersion: SERVER_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    capabilities: {
        attachments: true,
        recallAttachments: true,
        importExport: true,
        // Host-side clean+digest of uploaded chat sessions
        // (POST /v1/sessions/ingest). Advertised so the web manager can hide
        // its upload view against an older server rather than surfacing a 404.
        sessionIngest: true,
        auth: ['bearer'],
    },
};

export interface CreateServerOptions {
    store?: MemoryBackend | null;
    /** Bearer token required for all data routes. */
    token?: string;
    /** Explicit local/dev escape hatch for starting without auth. Never enable for exposed deployments. */
    unsafeDevNoAuth?: boolean;
    /** Browser origins allowed to read data-route responses. Empty means browser cross-origin access is denied. */
    allowedOrigins?: string[];
    /**
     * Gemini settings the session-ingest route needs to digest uploaded
     * transcripts. Absent means that one route answers 503 while the rest of
     * `/v1` is unaffected.
     */
    sessionIngest?: Pick<ServerConfig, 'geminiApiKey' | 'geminiBaseUrl'>;
    /** Injectable digester factory so route tests never call Gemini. */
    createSessionDigester?: SessionIngestOptions['createDigester'];
}

export interface ConfiguredStoreDependencies {
    pool?: DatabasePool;
    embedding?: Embedding;
    usePgVectorQueries?: boolean;
}

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';

function normalizeOrigins(origins: string[] | undefined): Set<string> {
    // Strip trailing slashes so a configured origin like
    // "https://app.example.com/" matches the browser-sent Origin header
    // ("https://app.example.com"), which never includes a trailing slash.
    return new Set((origins ?? []).map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean));
}

function buildServerCorsHeaders(req: http.IncomingMessage, allowedOrigins: Set<string>): Record<string, string> {
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Allow-Credentials': 'false',
    };
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function isCorsOriginAllowed(req: http.IncomingMessage, allowedOrigins: Set<string>): boolean {
    const origin = req.headers.origin;
    return typeof origin !== 'string' || allowedOrigins.has(origin);
}

function hasValidBearerToken(req: http.IncomingMessage, token: string | undefined): boolean {
    if (!token) return false;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const supplied = Buffer.from(match[1], 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Build the HTTP server. Health and version routes are always available.
 * Memory routes under /v1/* answer 503 until a store is injected.
 */
export function createServer({
    store = null,
    token,
    unsafeDevNoAuth = false,
    allowedOrigins = [],
    sessionIngest = {},
    createSessionDigester,
}: CreateServerOptions): http.Server {
    const normalizedAllowedOrigins = normalizeOrigins(allowedOrigins);
    return http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = buildServerCorsHeaders(req, normalizedAllowedOrigins);

        if (method === 'OPTIONS') {
            if (!isCorsOriginAllowed(req, normalizedAllowedOrigins)) {
                sendJson(res, 403, { error: 'Origin not allowed' }, corsHeaders);
                return;
            }
            res.writeHead(204, {
                'Allow': ALLOW_METHODS,
                ...corsHeaders,
            });
            res.end();
            return;
        }

        try {
            // GET /v1/health — unauthenticated readiness probe.
            if (method === 'GET' && pathname === '/v1/health') {
                sendJson(res, 200, { ok: true }, corsHeaders);
                return;
            }

            // GET /v1/version — unauthenticated compatibility metadata.
            if (method === 'GET' && pathname === '/v1/version') {
                sendJson(res, 200, VERSION_INFO, corsHeaders);
                return;
            }

            // All /v1/* memory routes require an allowed browser origin, auth,
            // and a configured backend. Health/version above are intentionally
            // unauthenticated and safe to expose.
            if (pathname.startsWith('/v1/')) {
                if (!isCorsOriginAllowed(req, normalizedAllowedOrigins)) {
                    sendJson(res, 403, { error: 'Origin not allowed' }, corsHeaders);
                    return;
                }
                if (!unsafeDevNoAuth && !hasValidBearerToken(req, token)) {
                    sendJson(res, 401, { error: 'Unauthorized' }, corsHeaders);
                    return;
                }
                if (store === null) {
                    sendJson(res, 503, { error: 'No memory backend configured' }, corsHeaders);
                    return;
                }

                // Session ingest is handled here, not by core's shared router:
                // it is the one /v1 route that does Gemini digestion rather
                // than pure storage, and the sidecar that mounts that router
                // has its own folder-scanning ingest routes instead. Matched
                // before the prefix strip so it cannot collide with a memory id.
                if (pathname === SESSION_INGEST_PATH) {
                    await handleSessionIngestRequest(req, res, {
                        store,
                        config: sessionIngest,
                        corsHeaders,
                        ...(createSessionDigester && { createDigester: createSessionDigester }),
                    });
                    return;
                }

                // Strip the /v1 prefix and delegate to the shared memory API
                // handler. Mutate req.url in place (idiomatic mount-path
                // stripping) rather than wrapping req in a prototype proxy —
                // the handler streams the body off the real request object.
                req.url = req.url?.replace(/^\/v1/, '') ?? '/';

                const handled = await handleMemoryApiRequest(req, res, {
                    store,
                    corsHeaders,
                });
                if (!handled) {
                    sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
                }
                return;
            }

            sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
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
            console.error('[server] request error:', error);
            sendJson(res, 500, { error: message }, corsHeaders);
        }
    });
}

/**
 * Build the durable backend from server-owned infrastructure and embedding
 * configuration. Dependencies are injectable so route tests never call Gemini
 * or require a real Postgres service.
 */
export async function createConfiguredStore(
    config: ServerConfig,
    dependencies: ConfiguredStoreDependencies = {},
): Promise<MemoryBackend | null> {
    if (!config.databaseUrl && !dependencies.pool) return null;
    const pool = dependencies.pool ?? createPostgresPool(config.databaseUrl!);
    const ownsPool = dependencies.pool === undefined;
    try {
        await migrateDatabase(pool);
    } catch (error) {
        if (ownsPool) await pool.end().catch(() => undefined);
        throw error;
    }
    return new PostgresMemoryBackend({
        pool,
        blobStore: createBlobStore(config.blobStore),
        blobStorageProvider: config.blobStore.kind,
        embedding: dependencies.embedding ?? createServerEmbedding(config),
        usePgVectorQueries: dependencies.usePgVectorQueries,
    });
}

/**
 * Start the server and log the bound address.
 */
export async function startServer(
    config: ServerConfig,
    store?: MemoryBackend | null,
    dependencies: ConfiguredStoreDependencies = {},
): Promise<http.Server> {
    let resolvedStore = store ?? null;
    if (!resolvedStore && (config.databaseUrl || dependencies.pool)) {
        resolvedStore = await createConfiguredStore(config, dependencies);
    }

    return new Promise((resolve) => {
        const server = createServer({
            store: resolvedStore,
            token: config.token,
            unsafeDevNoAuth: config.unsafeDevNoAuth,
            allowedOrigins: config.allowedOrigins,
            sessionIngest: {
                ...(config.geminiApiKey !== undefined && { geminiApiKey: config.geminiApiKey }),
                ...(config.geminiBaseUrl !== undefined && { geminiBaseUrl: config.geminiBaseUrl }),
            },
        });
        server.listen(config.port, config.host, () => {
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : config.port;
            console.error(`[gemdex-server] Listening on http://${config.host}:${boundPort}`);
            resolve(server);
        });
    });
}
