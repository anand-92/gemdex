import { GoogleGenAI, Type } from '@google/genai';
import { ModelCostEstimate, ParsedSession, SessionDigest, SessionMeta } from './types';
import { renderTranscript } from './transcript-parser';

/** Default (and only) digest/judge model. */
export const DEFAULT_DIGEST_MODEL = 'gemini-3.5-flash-lite';

export interface DigestModelInfo {
    /** USD per 1M input tokens (text), standard pricing. */
    inputUsdPerMTok: number;
    /** USD per 1M output tokens (including thinking), standard pricing. */
    outputUsdPerMTok: number;
    description: string;
}

/** Date the pricing constants below were last verified against ai.google.dev. */
export const DIGEST_PRICING_AS_OF = '2026-06-10';

/**
 * Models offered for session digestion and hygiene judging, with standard-tier
 * pricing. Batch API is 50% of these rates across the board.
 * Single model by design — no picker alternatives.
 */
export const DIGEST_MODELS: Record<string, DigestModelInfo> = {
    'gemini-3.5-flash-lite': {
        inputUsdPerMTok: 0.25,
        outputUsdPerMTok: 1.5,
        description: 'Default for digest and hygiene',
    },
};

/** Rough chars→tokens divisor for estimates. */
const CHARS_PER_TOKEN = 4;
/** Output budget assumed per digest for cost estimates. */
export const ESTIMATED_OUTPUT_TOKENS_PER_SESSION = 800;

export function estimateCost(
    inputTokens: number,
    outputTokens: number,
): ModelCostEstimate[] {
    return Object.entries(DIGEST_MODELS).map(([model, info]) => {
        const standardUsd = (inputTokens * info.inputUsdPerMTok + outputTokens * info.outputUsdPerMTok) / 1_000_000;
        return {
            model,
            standardUsd: Number(standardUsd.toFixed(2)),
            batchUsd: Number((standardUsd / 2).toFixed(2)),
        };
    });
}

export function estimateTokensForChars(chars: number): number {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

const SOURCE_LABELS: Record<string, string> = {
    claude: 'Claude Code',
    factory: 'Factory CLI',
    codex: 'Codex',
    antigravity: 'Antigravity',
    custom: 'Coding agent',
};

const DIGEST_SYSTEM_INSTRUCTION = `You distill a coding-agent chat transcript into the note a future AI agent
needs to redo this work without the transcript. Optimize for reproducibility
and recall: exact commands with flags, exact file paths, exact tool/service
names, where credentials/config live. Prefer concrete specifics over prose.
Omit anything generic that any engineer would already know. If the session was
trivial or exploratory, keep every field short rather than padding.`;

export const DIGEST_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        title: {
            type: Type.STRING,
            description: "Imperative, searchable title — e.g. 'Set up SSE chat streaming in agent frontend'",
        },
        what_was_done: {
            type: Type.STRING,
            description: '2-4 sentence narrative of the task and end state',
        },
        how_to_reproduce: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Ordered steps with exact commands, flags, file paths',
        },
        tools_and_services: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Tools/CLIs/APIs/libraries used and what for — e.g. 'xcrun notarytool — Apple notarization'",
        },
        credentials_and_config: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Where keys/tokens/profiles/env vars live (names and locations)',
        },
        gotchas: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Errors hit plus the actual fix; non-obvious constraints',
        },
    },
    required: ['title', 'what_was_done'],
} as const;

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Parse the model's structured-output JSON into a SessionDigest. */
export function parseDigestResponse(text: string): SessionDigest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Digest model returned invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Digest model returned a non-object response');
    }
    const record = parsed as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const whatWasDone = typeof record.what_was_done === 'string' ? record.what_was_done.trim() : '';
    if (!title || !whatWasDone) {
        throw new Error("Digest response is missing 'title' or 'what_was_done'");
    }
    return {
        title,
        whatWasDone,
        howToReproduce: asStringArray(record.how_to_reproduce),
        toolsAndServices: asStringArray(record.tools_and_services),
        credentialsAndConfig: asStringArray(record.credentials_and_config),
        gotchas: asStringArray(record.gotchas),
    };
}

function formatDate(ms: number | undefined): string | undefined {
    if (ms === undefined) return undefined;
    return new Date(ms).toISOString().slice(0, 10);
}

function section(heading: string, items: string[], ordered: boolean): string {
    if (items.length === 0) return '';
    const lines = items.map((item, index) => ordered ? `${index + 1}. ${item}` : `- ${item}`);
    return `\n## ${heading}\n${lines.join('\n')}\n`;
}

/**
 * Render a digest plus session metadata into the memory content. Always
 * footed with the provenance pointer back to the raw transcript so an agent
 * can read the verbatim session when the digest isn't enough.
 */
export function renderDigestMemory(
    digest: SessionDigest,
    meta: SessionMeta,
    options: { transcriptPointer?: string } = {},
): string {
    const sourceLabel = SOURCE_LABELS[meta.source] ?? SOURCE_LABELS.custom;
    const headerParts = [`Source: ${sourceLabel}`];
    if (meta.cwd) {
        headerParts.push(`Repo: ${meta.cwd}${meta.gitBranch ? ` (${meta.gitBranch})` : ''}`);
    }
    const date = formatDate(meta.lastTs ?? meta.firstTs);
    if (date) headerParts.push(date);

    let body = `${headerParts.join(' · ')}\n${digest.whatWasDone}\n`;
    body += section('How to reproduce', digest.howToReproduce, true);
    body += section('Tools & services', digest.toolsAndServices, false);
    body += section('Credentials & config', digest.credentialsAndConfig, false);
    body += section('Gotchas', digest.gotchas, false);
    // Provenance footer. The path-based pipeline points at the source file on
    // the machine that ingested it; an uploaded session has no such path on the
    // ingesting host, so callers override the pointer with something an agent
    // can actually act on (the read_attachment hint).
    body += `\n---\nFull transcript: ${options.transcriptPointer ?? meta.filePath}\n`
        + '(read this file for the verbatim session)';
    return body;
}

/** Deterministic memory id for a session — re-ingestion upserts, never duplicates. */
export function memoryIdForSession(meta: Pick<SessionMeta, 'source' | 'sessionId'>): string {
    return `chat:${meta.source}:${meta.sessionId}`;
}

/** Build the user-prompt contents for one session's digest request. */
export function buildDigestPrompt(session: ParsedSession): string {
    const contextLines = [
        `Agent: ${SOURCE_LABELS[session.source] ?? SOURCE_LABELS.custom}`,
        session.cwd ? `Working directory: ${session.cwd}` : null,
        session.gitBranch ? `Git branch: ${session.gitBranch}` : null,
        session.title ? `Session title: ${session.title}` : null,
    ].filter((line): line is string => line !== null);
    return `${contextLines.join('\n')}\n\nTranscript:\n\n${renderTranscript(session.turns)}`;
}

/** Shared generation config for both standard and batch digest requests. */
export function digestGenerationConfig(): Record<string, unknown> {
    return {
        responseMimeType: 'application/json',
        responseSchema: DIGEST_RESPONSE_SCHEMA,
        systemInstruction: DIGEST_SYSTEM_INSTRUCTION,
        temperature: 0.2,
    };
}

/**
 * One inlined `GenerateContentRequest` for a Batch API JSONL line. Unlike the
 * SDK's `config` object, the REST wire format wants `systemInstruction` as a
 * `Content` at the top level (a sibling of `contents`), with the remaining
 * generation settings under `generationConfig`.
 */
export function digestBatchRequest(session: ParsedSession): Record<string, unknown> {
    return {
        contents: [{ role: 'user', parts: [{ text: buildDigestPrompt(session) }] }],
        systemInstruction: { parts: [{ text: DIGEST_SYSTEM_INSTRUCTION }] },
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: DIGEST_RESPONSE_SCHEMA,
            temperature: 0.2,
        },
    };
}

export interface DigesterConfig {
    apiKey: string;
    model?: string;
    baseURL?: string;
}

/** Thin client that digests one parsed session via `generateContent`. */
export class SessionDigester {
    private client: GoogleGenAI;
    readonly model: string;

    constructor(config: DigesterConfig) {
        this.model = config.model ?? DEFAULT_DIGEST_MODEL;
        if (!DIGEST_MODELS[this.model]) {
            throw new Error(
                `Unsupported digest model "${this.model}". Supported: ${Object.keys(DIGEST_MODELS).join(', ')}`,
            );
        }
        this.client = new GoogleGenAI({
            apiKey: config.apiKey,
            ...(config.baseURL && { httpOptions: { baseUrl: config.baseURL } }),
        });
    }

    getClient(): GoogleGenAI {
        return this.client;
    }

    async digest(session: ParsedSession): Promise<SessionDigest> {
        const response = await this.client.models.generateContent({
            model: this.model,
            contents: buildDigestPrompt(session),
            config: digestGenerationConfig(),
        });
        const text = response.text;
        if (!text) {
            throw new Error('Digest model returned an empty response');
        }
        return parseDigestResponse(text);
    }
}
