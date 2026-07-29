import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SyncCredentialStore } from './sync-config.js';

/**
 * The OAuth 2.1 client for `gemdex sync-history`.
 *
 * Why the *MCP* OAuth client flow rather than a bespoke token endpoint: the host
 * already runs a spec-compliant OAuth 2.1 resource server (`packages/mcp-http`,
 * FastMCP's `OAuthProxy` in front of Google). Its metadata is discoverable from
 * the `/mcp` URL via RFC 9728, and the SDK's `auth()` orchestrator implements
 * exactly that discovery → dynamic client registration → PKCE authorization-code
 * exchange. So the CLI needs no new server surface and no new credential type:
 * it authenticates as the same single allowlisted human, and the host re-checks
 * the email allowlist on every request.
 *
 * This is an **interactive, human-present** flow by design. Sync runs on a
 * coding laptop with a browser, not headless in CI, so an authorization-code
 * flow with a loopback redirect is both spec-correct and the least machinery —
 * no service account, no long-lived shared secret on every laptop. The
 * refresh token means the browser step happens once per machine.
 */

/** Where the browser is sent back to. Port 0 = OS picks a free one. */
const LOOPBACK_HOST = '127.0.0.1';

/** How long to wait for the human to finish the browser consent step. */
export const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

/** Scopes the host's Google provider requires (mirrors `GOOGLE_SCOPES`). */
export const SYNC_SCOPE = 'openid email';

export const SYNC_CLIENT_NAME = 'Gemdex sync-history CLI';

/**
 * A one-shot loopback HTTP server that captures the `?code=` redirect.
 *
 * RFC 8252 §7.3 loopback redirect: the only redirect a native CLI can receive
 * without hosting anything public. The port is chosen at bind time and the
 * registered redirect URI carries it, which FastMCP's DCR path accepts because
 * loopback patterns match any port.
 */
export class LoopbackReceiver {
    private server?: http.Server;
    private redirect?: string;

    /** Start listening and return the exact redirect URI to register. */
    async start(): Promise<string> {
        const server = http.createServer();
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, LOOPBACK_HOST, () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Could not determine the loopback callback port.');
        }
        this.redirect = `http://${LOOPBACK_HOST}:${address.port}/callback`;
        return this.redirect;
    }

    get redirectUrl(): string {
        if (!this.redirect) throw new Error('LoopbackReceiver.start() has not been called.');
        return this.redirect;
    }

    /**
     * Resolve with the authorization code once the browser hits `/callback`.
     * The `state` must match what we sent — otherwise an unrelated request (or
     * a cross-site forgery) could inject a code from a different flow.
     */
    async waitForCode(expectedState: string, timeoutMs = AUTHORIZE_TIMEOUT_MS): Promise<string> {
        const server = this.server;
        if (!server) throw new Error('LoopbackReceiver.start() has not been called.');
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser authorization.`));
            }, timeoutMs);
            server.on('request', (request, response) => {
                const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
                if (url.pathname !== '/callback') {
                    response.writeHead(404).end('Not found');
                    return;
                }
                const reply = (status: number, body: string): void => {
                    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
                    response.end(body);
                    clearTimeout(timer);
                };
                const error = url.searchParams.get('error');
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                if (error) {
                    reply(400, `Authorization failed: ${error}`);
                    reject(new Error(`Authorization was denied: ${error}`));
                } else if (state !== expectedState) {
                    reply(400, 'Authorization failed: state mismatch.');
                    reject(new Error('Authorization state did not match; aborting.'));
                } else if (!code) {
                    reply(400, 'Authorization failed: no code.');
                    reject(new Error('Authorization redirect carried no code.'));
                } else {
                    reply(200, 'Gemdex is authorized. You can close this tab and return to the terminal.');
                    resolve(code);
                }
            });
        });
    }

    close(): void {
        this.server?.close();
        this.server = undefined;
    }
}

/**
 * `OAuthClientProvider` backed by `~/.gemdex` (`0600`).
 *
 * Persisting the client registration and the refresh token is what makes the
 * browser step a once-per-machine event rather than once per sync. Tokens live
 * in the same `0600` env file the BYOI bearer already uses — a new secret store
 * would only add a second thing to secure.
 */
export class SyncOAuthClientProvider implements OAuthClientProvider {
    private codeVerifierValue?: string;
    private stateValue?: string;

    constructor(
        private readonly store: SyncCredentialStore,
        private readonly redirect: string,
        private readonly openBrowser: (url: string) => void | Promise<void>,
    ) {}

    get redirectUrl(): string {
        return this.redirect;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: SYNC_CLIENT_NAME,
            redirect_uris: [this.redirect],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: SYNC_SCOPE,
        };
    }

    state(): string {
        this.stateValue = crypto.randomBytes(16).toString('hex');
        return this.stateValue;
    }

    /** The `state` most recently issued, for the loopback receiver to match. */
    get issuedState(): string | undefined {
        return this.stateValue;
    }

    clientInformation(): OAuthClientInformation | undefined {
        return this.store.readClientInformation();
    }

    saveClientInformation(information: OAuthClientInformationFull): void {
        this.store.writeClientInformation(information);
    }

    tokens(): OAuthTokens | undefined {
        return this.store.readTokens();
    }

    saveTokens(tokens: OAuthTokens): void {
        this.store.writeTokens(tokens);
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        await this.openBrowser(authorizationUrl.toString());
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.codeVerifierValue = codeVerifier;
    }

    codeVerifier(): string {
        if (!this.codeVerifierValue) {
            throw new Error('No PKCE code verifier for this authorization attempt.');
        }
        return this.codeVerifierValue;
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this.store.writeDiscoveryState(state);
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.store.readDiscoveryState();
    }

    /**
     * Drop cached credentials the server has told us are no longer valid, so
     * `auth()`'s retry can re-register / re-authorize instead of looping on a
     * dead token and making the user debug it.
     */
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        if (scope === 'verifier') {
            this.codeVerifierValue = undefined;
            return;
        }
        this.store.clear(scope);
        if (scope === 'all') this.codeVerifierValue = undefined;
    }
}

export interface AuthorizeOptions {
    /** The `/mcp` endpoint URL — the OAuth *resource*, and what we discover from. */
    mcpUrl: string;
    store: SyncCredentialStore;
    openBrowser: (url: string) => void | Promise<void>;
    /** Progress lines (stderr in practice; stdout is reserved in MCP mode). */
    log: (message: string) => void;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

/**
 * Obtain a usable access token for the host's `/mcp` endpoint.
 *
 * Runs the SDK's `auth()` orchestrator: it refreshes silently when a stored
 * refresh token still works, and only falls through to the browser when it
 * doesn't. `'REDIRECT'` means human consent is needed, so we wait on the
 * loopback receiver and hand the code back to `auth()` for the PKCE exchange.
 */
export async function authorizeSync(options: AuthorizeOptions): Promise<string> {
    const receiver = new LoopbackReceiver();
    const redirect = await receiver.start();
    try {
        const provider = new SyncOAuthClientProvider(options.store, redirect, options.openBrowser);
        const result = await auth(provider, {
            serverUrl: options.mcpUrl,
            scope: SYNC_SCOPE,
            ...(options.fetchImpl && { fetchFn: options.fetchImpl }),
        });

        if (result === 'REDIRECT') {
            options.log(
                'Opening your browser to authorize Gemdex sync.\n' +
                'Sign in as the account allowlisted on the host (GEMDEX_ALLOWED_EMAIL).\n',
            );
            const state = provider.issuedState;
            if (!state) throw new Error('Authorization started without a state parameter.');
            const code = await receiver.waitForCode(state, options.timeoutMs);
            await auth(provider, {
                serverUrl: options.mcpUrl,
                authorizationCode: code,
                scope: SYNC_SCOPE,
                ...(options.fetchImpl && { fetchFn: options.fetchImpl }),
            });
            options.log('Authorized.\n');
        }

        const tokens = options.store.readTokens();
        if (!tokens?.access_token) {
            throw new Error('Authorization completed but no access token was stored.');
        }
        return tokens.access_token;
    } finally {
        // Always stop listening: a lingering loopback server is an open port on
        // the user's machine long after the flow ended.
        receiver.close();
    }
}
