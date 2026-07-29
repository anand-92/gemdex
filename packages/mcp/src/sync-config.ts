import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { errorMessage } from './errors.js';

/**
 * Persisted OAuth state for `gemdex sync-history`, at
 * `~/.gemdex/sync-auth.json` (`0600`, dir `0700`).
 *
 * Kept out of `~/.gemdex/config.json` (which is world-readable-shaped named
 * remotes) and out of `~/.gemdex/.env` (flat `KEY=value`, which cannot hold the
 * nested client-registration and discovery objects). One file per concern:
 * everything here is machine-generated OAuth state for exactly one host, and
 * `clear()` is a supported operation — `gemdex sync-history --logout`.
 *
 * The refresh token is the sensitive part: it can mint access tokens for the
 * host until revoked. Hence `0600` and the same never-print rule as the BYOI
 * bearer.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Bump when the on-disk shape changes incompatibly. */
const VERSION = 1;

interface StoredSyncAuth {
    version: number;
    /** Keyed by MCP endpoint URL: one laptop may sync to more than one host. */
    hosts: Record<string, StoredHostAuth>;
}

interface StoredHostAuth {
    client?: OAuthClientInformation;
    tokens?: OAuthTokens;
    discovery?: OAuthDiscoveryState;
}

export interface SyncCredentialStoreOptions {
    rootDir?: string;
}

/**
 * Reads/writes one host's OAuth state. Scoped to a single MCP URL at
 * construction so the `OAuthClientProvider` methods (which take no host
 * argument, per the SDK's "one provider per session" contract) cannot
 * accidentally read another host's tokens.
 */
export class SyncCredentialStore {
    readonly filePath: string;
    private readonly rootDir: string;

    constructor(private readonly mcpUrl: string, options: SyncCredentialStoreOptions = {}) {
        this.rootDir = options.rootDir ?? path.join(os.homedir(), '.gemdex');
        this.filePath = path.join(this.rootDir, 'sync-auth.json');
    }

    readClientInformation(): OAuthClientInformation | undefined {
        return this.host().client;
    }

    writeClientInformation(client: OAuthClientInformation): void {
        this.mutate((host) => {
            host.client = client;
        });
    }

    readTokens(): OAuthTokens | undefined {
        return this.host().tokens;
    }

    writeTokens(tokens: OAuthTokens): void {
        this.mutate((host) => {
            host.tokens = tokens;
        });
    }

    readDiscoveryState(): OAuthDiscoveryState | undefined {
        return this.host().discovery;
    }

    writeDiscoveryState(discovery: OAuthDiscoveryState): void {
        this.mutate((host) => {
            host.discovery = discovery;
        });
    }

    /**
     * Drop cached state for this host. `'all'` forgets the host entirely
     * (the `--logout` path); the narrower scopes exist because the SDK's
     * `auth()` retry asks for exactly one of them after a recoverable failure.
     */
    clear(scope: 'all' | 'client' | 'tokens' | 'discovery' | 'verifier' = 'all'): void {
        if (scope === 'verifier') return; // held in memory only
        const stored = this.load();
        if (scope === 'all') {
            if (!(this.mcpUrl in stored.hosts)) return;
            delete stored.hosts[this.mcpUrl];
        } else {
            const host = stored.hosts[this.mcpUrl];
            if (!host) return;
            delete host[scope];
        }
        this.write(stored);
    }

    /** True when this host has any stored state (i.e. has been authorized). */
    hasCredentials(): boolean {
        return this.host().tokens?.access_token !== undefined;
    }

    private host(): StoredHostAuth {
        return this.load().hosts[this.mcpUrl] ?? {};
    }

    private mutate(apply: (host: StoredHostAuth) => void): void {
        const stored = this.load();
        const host = stored.hosts[this.mcpUrl] ?? {};
        apply(host);
        stored.hosts[this.mcpUrl] = host;
        this.write(stored);
    }

    private load(): StoredSyncAuth {
        if (!fs.existsSync(this.filePath)) return { version: VERSION, hosts: {} };
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (error) {
            throw new Error(`Unable to read ${this.filePath}: ${errorMessage(error)}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`${this.filePath} is not a JSON object.`);
        }
        const candidate = parsed as Record<string, unknown>;
        if (candidate.version !== VERSION) {
            throw new Error(
                `${this.filePath} has version ${String(candidate.version)}, expected ${VERSION}. ` +
                'Delete the file to re-authorize.',
            );
        }
        const hosts = candidate.hosts;
        if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
            throw new Error(`${this.filePath} is missing a 'hosts' object.`);
        }
        return { version: VERSION, hosts: hosts as Record<string, StoredHostAuth> };
    }

    private write(stored: StoredSyncAuth): void {
        fs.mkdirSync(this.rootDir, { recursive: true, mode: DIR_MODE });
        const temporaryPath = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
            encoding: 'utf8',
            mode: FILE_MODE,
        });
        fs.renameSync(temporaryPath, this.filePath);
        fs.chmodSync(this.filePath, FILE_MODE);
    }
}
