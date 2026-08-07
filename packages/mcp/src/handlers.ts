import {
    MemoryBackend,
    MemoryStatsStore,
    MemoryOutcome,
    MemoryStats,
    MemoryRecallResult,
    SimilarMemoryRef,
    applyContentEdits,
    ContentEdit,
    envManager,
} from "gemdex-core";
import { resolveAttachmentInputs } from "./attachment-path.js";
import { errorMessage } from "./errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
    return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

/** Default max characters returned by `read_attachment` (~1.5 MiB of UTF-8 text). */
export const DEFAULT_READ_ATTACHMENT_MAX_CHARS = 1_500_000;

const TEXTISH_MIME_PREFIXES = ['text/', 'application/json', 'application/x-ndjson', 'application/jsonl'];

function isTextishMime(mimeType: string): boolean {
    const lower = mimeType.toLowerCase();
    return TEXTISH_MIME_PREFIXES.some((p) => lower === p || lower.startsWith(p))
        || lower.includes('json')
        || lower === 'application/xml'
        || lower.endsWith('+json')
        || lower.endsWith('+xml');
}

/**
 * Pick a default attachment when the agent omits `attachment_id`:
 * 1. sole attachment on the memory
 * 2. sole `file` kind (transcripts)
 * 3. sole caption matching /transcript/i
 * Otherwise returns null so the handler asks the agent to choose.
 */
function pickDefaultAttachmentId(
    attachments: Array<{ id: string; kind: string; caption?: string }>,
): string | null {
    if (attachments.length === 1) return attachments[0].id;
    const files = attachments.filter((a) => a.kind === 'file');
    if (files.length === 1) return files[0].id;
    const transcripts = attachments.filter(
        (a) => typeof a.caption === 'string' && /transcript/i.test(a.caption),
    );
    if (transcripts.length === 1) return transcripts[0].id;
    return null;
}

/**
 * Validate the optional `attachments` argument shared by all three tools.
 * Returns the array (or undefined when absent), or an error ToolResult to
 * surface to the agent when it is present but not an array.
 */
type ParsedAttachments = { attachments?: any[] } | { error: ToolResult };

function parseAttachments(value: unknown): ParsedAttachments {
    if (value === undefined) return {};
    if (!Array.isArray(value)) {
        return { error: textResult("Error: 'attachments' must be an array.", true) };
    }
    return { attachments: value };
}

/**
 * Validate the optional `edits` argument of update_memory. Returns the typed
 * edit list (or undefined when absent), or an error ToolResult when the shape
 * is wrong. Find-and-replace semantics themselves are enforced later by
 * `applyContentEdits`.
 */
type ParsedEdits = { edits?: ContentEdit[] } | { error: ToolResult };

function parseEdits(value: unknown): ParsedEdits {
    if (value === undefined) return {};
    if (!Array.isArray(value)) {
        return { error: textResult("Error: 'edits' must be an array.", true) };
    }
    if (value.length === 0) {
        return { error: textResult("Error: 'edits' must contain at least one edit.", true) };
    }
    const edits: ContentEdit[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            return { error: textResult("Error: each edit must be an object with 'oldText' and 'newText'.", true) };
        }
        const { oldText, newText, replaceAll } = item as Record<string, unknown>;
        if (typeof oldText !== 'string' || typeof newText !== 'string') {
            return { error: textResult("Error: each edit requires string 'oldText' and 'newText'.", true) };
        }
        if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
            return { error: textResult("Error: 'replaceAll' must be a boolean when provided.", true) };
        }
        edits.push({ oldText, newText, ...(replaceAll !== undefined && { replaceAll }) });
    }
    return { edits };
}

/** Fixed top-N for the title-index `recall` tool. No agent-facing limit param. */
export const RECALL_FIXED_LIMIT = 10;

/**
 * Render an epoch-millisecond timestamp as a compact relative age
 * ("just now", "5m ago", "3d ago", "2y ago") so the agent can judge how
 * fresh a memory is. Future timestamps (clock skew) read "just now".
 */
function formatRelativeAge(timestamp: number, now: number = Date.now()): string {
    const diffMs = now - timestamp;
    if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
}

/**
 * Per-hit track-record line rendered whenever stats exist for that memory.
 * Only non-zero tallies are shown, EXCEPT that `failed`/`stale` are always
 * both shown together once either is non-zero, prefixed with `⚠`:
 *
 *   track record: recalled 7×, worked 3× (last: worked 2d ago)
 *   ⚠ track record: recalled 9×, worked 1×, failed 3× (last: failed 4h ago)
 *
 * Returns null when no stats exist for the memory yet.
 */
function formatTrackRecordLine(stats: MemoryStats | undefined, now: number = Date.now()): string | null {
    if (!stats) return null;
    const hasBadOutcomes = stats.failedCount + stats.staleCount > 0;
    const parts = [`recalled ${stats.recallCount}×`];
    if (stats.workedCount > 0) parts.push(`worked ${stats.workedCount}×`);
    if (hasBadOutcomes) {
        if (stats.failedCount > 0) parts.push(`failed ${stats.failedCount}×`);
        if (stats.staleCount > 0) parts.push(`stale ${stats.staleCount}×`);
    }
    const lastOutcomeNote = stats.lastOutcome
        ? ` (last: ${stats.lastOutcome.outcome} ${formatRelativeAge(stats.lastOutcome.at, now)})`
        : '';
    const prefix = hasBadOutcomes ? '⚠ track record' : 'track record';
    return `${prefix}: ${parts.join(', ')}${lastOutcomeNote}`;
}

/**
 * Trust-weighted re-ranking multiplier (opt-in, `GEMDEX_TRUST_RANKING=true`).
 * Boosts memories with a strong `worked` history, demotes ones that have
 * burned the agent (`failed`/`stale`), and is exactly 1 — a no-op — for a
 * memory with no stats, so untracked memories keep their relative order.
 *
 *   trust = clamp( (1 + 0.08·ln(1+worked)) / (1 + 0.20·ln(1+failed+stale)), 0.6, 1.4 )
 */
function trustMultiplier(stats: MemoryStats | undefined): number {
    if (!stats) return 1;
    const boost = 1 + 0.08 * Math.log(1 + stats.workedCount);
    const penalty = 1 + 0.20 * Math.log(1 + stats.failedCount + stats.staleCount);
    return Math.min(1.4, Math.max(0.6, boost / penalty));
}

/**
 * Per-hit attachment line for full-memory output (`get_memory`). Surfaces
 * each attachment's kind, stable id, and caption so the agent knows media
 * exists and can fetch bytes via `read_attachment`. Returns null when none.
 */
function formatAttachmentsLine(
    attachments: { id: string; kind: string; caption?: string }[] | undefined,
): string | null {
    if (!attachments || attachments.length === 0) return null;
    const parts = attachments.map((a) => {
        const caption = a.caption ? `: "${a.caption}"` : '';
        return `${a.kind} (id ${a.id}${caption})`;
    });
    return `attachments: ${parts.join(', ')}`;
}

/** Render the confirmation block returned to the agent after a save/update. */
function formatMemoryResult(verb: string, memory: { id: string; title: string; attachments?: { id: string }[] }): string {
    const lines = [`${verb} memory.`, `id: ${memory.id}`, `title: ${memory.title}`];
    const count = memory.attachments?.length ?? 0;
    if (count > 0) lines.push(`attachments: ${count}`);
    return lines.join('\n');
}

/**
 * Advisory near-duplicate/conflict block appended after `save_memory` when
 * the backend's save-time detection (`MemoryStore.findSimilarParents`)
 * returned candidates. Purely additive — absent entirely when `similar` is
 * empty/undefined (e.g. detection disabled, first save into an empty store,
 * or a remote/BYOI backend that doesn't run detection yet). The id is shown
 * in full (not truncated) since the advisory text asks the agent to pass it
 * straight into `update_memory`.
 */
function formatSimilarBlock(similar: SimilarMemoryRef[], now: number = Date.now()): string {
    const lines = ['⚠ similar existing memories already stored:'];
    similar.forEach((ref, i) => {
        const age = formatRelativeAge(ref.updatedAt, now);
        lines.push(`  ${i + 1}. "${ref.title}" (id ${ref.id}, updated ${age}, ${ref.similarity.toFixed(2)} similar)`);
    });
    lines.push(
        'If the new memory revises or duplicates one of these, consolidate: keep ONE',
        'canonical memory — update_memory the existing id with the merged content (or',
        'confirm with the user which should win). Avoid leaving both.',
    );
    return lines.join('\n');
}

export class MemoryToolHandlers {
    private store: MemoryBackend;
    private statsStore: MemoryStatsStore;

    constructor(store: MemoryBackend, statsStore: MemoryStatsStore) {
        this.store = store;
        this.statsStore = statsStore;
    }

    async handleSaveMemory(args: any): Promise<ToolResult> {
        const content = typeof args?.content === 'string' ? args.content : '';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        const parsed = parseAttachments(args?.attachments);
        if ('error' in parsed) return parsed.error;
        const attachments = parsed.attachments;
        const hasAttachments = (attachments?.length ?? 0) > 0;
        if (content.trim().length === 0 && !hasAttachments) {
            return textResult("Error: provide 'content' or at least one attachment.", true);
        }
        try {
            const resolved = attachments && await resolveAttachmentInputs(attachments);
            const memory = await this.store.save({ content, title, ...(resolved && { attachments: resolved }) });
            const base = formatMemoryResult('Saved', memory);
            const similarBlock = memory.similar && memory.similar.length > 0
                ? `\n\n${formatSimilarBlock(memory.similar)}`
                : '';
            return textResult(base + similarBlock);
        } catch (error) {
            return textResult(`Failed to save memory: ${errorMessage(error)}`, true);
        }
    }

    /**
     * Title-index search. Always returns up to RECALL_FIXED_LIMIT ranked hits
     * as title + id (+ track-record when stats exist). Never returns bodies —
     * agents open a specific hit with `get_memory`. Does not bump recall
     * stats; opening the body via `get_memory` is what counts as a recall.
     */
    async handleRecall(args: any): Promise<ToolResult> {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) {
            return textResult("Error: 'query' is required.", true);
        }
        const label = `"${query}"`;
        // Read once per call: an unparseable/missing value is simply "not
        // 'true'" => off, so ranking stays byte-identical to backend order
        // whenever the flag is unset.
        const trustRankingEnabled = (envManager.get('GEMDEX_TRUST_RANKING') ?? '').toLowerCase() === 'true';
        try {
            // Flag off: fetch exactly N. Flag on: over-fetch so re-ranking has
            // room to promote/demote past the raw-relevance cutoff.
            const fetchLimit = trustRankingEnabled
                ? Math.min(Math.max(RECALL_FIXED_LIMIT * 2, RECALL_FIXED_LIMIT + 5), 100)
                : RECALL_FIXED_LIMIT;
            const fetched = await this.store.recall(query, fetchLimit);
            const results = trustRankingEnabled
                ? this.applyTrustRanking(fetched).slice(0, RECALL_FIXED_LIMIT)
                : fetched;
            if (results.length === 0) {
                return textResult(`No memories matched ${label}. Nothing stored yet, or no relevant match.`);
            }

            const now = Date.now();
            const blocks = results.map((r, i) => {
                const lines = [
                    `${i + 1}. ${r.title}`,
                    `   id: ${r.id}`,
                ];
                const trackRecordLine = formatTrackRecordLine(this.safeGetStats(r.id), now);
                if (trackRecordLine) lines.push(`   ${trackRecordLine}`);
                return lines.join('\n');
            });
            const header = `Recalled ${results.length} ${results.length === 1 ? 'memory' : 'memories'} for ${label} (titles only — call get_memory with an id to open full content):\n`;
            return textResult(header + '\n' + blocks.join('\n\n'));
        } catch (error) {
            return textResult(`Failed to recall memories: ${errorMessage(error)}`, true);
        }
    }

    /**
     * Load one full parent memory by id. This is the only MCP path that
     * returns body text. Bumps per-client recall stats on success (best-effort).
     */
    async handleGetMemory(args: any): Promise<ToolResult> {
        const id = typeof args?.id === 'string' ? args.id.trim() : '';
        if (id.length === 0) {
            return textResult("Error: 'id' is required.", true);
        }
        try {
            const memory = await this.store.get(id);
            if (!memory) {
                return textResult(`Failed to get memory: Memory not found: ${id}`, true);
            }

            try {
                this.statsStore.recordRecall([id]);
            } catch (error) {
                // Telemetry only — a stats-store failure must never break get_memory.
                console.error('Failed to record recall stats:', errorMessage(error));
            }

            const now = Date.now();
            const lines = [
                memory.title,
                `id: ${memory.id}`,
                `updated: ${formatRelativeAge(memory.updatedAt, now)}`,
            ];
            const trackRecordLine = formatTrackRecordLine(this.safeGetStats(id), now);
            if (trackRecordLine) lines.push(trackRecordLine);
            const attachmentsLine = formatAttachmentsLine(memory.attachments);
            if (attachmentsLine) lines.push(attachmentsLine);
            lines.push('', memory.content);
            return textResult(lines.join('\n'));
        } catch (error) {
            return textResult(`Failed to get memory: ${errorMessage(error)}`, true);
        }
    }

    /**
     * Re-rank over-fetched recall hits by `score * trustMultiplier(stats)`
     * (stable-ish: `Array.prototype.sort` preserves the backend's relative
     * order for ties, and untracked memories carry `trust = 1` so their
     * relative order among themselves is unchanged).
     */
    private applyTrustRanking(hits: MemoryRecallResult[]): MemoryRecallResult[] {
        return hits
            .map((hit) => ({ hit, adjustedScore: hit.score * trustMultiplier(this.safeGetStats(hit.id)) }))
            .sort((a, b) => b.adjustedScore - a.adjustedScore)
            .map(({ hit }) => hit);
    }

    /**
     * `MemoryStatsStore.get` reads a file on every call; a stats-store
     * failure anywhere in rendering (track-record line, trust ranking) must
     * degrade to "no stats" rather than break the tool — telemetry is never
     * allowed to be a single point of failure.
     */
    private safeGetStats(id: string): MemoryStats | undefined {
        try {
            return this.statsStore.get(id);
        } catch (error) {
            console.error('Failed to read recall stats:', errorMessage(error));
            return undefined;
        }
    }

    async handleUpdateMemory(args: any): Promise<ToolResult> {
        const id = typeof args?.id === 'string' ? args.id : '';
        if (id.trim().length === 0) {
            return textResult("Error: 'id' is required.", true);
        }
        const hasContent = typeof args?.content === 'string';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        const parsed = parseAttachments(args?.attachments);
        if ('error' in parsed) return parsed.error;
        const attachments = parsed.attachments;
        const parsedEdits = parseEdits(args?.edits);
        if ('error' in parsedEdits) return parsedEdits.error;
        const edits = parsedEdits.edits;
        if (hasContent && edits !== undefined) {
            return textResult("Error: provide either 'content' or 'edits', not both.", true);
        }
        if (!hasContent && edits === undefined && title === undefined && attachments === undefined) {
            return textResult("Error: provide at least one of 'content', 'edits', 'title', or 'attachments' to update.", true);
        }
        // Only include provided fields so the store preserves the rest in place.
        const input: { content?: string; title?: string; attachments?: any[] } = {};
        if (hasContent) input.content = args.content;
        if (title !== undefined) input.title = title;
        try {
            // Resolve attachments first (reads + base64-encodes files off disk)
            // so the slow I/O happens BEFORE the get(id) below — keeping the
            // read-modify-write window for `edits` as small as possible.
            if (attachments !== undefined) input.attachments = await resolveAttachmentInputs(attachments);
            // `edits` are applied client-side against the current content, then
            // persisted via the normal full-content update path. The agent only
            // emits the changed snippets — no need to resend a whole large note.
            // Note: read-modify-write is last-write-wins; a concurrent edit
            // between this fetch and the update is overwritten.
            if (edits !== undefined) {
                const current = await this.store.get(id);
                if (!current) {
                    return textResult(`Failed to update memory: Memory not found: ${id}`, true);
                }
                input.content = applyContentEdits(current.content, edits);
            }
            const memory = await this.store.update(id, input);
            return textResult(formatMemoryResult('Updated', memory));
        } catch (error) {
            return textResult(`Failed to update memory: ${errorMessage(error)}`, true);
        }
    }

    /**
     * Read attachment bytes for a memory (local blob store or remote HTTP).
     * Used for chat digests that store the full transcript as a non-embedded
     * `file` attachment, and for any other attachment agents need as text/base64.
     *
     * Args: `memory_id` (required), optional `attachment_id`, optional `max_chars`
     * (default ~1.5M chars). When `attachment_id` is omitted, prefers a single
     * transcript/`file` attachment, else the only attachment on the memory.
     */
    async handleReadAttachment(args: any): Promise<ToolResult> {
        const memoryId = typeof args?.memory_id === 'string'
            ? args.memory_id
            : (typeof args?.memoryId === 'string' ? args.memoryId : '');
        if (memoryId.trim().length === 0) {
            return textResult("Error: 'memory_id' is required.", true);
        }
        const explicitAttachmentId = typeof args?.attachment_id === 'string'
            ? args.attachment_id
            : (typeof args?.attachmentId === 'string' ? args.attachmentId : undefined);
        const maxCharsRaw = args?.max_chars ?? args?.maxChars;
        const maxChars = typeof maxCharsRaw === 'number' && Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
            ? Math.floor(maxCharsRaw)
            : DEFAULT_READ_ATTACHMENT_MAX_CHARS;

        try {
            const memory = await this.store.get(memoryId);
            if (!memory) {
                return textResult(`Failed to read attachment: Memory not found: ${memoryId}`, true);
            }
            if (!memory.attachments || memory.attachments.length === 0) {
                return textResult(
                    `Failed to read attachment: Memory ${memoryId} has no attachments.` +
                    (memory.content.includes('Full transcript:')
                        ? ' Digest still has a local path footer — use read_attachment after backfill, or open the path when local.'
                        : ''),
                    true,
                );
            }

            const attachmentId = explicitAttachmentId?.trim()
                ? explicitAttachmentId.trim()
                : pickDefaultAttachmentId(memory.attachments);
            if (!attachmentId) {
                const listed = memory.attachments
                    .map((a) => `${a.id} (${a.kind}${a.caption ? `: "${a.caption}"` : ''})`)
                    .join(', ');
                return textResult(
                    `Error: multiple attachments; pass 'attachment_id'. Available: ${listed}`,
                    true,
                );
            }

            const meta = memory.attachments.find((a) => a.id === attachmentId);
            if (!meta) {
                const listed = memory.attachments.map((a) => a.id).join(', ');
                return textResult(
                    `Failed to read attachment: Attachment ${attachmentId} not found on ${memoryId}. Available: ${listed}`,
                    true,
                );
            }

            const bytes = await this.store.readAttachment(memoryId, attachmentId);
            if (!bytes) {
                return textResult(
                    `Failed to read attachment: Blob missing for ${memoryId}/${attachmentId}.`,
                    true,
                );
            }

            const header = [
                `Attachment ${attachmentId} of memory ${memoryId}`,
                `kind: ${meta.kind}`,
                `mimeType: ${bytes.mimeType}`,
                `byteLength: ${bytes.byteLength}`,
                ...(bytes.caption ? [`caption: ${bytes.caption}`] : []),
            ].join('\n');

            if (isTextishMime(bytes.mimeType)) {
                const text = bytes.data.toString('utf8');
                if (text.length <= maxChars) {
                    return textResult(`${header}\nencoding: utf-8\n\n${text}`);
                }
                const truncated = text.slice(0, maxChars);
                return textResult(
                    `${header}\nencoding: utf-8\ntruncated: true\n` +
                    `showingChars: ${maxChars} of ${text.length}\n` +
                    `(raise max_chars to read more; default is ${DEFAULT_READ_ATTACHMENT_MAX_CHARS})\n\n` +
                    truncated,
                );
            }

            const b64 = bytes.data.toString('base64');
            const maxB64Chars = maxChars;
            if (b64.length <= maxB64Chars) {
                return textResult(`${header}\nencoding: base64\n\n${b64}`);
            }
            return textResult(
                `${header}\nencoding: base64\ntruncated: true\n` +
                `showingChars: ${maxB64Chars} of ${b64.length} (base64)\n` +
                `(raise max_chars to read more)\n\n` +
                b64.slice(0, maxB64Chars),
            );
        } catch (error) {
            return textResult(`Failed to read attachment: ${errorMessage(error)}`, true);
        }
    }

    /**
     * Record how acting on a recalled memory actually went. Validates the id
     * against the backend first (`store.get`, works identically on local and
     * remote) so junk ids never pollute the stats ledger, then delegates the
     * tally to `MemoryStatsStore.recordOutcome`.
     */
    async handleReportOutcome(args: any): Promise<ToolResult> {
        const id = typeof args?.id === 'string' ? args.id : '';
        if (id.trim().length === 0) {
            return textResult("Error: 'id' is required.", true);
        }
        const outcome = args?.outcome;
        if (outcome !== 'worked' && outcome !== 'failed' && outcome !== 'stale') {
            return textResult("Error: 'outcome' must be one of 'worked', 'failed', or 'stale'.", true);
        }
        if (args?.note !== undefined && typeof args.note !== 'string') {
            return textResult("Error: 'note' must be a string when provided.", true);
        }
        const note: string | undefined = args?.note;
        try {
            const memory = await this.store.get(id);
            if (!memory) {
                return textResult(`Failed to report outcome: Memory not found: ${id}`, true);
            }
            const stats = this.statsStore.recordOutcome(id, outcome as MemoryOutcome, note);
            const lines = [
                `Recorded outcome for "${memory.title}".`,
                `id: ${id}`,
                `track record: recalled ${stats.recallCount}×, worked ${stats.workedCount}×, ` +
                `failed ${stats.failedCount}×, stale ${stats.staleCount}×`,
            ];
            return textResult(lines.join('\n'));
        } catch (error) {
            return textResult(`Failed to report outcome: ${errorMessage(error)}`, true);
        }
    }
}
