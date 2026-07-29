import * as fs from 'node:fs';
import {
    attachTranscriptToRecord,
    DEFAULT_DIGEST_MODEL,
    DIGEST_MODELS,
    DIGEST_PRICING_AS_OF,
    hasTranscriptAttachment,
    IngestManager,
    IngestSourceFolder,
    MemoryBackend,
    MemoryExportRecord,
    RemoteMemoryBackend,
    ServerVersionInfo,
    antigravityPresetFolder,
    checkServerCompatibility,
    claudePresetFolder,
    codexPresetFolder,
    envManager,
    factoryPresetFolder,
} from 'gemdex-core';
import { ClientConfigStore, StoredRemote, tokenEnvVarForRemote } from './cli-config.js';
import { createConfig } from './config.js';
import { errorMessage } from './errors.js';
import { createMemoryBackend } from './memory.js';

interface CliIo {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    readSecret: (prompt: string, fromStdin: boolean) => Promise<string>;
}

interface CliDependencies {
    store?: ClientConfigStore;
    io?: CliIo;
    fetch?: typeof fetch;
    createLocalBackend?: () => MemoryBackend;
    createRemoteBackend?: (remote: StoredRemote, token: string) => MemoryBackend;
    /** Backend for the active mode (local or remote), used by ingest-history. */
    createActiveBackend?: () => MemoryBackend;
    createIngestManager?: () => IngestManager;
}

const defaultIo: CliIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
    readSecret,
};

function usage(): string {
    return `Gemdex remote configuration

Usage:
  gemdex init-remote <name> <url> [--token-env VAR | --token-stdin] [--import-local] [--no-activate]
  gemdex remote add <name> <url> [--token-env VAR | --token-stdin]
  gemdex remote list
  gemdex remote remove <name>
  gemdex remote status [name]
  gemdex mode local
  gemdex mode remote <name>
  gemdex status
  gemdex import-local-to-remote [name] [--attach-transcripts]
  gemdex backfill-transcripts [remote-name] [--force] [--dry-run]
  gemdex ingest-history [--source claude|factory|codex|antigravity|PATH]... [--model MODEL]
                        [--batch] [--dry-run] [--collect]

init-remote is the one-shot client setup for a BYOI server: it stores the
remote + token, verifies the server is reachable, authenticated, and version-
compatible, switches Gemdex into remote mode, optionally imports your local
memories (--import-local), and prints the exact agent command to run.

import-local-to-remote copies local Lance memories into a named remote. Pass
--attach-transcripts to parse each digest's "Full transcript: <path>" footer,
read the file when present, and include it as a non-embedded file attachment
(skipped with a message when the path is missing — does not fail the run).

backfill-transcripts re-imports digest memories that only have a path footer,
attaching the full transcript blob. With no remote name, uses the active
backend (local or remote). With a remote name, targets that remote. Missing
files are skipped with a clear message.

ingest-history distills coding-agent chat transcripts (Claude Code, Factory
CLI, Codex, Antigravity, or any folder of .jsonl sessions) into one memory per
session (digest text + full transcript as a non-embedded attachment). Only
never-before-ingested sessions are processed; previously ingested sessions are
never reprocessed, even if their transcript later changes. Defaults to detected
presets. --dry-run prints the scan + cost estimate; --batch submits a Gemini
Batch API job (50% cost, results within ~24h) that you collect later with
--collect. Needs a local GEMINI_API_KEY.
`;
}

function requireArg(args: string[], index: number, label: string): string {
    const value = args[index]?.trim();
    if (!value) throw new Error(`${label} is required.`);
    return value;
}

function optionValue(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    return requireArg(args, index + 1, `${name} value`);
}

async function readSecret(prompt: string, fromStdin: boolean): Promise<string> {
    if (fromStdin) {
        let value = '';
        for await (const chunk of process.stdin) value += chunk;
        return value.replace(/\r?\n$/, '').trim();
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
        throw new Error('Interactive token entry needs a TTY. Use --token-stdin or --token-env VAR.');
    }

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    return new Promise<string>((resolve, reject) => {
        let value = '';
        const cleanup = (): void => {
            process.stdin.off('data', onData);
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdout.write('\n');
        };
        const onData = (chunk: string): void => {
            for (const character of chunk) {
                if (character === '\u0003') {
                    cleanup();
                    reject(new Error('Token entry cancelled.'));
                    return;
                }
                if (character === '\r' || character === '\n') {
                    cleanup();
                    resolve(value.trim());
                    return;
                }
                if (character === '\u007f' || character === '\b') {
                    value = value.slice(0, -1);
                    continue;
                }
                value += character;
            }
        };
        process.stdin.on('data', onData);
    });
}

function resolveRemote(
    store: ClientConfigStore,
    requestedName?: string,
): { name: string; remote: StoredRemote; token: string } {
    const name = requestedName ?? store.getEnv('GEMDEX_REMOTE_NAME');
    if (!name) throw new Error('No remote selected. Pass a remote name or run `gemdex mode remote <name>`.');
    const remote = store.get(name);
    if (!remote) throw new Error(`Remote "${name}" is not configured.`);
    const token = store.getEnv(remote.tokenEnvVar)?.trim();
    if (!token) {
        throw new Error(`Token environment variable "${remote.tokenEnvVar}" is not configured.`);
    }
    return { name, remote, token };
}

async function remoteStatus(
    name: string,
    remote: StoredRemote,
    token: string,
    fetchImpl: typeof fetch,
    createRemoteBackend: (remote: StoredRemote, token: string) => MemoryBackend,
): Promise<{ reachable: boolean; authenticated: boolean; detail?: string }> {
    try {
        const response = await fetchImpl(`${remote.url}/v1/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return { reachable: false, authenticated: false, detail: `health returned HTTP ${response.status}` };
        }
    } catch (error) {
        return {
            reachable: false,
            authenticated: false,
            detail: errorMessage(error),
        };
    }

    try {
        await createRemoteBackend(remote, token).list();
        return { reachable: true, authenticated: true };
    } catch (error) {
        return { reachable: true, authenticated: false, detail: `${name}: ${errorMessage(error)}` };
    }
}

interface MigrationResult {
    created: number;
    updated: number;
    skipped: number;
    /** Transcripts attached during migrate when --attach-transcripts is set. */
    transcriptsAttached?: number;
    transcriptsMissing?: number;
}

interface BackfillTranscriptsResult {
    attached: number;
    already: number;
    missing: number;
    noPath: number;
    failed: number;
}

/**
 * Optionally attach full-transcript blobs to digest export records by reading
 * the path footed in content. Missing files are counted and skipped.
 */
function maybeAttachTranscripts(
    records: MemoryExportRecord[],
    attach: boolean,
    io: CliIo,
): { records: MemoryExportRecord[]; attached: number; missing: number } {
    if (!attach) return { records, attached: 0, missing: 0 };
    let attached = 0;
    let missing = 0;
    const out: MemoryExportRecord[] = [];
    for (const record of records) {
        const result = attachTranscriptToRecord(record, { force: false });
        if (result.status === 'attached') {
            attached += 1;
            out.push(result.record);
        } else if (result.status === 'missing') {
            missing += 1;
            io.stderr(
                `Skipped transcript for ${record.id}: file not found` +
                (result.filePath ? ` (${result.filePath})` : '') + `\n`,
            );
            out.push(record);
        } else {
            out.push(record);
        }
    }
    return { records: out, attached, missing };
}

async function migrateLocalToRemote(
    local: MemoryBackend,
    remote: MemoryBackend,
    io: CliIo,
    options: { attachTranscripts?: boolean } = {},
): Promise<MigrationResult> {
    const exported = await local.exportAll();
    const attach = options.attachTranscripts === true;
    const result: MigrationResult = {
        created: 0,
        updated: 0,
        skipped: 0,
        ...(attach && { transcriptsAttached: 0, transcriptsMissing: 0 }),
    };
    // Attach + import one record at a time so multi-hundred-MB transcript
    // backfills do not hold every base64 payload in memory at once.
    let index = 0;
    for (const raw of exported) {
        index += 1;
        let record = raw;
        if (attach) {
            const prepared = maybeAttachTranscripts([raw], true, io);
            record = prepared.records[0] ?? raw;
            result.transcriptsAttached = (result.transcriptsAttached ?? 0) + prepared.attached;
            result.transcriptsMissing = (result.transcriptsMissing ?? 0) + prepared.missing;
        }
        try {
            const existed = await remote.get(record.id) !== null;
            const imported = await remote.importRecords([record]);
            if (imported.imported !== 1) {
                result.skipped += 1;
                const detail = imported.errors[0]?.error;
                if (detail) {
                    io.stderr(`Skipped ${record.id}: ${detail}\n`);
                }
            } else if (existed) {
                result.updated += 1;
            } else {
                result.created += 1;
            }
        } catch (error) {
            result.skipped += 1;
            io.stderr(`Skipped ${record.id}: ${errorMessage(error)}\n`);
        }
        if (index % 25 === 0 || index === exported.length) {
            io.stdout(
                `Progress ${index}/${exported.length} — ` +
                `created ${result.created}, updated ${result.updated}, skipped ${result.skipped}` +
                (attach
                    ? `, transcripts ${result.transcriptsAttached ?? 0}` +
                      ` (missing ${result.transcriptsMissing ?? 0})`
                    : '') +
                `\n`,
            );
        }
    }
    return result;
}

/**
 * Re-import digests that only have a path footer, attaching the transcript file
 * when present. Idempotent: already-attached digests are skipped unless force.
 */
async function backfillTranscripts(
    backend: MemoryBackend,
    io: CliIo,
    options: { force?: boolean; dryRun?: boolean } = {},
): Promise<BackfillTranscriptsResult> {
    // Never use exportAll() here — remote export embeds every transcript as
    // base64 and multi-hundred-MB pools blow V8 string limits ("Invalid string
    // length"). List summaries + per-id get() only returns metadata + content.
    const summaries = await backend.list();
    const candidates = summaries.filter((summary) => summary.id.startsWith('chat:'));
    const result: BackfillTranscriptsResult = {
        attached: 0, already: 0, missing: 0, noPath: 0, failed: 0,
    };
    let index = 0;
    for (const summary of candidates) {
        index += 1;
        let memory;
        try {
            memory = await backend.get(summary.id);
        } catch (error) {
            result.failed += 1;
            io.stderr(`Failed ${summary.id}: ${errorMessage(error)}\n`);
            continue;
        }
        if (!memory) {
            result.failed += 1;
            io.stderr(`Failed ${summary.id}: not found\n`);
            continue;
        }

        if (!options.force && hasTranscriptAttachment(memory.attachments)) {
            result.already += 1;
            continue;
        }

        // Build a metadata-only export record (no attachment bytes). Cleaned
        // transcript is read from the local path footed in content.
        const attached = attachTranscriptToRecord(
            {
                id: memory.id,
                title: memory.title,
                content: memory.content,
                createdAt: memory.createdAt,
                updatedAt: memory.updatedAt,
            },
            { force: options.force === true },
        );
        if (attached.status === 'already') {
            result.already += 1;
            continue;
        }
        if (attached.status === 'no_path') {
            result.noPath += 1;
            continue;
        }
        if (attached.status === 'missing') {
            result.missing += 1;
            io.stderr(
                `Missing transcript for ${memory.id}` +
                (attached.filePath ? `: ${attached.filePath}` : '') + `\n`,
            );
            continue;
        }

        if (options.dryRun) {
            result.attached += 1;
            io.stdout(`[dry-run] would attach transcript to ${memory.id}\n`);
            continue;
        }

        try {
            const imported = await backend.importRecords([attached.record]);
            if (imported.imported === 1) {
                result.attached += 1;
            } else {
                result.failed += 1;
                const detail = imported.errors[0]?.error;
                io.stderr(`Failed ${memory.id}${detail ? `: ${detail}` : ''}\n`);
            }
        } catch (error) {
            result.failed += 1;
            io.stderr(`Failed ${memory.id}: ${errorMessage(error)}\n`);
        }

        if (index % 25 === 0 || index === candidates.length) {
            io.stdout(
                `Progress ${index}/${candidates.length} — ` +
                `attached ${result.attached}, already ${result.already}, ` +
                `missing ${result.missing}, noPath ${result.noPath}, failed ${result.failed}\n`,
            );
        }
    }
    return result;
}

/**
 * Verify a Gemdex Server is reachable AND speaks a compatible protocol version
 * before we commit a client to it. Throws a clear, actionable error otherwise.
 * Mirrors the version gate remote clients apply before sending memory data.
 */
async function verifyServerCompatibility(url: string, fetchImpl: typeof fetch): Promise<void> {
    let response: Response;
    try {
        response = await fetchImpl(`${url}/v1/version`, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
        throw new Error(`Could not reach ${url}/v1/version: ${errorMessage(error)}`);
    }
    if (!response.ok) {
        throw new Error(`${url}/v1/version returned HTTP ${response.status}.`);
    }
    let info: ServerVersionInfo;
    try {
        info = await response.json() as ServerVersionInfo;
    } catch {
        throw new Error(`${url}/v1/version did not return valid JSON.`);
    }
    checkServerCompatibility(info);
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number | null> {
    const store = dependencies.store ?? new ClientConfigStore();
    const io = dependencies.io ?? defaultIo;
    const fetchImpl = dependencies.fetch ?? fetch;
    // Import/backfill of digests + multi-MB transcript blobs regularly exceeds
    // the default 30s HTTP timeout; give remote migrations five minutes/request.
    const createRemoteBackend = dependencies.createRemoteBackend ??
        ((remote: StoredRemote, token: string) => new RemoteMemoryBackend({
            url: remote.url,
            token,
            timeoutMs: 300_000,
        }));
    const createLocalBackend = dependencies.createLocalBackend ?? (() => {
        const localConfig = createConfig((name) => name === 'GEMDEX_MODE' ? 'local' : store.getEnv(name));
        return createMemoryBackend(localConfig);
    });
    const createActiveBackend = dependencies.createActiveBackend ?? (() => {
        const mode = store.getEnv('GEMDEX_MODE')?.toLowerCase() === 'remote' ? 'remote' : 'local';
        if (mode === 'remote') {
            const selected = resolveRemote(store, undefined);
            return createRemoteBackend(selected.remote, selected.token);
        }
        return createLocalBackend();
    });

    const [command, subcommand] = args;
    const CLI_COMMANDS = [
        'remote',
        'mode',
        'status',
        'init-remote',
        'import-local-to-remote',
        'backfill-transcripts',
        'ingest-history',
    ];
    if (!CLI_COMMANDS.includes(command)) return null;

    try {
        if (command === 'remote' && subcommand === 'add') {
            const name = requireArg(args, 2, 'Remote name');
            const url = requireArg(args, 3, 'Remote URL');
            const explicitTokenEnvVar = optionValue(args, '--token-env');
            const fromStdin = args.includes('--token-stdin');
            if (explicitTokenEnvVar && fromStdin) {
                throw new Error('Use either --token-env or --token-stdin, not both.');
            }
            const tokenEnvVar = explicitTokenEnvVar ?? tokenEnvVarForRemote(name);
            if (!explicitTokenEnvVar) {
                const token = await io.readSecret('Bearer token: ', fromStdin);
                if (!token) throw new Error('Bearer token cannot be empty.');
                store.setEnv(tokenEnvVar, token);
            }
            const remote = store.add(name, url, tokenEnvVar);
            io.stdout(`Added remote "${name}" at ${remote.url}.\n`);
            return 0;
        }

        if (command === 'remote' && subcommand === 'list') {
            const activeName = store.getEnv('GEMDEX_MODE') === 'remote'
                ? store.getEnv('GEMDEX_REMOTE_NAME')
                : undefined;
            const remotes = store.list();
            if (remotes.length === 0) {
                io.stdout('No remotes configured.\n');
                return 0;
            }
            for (const remote of remotes) {
                io.stdout(`${remote.name === activeName ? '* ' : '  '}${remote.name}\t${remote.url}\n`);
            }
            return 0;
        }

        if (command === 'remote' && subcommand === 'remove') {
            const name = requireArg(args, 2, 'Remote name');
            if (!store.remove(name)) throw new Error(`Remote "${name}" is not configured.`);
            io.stdout(`Removed remote "${name}".\n`);
            return 0;
        }

        if (command === 'mode' && subcommand === 'local') {
            store.activateLocal();
            io.stdout('Gemdex mode is now local.\n');
            return 0;
        }

        if (command === 'mode' && subcommand === 'remote') {
            const name = requireArg(args, 2, 'Remote name');
            const remote = store.activateRemote(name);
            io.stdout(`Gemdex mode is now remote: ${name} (${remote.url}).\n`);
            return 0;
        }

        if (command === 'status' || (command === 'remote' && subcommand === 'status')) {
            const requestedName = command === 'remote' ? args[2] : undefined;
            const mode = store.getEnv('GEMDEX_MODE')?.toLowerCase() === 'remote' ? 'remote' : 'local';
            if (mode === 'local' && !requestedName) {
                io.stdout('Mode: local\n');
                io.stdout(`Store: ${store.getEnv('LANCEDB_PATH') ?? '~/.gemdex/lance'}\n`);
                return 0;
            }
            const selected = resolveRemote(store, requestedName);
            const status = await remoteStatus(
                selected.name,
                selected.remote,
                selected.token,
                fetchImpl,
                createRemoteBackend,
            );
            io.stdout(`Mode: ${mode}${mode === 'remote' ? ` (${selected.name})` : ''}\n`);
            io.stdout(`Remote: ${selected.remote.url}\n`);
            io.stdout(`Reachable: ${status.reachable ? 'yes' : 'no'}\n`);
            io.stdout(`Authenticated: ${status.authenticated ? 'yes' : 'no'}\n`);
            if (status.detail) io.stdout(`Detail: ${status.detail}\n`);
            return status.reachable && status.authenticated ? 0 : 1;
        }

        if (command === 'init-remote') {
            const name = requireArg(args, 1, 'Remote name');
            const url = requireArg(args, 2, 'Remote URL');
            const explicitTokenEnvVar = optionValue(args, '--token-env');
            const fromStdin = args.includes('--token-stdin');
            const importLocal = args.includes('--import-local');
            const activate = !args.includes('--no-activate');
            if (explicitTokenEnvVar && fromStdin) {
                throw new Error('Use either --token-env or --token-stdin, not both.');
            }

            // 1. Store the named remote and its token (token kept out of config.json).
            const tokenEnvVar = explicitTokenEnvVar ?? tokenEnvVarForRemote(name);
            if (!explicitTokenEnvVar) {
                const token = await io.readSecret('Bearer token: ', fromStdin);
                if (!token) throw new Error('Bearer token cannot be empty.');
                store.setEnv(tokenEnvVar, token);
            }
            const remoteRecord = store.add(name, url, tokenEnvVar);
            io.stdout(`Added remote "${name}" at ${remoteRecord.url}.\n`);

            const token = store.getEnv(tokenEnvVar)?.trim();
            if (!token) {
                throw new Error(`Token environment variable "${tokenEnvVar}" is not configured.`);
            }

            // 2. Fail fast if the server is unreachable or version-incompatible.
            await verifyServerCompatibility(remoteRecord.url, fetchImpl);
            io.stdout('Server reachable and version-compatible.\n');

            // 3. Confirm the token actually authenticates against a data route.
            const remote = createRemoteBackend(remoteRecord, token);
            try {
                await remote.list();
            } catch (error) {
                throw new Error(`Authentication check failed: ${errorMessage(error)}`);
            }
            io.stdout('Authenticated successfully.\n');

            // 4. Optionally copy this machine's local memories into the remote.
            if (importLocal) {
                const local = createLocalBackend();
                const migration = await migrateLocalToRemote(local, remote, io);
                io.stdout(
                    `Imported local memories — Created: ${migration.created}, ` +
                    `Updated: ${migration.updated}, Skipped: ${migration.skipped}.\n`,
                );
                if (migration.skipped > 0) {
                    io.stderr('Some local memories were skipped; see messages above.\n');
                }
            }

            // 5. Switch this machine into remote mode unless told not to.
            if (activate) {
                store.activateRemote(name);
                io.stdout(`Gemdex mode is now remote: ${name}.\n`);
            }

            io.stdout(
                `\nDone. Point your agent at this remote — e.g. for Claude Code:\n` +
                `  claude mcp add gemdex -- npx -y gemdex-mcp@latest\n` +
                `The MCP process reads the selected remote from ~/.gemdex; ` +
                `no GEMINI_API_KEY is needed on this machine.\n`,
            );
            return 0;
        }

        if (command === 'ingest-history') {
            return await runIngestHistory(args.slice(1), io, dependencies);
        }

        if (command === 'import-local-to-remote') {
            const attachTranscripts = args.includes('--attach-transcripts');
            const nameArg = args.slice(1).find((a) => !a.startsWith('--'));
            const selected = resolveRemote(store, nameArg);
            const local = createLocalBackend();
            const remote = createRemoteBackend(selected.remote, selected.token);
            const result = await migrateLocalToRemote(local, remote, io, { attachTranscripts });
            io.stdout(`Migration to "${selected.name}" complete.\n`);
            io.stdout(`Created: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}\n`);
            if (attachTranscripts) {
                io.stdout(
                    `Transcripts attached: ${result.transcriptsAttached ?? 0}\n` +
                    `Transcripts missing: ${result.transcriptsMissing ?? 0}\n`,
                );
            }
            return result.skipped === 0 ? 0 : 1;
        }

        if (command === 'backfill-transcripts') {
            const force = args.includes('--force');
            const dryRun = args.includes('--dry-run');
            const nameArg = args.slice(1).find((a) => !a.startsWith('--'));
            let backend: MemoryBackend;
            let targetLabel: string;
            if (nameArg) {
                const selected = resolveRemote(store, nameArg);
                backend = createRemoteBackend(selected.remote, selected.token);
                targetLabel = `remote "${selected.name}"`;
            } else {
                backend = createActiveBackend();
                targetLabel = 'active backend';
            }
            const result = await backfillTranscripts(backend, io, { force, dryRun });
            io.stdout(
                `Backfill transcripts on ${targetLabel}` +
                (dryRun ? ' (dry-run)' : '') + `:\n` +
                `  attached: ${result.attached}\n` +
                `  already had transcript: ${result.already}\n` +
                `  missing file: ${result.missing}\n` +
                `  no path footer: ${result.noPath}\n` +
                `  failed: ${result.failed}\n`,
            );
            return result.failed === 0 ? 0 : 1;
        }

        io.stderr(usage());
        return 1;
    } catch (error) {
        io.stderr(`Error: ${errorMessage(error)}\n`);
        return 1;
    }
}

/** Collect every `--source` value: presets by name, anything else as a custom path. */
function parseIngestSources(args: string[]): IngestSourceFolder[] {
    const folders: IngestSourceFolder[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--source') continue;
        const value = requireArg(args, i + 1, '--source value');
        if (value === 'claude') {
            folders.push(claudePresetFolder());
        } else if (value === 'factory') {
            folders.push(factoryPresetFolder());
        } else if (value === 'codex') {
            folders.push(codexPresetFolder());
        } else if (value === 'antigravity') {
            folders.push(antigravityPresetFolder());
        } else {
            folders.push({ source: 'custom', path: value });
        }
    }
    if (folders.length > 0) return folders;
    // Default: all built-in presets, when their folders exist.
    const presets = [claudePresetFolder(), factoryPresetFolder(), codexPresetFolder(), antigravityPresetFolder()]
        .filter((preset) => fs.existsSync(preset.path));
    if (presets.length === 0) {
        throw new Error('No session folders found. Pass --source claude|factory|codex|antigravity|<path>.');
    }
    return presets;
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

async function runIngestHistory(args: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
    const model = optionValue(args, '--model') ?? DEFAULT_DIGEST_MODEL;
    if (!DIGEST_MODELS[model]) {
        throw new Error(`Unsupported model "${model}". Supported: ${Object.keys(DIGEST_MODELS).join(', ')}`);
    }
    const batch = args.includes('--batch');
    const dryRun = args.includes('--dry-run');
    const collect = args.includes('--collect');

    const apiKey = envManager.get('GEMINI_API_KEY');
    if (!apiKey) {
        throw new Error('Chat-history ingestion needs a local GEMINI_API_KEY (digests are generated client-side).');
    }
    const manager = dependencies.createIngestManager?.() ?? new IngestManager({
        apiKey,
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
    });
    const createBackend = dependencies.createActiveBackend ?? (() => createMemoryBackend(createConfig()));

    if (collect) {
        const result = await manager.collect(createBackend());
        if (result.state === 'none') {
            io.stdout('No pending batch job.\n');
            return 0;
        }
        if (result.state === 'pending') {
            io.stdout(`Batch job still ${result.jobState}. Try again later.\n`);
            return 0;
        }
        if (result.state === 'failed') {
            io.stderr(`Batch job failed: ${result.error}\n`);
            return 1;
        }
        io.stdout(`Collected batch results — Ingested: ${result.ingested}, Failed: ${result.failed}.\n`);
        return (result.failed ?? 0) === 0 ? 0 : 1;
    }

    const folders = parseIngestSources(args);
    const scan = manager.scan(folders);
    io.stdout(
        `Sessions — new: ${scan.processableFiles.length}, ` +
        `previously ingested and changed (skipped): ${scan.buckets.changedFiles.length}, ` +
        `up-to-date: ${scan.buckets.upToDate.length}, active (skipped): ${scan.buckets.skippedActive.length}\n`,
    );
    if (scan.skippedTrivialFiles.length > 0) {
        io.stdout(`Skipped trivial candidates: ${scan.skippedTrivialFiles.length}\n`);
    }
    if (scan.buckets.changedFiles.length > 0) {
        io.stdout('Previously ingested sessions are never reprocessed.\n');
    }
    if (scan.pendingCount === 0) {
        io.stdout('Nothing to ingest.\n');
        return 0;
    }
    io.stdout(`Estimated input tokens: ~${scan.estimatedInputTokens.toLocaleString()}\n`);
    io.stdout(`Cost estimates (pricing as of ${DIGEST_PRICING_AS_OF}):\n`);
    for (const estimate of scan.estimates) {
        const marker = estimate.model === model ? '*' : ' ';
        io.stdout(
            `  ${marker} ${estimate.model.padEnd(24)} standard ${formatUsd(estimate.standardUsd)}` +
            `  batch ${formatUsd(estimate.batchUsd)}\n`,
        );
    }
    if (dryRun) return 0;

    const backend = createBackend();
    if (batch) {
        const progress = await manager.run({ folders, model, mode: 'batch' }, backend);
        const jobName = progress.pendingBatch?.jobName ?? '(unknown)';
        io.stdout(`Submitted batch job ${jobName} (${progress.total} sessions).\n`);
        io.stdout('Collect results later with: gemdex ingest-history --collect\n');
        return 0;
    }

    const ticker = setInterval(() => {
        const progress = manager.getProgress();
        io.stderr(`\r[ingest] ${progress.processed + progress.failed}/${progress.total} (failed: ${progress.failed})  `);
    }, 1000);
    try {
        const progress = await manager.run({ folders, model, mode: 'standard' }, backend);
        io.stderr('\n');
        io.stdout(
            `Done — Ingested: ${progress.processed}, Failed: ${progress.failed}, ` +
            `Skipped (trivial/unchanged): ${progress.skipped}.\n`,
        );
        return progress.failed === 0 ? 0 : 1;
    } finally {
        clearInterval(ticker);
    }
}
