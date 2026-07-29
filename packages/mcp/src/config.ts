import { createRequire } from "node:module";
import {
    EnvGetter,
    GemdexMode,
    ResolvedRemoteConnection,
    envManager,
    loadRemoteConfig,
    resolveMode,
    resolveRemoteConnection,
} from "gemdex-core";

// Read the version from this package's package.json so it never drifts from the
// published version. createRequire resolves relative to this module
// (dist/config.js → ../package.json, and src/config.ts under tsx).
const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json") as { version: string };

export interface GemdexConfig {
    name: string;
    version: string;
    embeddingModel: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    lancedbPath?: string;
    mode: GemdexMode;
    remoteName?: string;
    remote?: ResolvedRemoteConnection;
}

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2';
const defaultEnvGetter: EnvGetter = (name: string) => envManager.get(name);

export function getEmbeddingModel(getEnv: EnvGetter = defaultEnvGetter): string {
    return getEnv('EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL;
}

export function createConfig(getEnv: EnvGetter = defaultEnvGetter): GemdexConfig {
    const mode = resolveMode(getEnv);
    const remoteConfig = mode === 'remote' ? loadRemoteConfig(getEnv) : null;
    return {
        name: getEnv('MCP_SERVER_NAME') || "Gemdex Memory MCP",
        version: getEnv('MCP_SERVER_VERSION') || PACKAGE_VERSION,
        embeddingModel: getEmbeddingModel(getEnv),
        geminiApiKey: getEnv('GEMINI_API_KEY'),
        geminiBaseUrl: getEnv('GEMINI_BASE_URL'),
        lancedbPath: getEnv('LANCEDB_PATH'),
        mode,
        ...(remoteConfig && { remoteName: remoteConfig.name }),
        ...(mode === 'remote' && { remote: resolveRemoteConnection(getEnv) }),
    };
}

export function logConfigurationSummary(config: GemdexConfig): void {
    console.log(`[MCP] 🧠 Starting Gemdex Memory MCP Server`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Mode: ${config.mode}`);
    if (config.mode === 'remote') {
        console.log(`[MCP]   Remote: ${config.remoteName ?? 'gemdex-remote'} (${config.remote?.url})`);
        console.log(`[MCP]   Embedding: managed by remote Gemdex Server`);
        return;
    }
    console.log(`[MCP]   Embedding: Gemini / ${config.embeddingModel}`);
    console.log(`[MCP]   Gemini API Key: ${config.geminiApiKey ? '✅ Configured' : '❌ Missing'}`);
    if (config.geminiBaseUrl) console.log(`[MCP]   Gemini Base URL: ${config.geminiBaseUrl}`);
    console.log(`[MCP]   LanceDB Path: ${config.lancedbPath || '[default: ~/.gemdex/lance]'}`);
}

export function showHelpMessage(): void {
    console.log(`
Gemdex — memory layer for AI coding agents (Gemini embeddings + LanceDB)

Usage:
  npx gemdex-mcp@latest            Start the MCP server (stdio) exposing
                                   save_memory, recall, update_memory.
  npx gemdex serve [--port N]      Start the localhost HTTP sidecar that backs
                                   the desktop manager app. --port 0 picks a
                                   free port.
  npx gemdex init-remote <name> <url> [--import-local]
                                   One-shot client setup for a BYOI server:
                                   store the remote + token, verify it's
                                   reachable/authenticated/compatible, switch to
                                   remote mode, and (optionally) import the local
                                   memories. The easiest way to connect a client.
  npx gemdex remote add <name> <url>
                                   Add a named remote and securely prompt for
                                   its bearer token.
  npx gemdex remote list           List configured remotes.
  npx gemdex remote status [name]  Check health and authentication.
  npx gemdex mode local            Use the embedded local backend.
  npx gemdex mode remote <name>    Use a configured remote backend.
  npx gemdex import-local-to-remote [name]
                                   Copy local memories to a remote by id.
  npx gemdex ingest-history [--source claude|factory|codex|antigravity|PATH]... [--model MODEL]
                            [--batch] [--dry-run] [--collect]
                                   Distill coding-agent chat history (Claude
                                   Code / Factory CLI / Codex / Antigravity)
                                   into one searchable memory per session.
                                   --dry-run shows the scan + cost estimate;
                                   --batch uses the Gemini Batch API (50%
                                   cost), collected later via --collect.
  npx gemdex sync-history [--url https://host/mcp] [--source ...]...
                                   Same as ingest-history, but upserts each
                                   digest into a REMOTE self-hosted host's pool
                                   over its OAuth-protected /mcp endpoint. Run
                                   on every coding machine; authorizes once in
                                   a browser. --logout forgets the credentials.

Optional:
  GEMDEX_MODE             local (default) or remote.
  GEMINI_API_KEY          Required in local mode for save/recall/update.
  EMBEDDING_MODEL         Gemini model name (default: gemini-embedding-2).
                          Supported: gemini-embedding-2, gemini-embedding-001.
  EMBEDDING_DIMENSION     Override the embedding output dimension.
  GEMINI_BASE_URL         Custom Gemini base URL.
  HYBRID_MODE             true|false (default: true). false = dense-only recall.
  LANCEDB_PATH            Filesystem path for the embedded LanceDB store
                          (default: ~/.gemdex/lance). Holds the single global
                          memory store.
  GEMDEX_REMOTE_URL       Gemdex Server root URL, required in remote mode.
  GEMDEX_REMOTE_TOKEN     Server bearer token, required in remote mode by default.
  GEMDEX_REMOTE_TOKEN_ENV_VAR
                          Alternate env var containing the remote bearer token.
  GEMDEX_REMOTE_NAME      Optional human-readable remote name.
  GEMDEX_SYNC_URL         Host /mcp endpoint used by 'gemdex sync-history'
                          (https required off-loopback).
  GEMDEX_SERVE_PORT       Default port for 'gemdex serve' (default: auto/0).
        `);
}
