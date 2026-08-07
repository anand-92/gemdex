#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryBackend, MemoryStatsStore } from "gemdex-core";

import { createConfig, logConfigurationSummary, showHelpMessage, GemdexConfig } from "./config.js";
import { createMemoryBackend } from "./memory.js";
import { MemoryToolHandlers } from "./handlers.js";
import { runServe } from "./serve.js";
import { MCP_TOOL_NAMES } from "./tool-names.js";
import { runCli } from "./cli.js";

const SAVE_MEMORY_DESCRIPTION = `
Persist a new memory to the user's global, durable memory layer.

🎯 **When to use**: proactively, as you work — you do NOT need the user to ask.
Save durable, reusable knowledge the moment you learn it: hard-won fixes and
root causes, project conventions and architecture decisions, setup/build/deploy
steps, credentials and paths the user shares, gotchas, and the rationale behind
choices. If it's likely to matter in a future session or repo, store it now
without waiting for permission. Explicit user requests ("remember that…", "save
this") are just one trigger among many. Keep memories to durable, reusable facts
— skip one-off trivia and anything easily re-derived from the current context.

Behavior: the content is chunked, embedded via Gemini, and stored globally
(searchable from every repo and session). Returns the new memory id.

Multimodal: optionally pass \`attachments\` (image/audio/video/PDF) to embed
media alongside the text. Each attachment is either a local file \`path\`
(preferred — the server reads + encodes the bytes, so you don't emit base64) or
inline base64 \`data\`. Requires the gemini-embedding-2 model. Either \`content\`
or at least one attachment is required.

If the response includes a "⚠ similar existing memories already stored" block,
the store found near-duplicate/conflicting memories already there — read it and
consolidate with \`update_memory\` (or confirm with the user which should win)
rather than leaving both.
`;

const RECALL_DESCRIPTION = `
Search the user's global memory layer by natural-language query and return a
cheap ranked title index (never full bodies).

🎯 **When to use**: proactively and by default — make checking memory a reflex,
not something you wait to be told to do. Recall at the start of a task, before
solving a problem, before setting up a tool or environment, before making a
design/convention decision, and before asking the user for information they may
have already given you. A title-index recall is cheap; prefer checking first
over assuming nothing is stored.

Behavior: hybrid semantic + BM25 search, fused by relevance. Always returns up
to 10 hits as title + id only (plus a track-record line when outcome stats
exist). Most tasks end here with nothing useful — that is expected. When a
title looks clearly task-relevant, open THAT memory with \`get_memory({ id })\`.
Do not expect bodies from this tool.

Setting \`GEMDEX_TRUST_RANKING=true\` re-ranks the title index by track record
(off by default; ranking stays pure relevance until you opt in).
`;

const GET_MEMORY_DESCRIPTION = `
Load the full content of one stored memory by id.

🎯 **When to use**: after \`recall\` returns a title that looks clearly relevant
to the current task — or when you already have an exact id from \`save_memory\`.
This is the only MCP path that returns the full parent body. Most recalls need
no follow-up; only open memories you actually intend to use.

Behavior: returns title, id, relative age, optional track-record and attachment
metadata, and the full content. Use \`read_attachment\` afterward if you need
attachment/transcript bytes. Opening a memory counts as a recall for the
per-client outcome ledger (feeds track-record / optional trust ranking).
`;

const UPDATE_MEMORY_DESCRIPTION = `
Revise an existing memory in place, identified by its id.

🎯 **When to use**: proactively whenever you discover a stored memory is
outdated, wrong, or duplicated — not only when the user asks
("the notarization step changed — update that memory"). If you learn a better
fact, or a \`save_memory\` response flags "⚠ similar existing memories already
stored", prefer correcting/consolidating the existing memory in place over
leaving stale or conflicting copies. Get the id from a prior save_memory,
recall, or get_memory result.

Two ways to change the text:
- \`edits\`: targeted find-and-replace — preferred for large memories. Pass an
  array of \`{ oldText, newText, replaceAll? }\`; you emit only the changed
  snippets instead of resending the whole note. Each \`oldText\` must match
  exactly and be unique (set \`replaceAll: true\` to change every occurrence).
- \`content\`: full replacement of the text. Use for small memories or rewrites.
\`content\` and \`edits\` are mutually exclusive.

Behavior: re-chunks and re-embeds the resulting content under the same id.
Omitted fields are preserved — leave out \`content\`/\`edits\` to keep the prior
text, leave out \`attachments\` to keep the prior media (pass \`attachments: []\`
to clear it). Each attachment is either a local file \`path\` (preferred) or
inline base64 \`data\`. There is no delete via MCP — deletion is a human action
in the desktop app.
`;

const REPORT_OUTCOME_DESCRIPTION = `
Report how acting on a recalled memory went, so the memory layer learns which
memories are trustworthy.

🎯 **When to use**: right after you used a recalled memory and the outcome is
clear — \`worked\` (followed it and it was correct), \`failed\` (its information
was wrong or broken), \`stale\` (clearly outdated, e.g. rotated credentials or
moved paths). One call per memory actually used; do not report memories you
merely saw in results. This is meta-feedback on the memory layer itself and is
the one gemdex tool you should call without being asked, whenever a clear
outcome exists.

Recorded locally in a per-client ledger keyed by memory id (not written back
into the memory itself). With \`GEMDEX_TRUST_RANKING=true\` it also adjusts
future \`recall\` ranking — proven memories rank higher, memories that have
burned the agent rank lower.
`;

const READ_ATTACHMENT_DESCRIPTION = `
Read the bytes of an attachment on a stored memory as text (UTF-8) or base64.

🎯 **When to use**: after \`get_memory\` shows a memory with attachments —
especially chat digests that include a \`file\` attachment captioned
"Full transcript (source file)". Prefer this over opening a local path when
running in remote mode (BYOI): the bytes live in the server blob store and are
fetched over HTTP. No GEMINI_API_KEY required.

Args: \`memory_id\` (required), optional \`attachment_id\` (omit when there is
exactly one attachment, or a single transcript/\`file\` attachment), optional
\`max_chars\` (default ~1.5M; truncates with a clear overflow note).
`;

// JSON-schema fragment for the optional media array shared by save_memory /
// update_memory. Each item is EITHER a local file `path` (preferred for
// agents — the server reads + base64-encodes it, so no megabytes of base64
// land in tool-call args) OR inline base64 `data`.
const ATTACHMENTS_SCHEMA = {
    type: "array",
    description:
        "Optional media to embed. Each item is either a local file 'path' (preferred — the " +
        "server reads the bytes off disk; mimeType is inferred from the extension) or inline " +
        "base64 'data' with a 'mimeType'. Requires the gemini-embedding-2 model. " +
        "Limits: ≤6 images, ≤1 PDF, ≤1 audio, ≤1 video per memory.",
    items: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Absolute (or ~/cwd-relative) path to a local media file. Preferred over 'data'. Mutually exclusive with 'data'.",
            },
            mimeType: {
                type: "string",
                description: "image/png, image/jpeg, audio/mp3, audio/wav, video/mp4, video/quicktime, or application/pdf. Required with 'data'; optional with 'path' (inferred from the extension).",
            },
            data: {
                type: "string",
                description: "Base64-encoded bytes of the attachment. Mutually exclusive with 'path'.",
            },
            caption: {
                type: "string",
                description: "Optional text describing this attachment; backs the BM25 (keyword) branch for it.",
            },
        },
        anyOf: [
            { required: ["path"] },
            { required: ["data", "mimeType"] },
        ],
    },
} as const;

class GemdexMemoryServer {
    private server: Server;
    private handlers: MemoryToolHandlers;

    constructor(config: GemdexConfig) {
        this.server = new Server(
            { name: config.name, version: config.version },
            { capabilities: { tools: {} } },
        );

        const store: MemoryBackend = createMemoryBackend(config);
        const statsStore = new MemoryStatsStore();
        this.handlers = new MemoryToolHandlers(store, statsStore);

        this.setupTools();
    }

    private setupTools() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: MCP_TOOL_NAMES[0],
                    description: SAVE_MEMORY_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            content: {
                                type: "string",
                                description: "The memory content. A one-line fact or a long playbook — anything. Recommended; optional only when attachments are provided.",
                            },
                            title: {
                                type: "string",
                                description: "Optional human-readable name. Auto-derived from content if omitted.",
                            },
                            attachments: ATTACHMENTS_SCHEMA,
                        },
                        required: [],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[1],
                    description: RECALL_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Natural-language description of what to recall.",
                            },
                        },
                        required: ["query"],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[2],
                    description: GET_MEMORY_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string",
                                description: "The id of the memory to open (from recall or save_memory).",
                            },
                        },
                        required: ["id"],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[3],
                    description: UPDATE_MEMORY_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string",
                                description: "The id of the memory to revise (from save_memory, recall, or get_memory).",
                            },
                            content: {
                                type: "string",
                                description: "Full replacement text. Omit to keep the existing text. Mutually exclusive with 'edits'; prefer 'edits' for large memories.",
                            },
                            edits: {
                                type: "array",
                                description:
                                    "Targeted find-and-replace edits applied to the current content — the preferred way to change part of a large memory without resending the whole note. Applied in order. Mutually exclusive with 'content'.",
                                items: {
                                    type: "object",
                                    properties: {
                                        oldText: {
                                            type: "string",
                                            description: "Exact substring to find (literal, not regex). Must be unique unless 'replaceAll' is true.",
                                        },
                                        newText: {
                                            type: "string",
                                            description: "Text to replace 'oldText' with. Must differ from 'oldText'.",
                                        },
                                        replaceAll: {
                                            type: "boolean",
                                            description: "Replace every occurrence of 'oldText'. Defaults to false (requires a unique match).",
                                        },
                                    },
                                    required: ["oldText", "newText"],
                                },
                            },
                            title: {
                                type: "string",
                                description: "Optional new title. Omit to keep the existing title.",
                            },
                            attachments: ATTACHMENTS_SCHEMA,
                        },
                        required: ["id"],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[4],
                    description: REPORT_OUTCOME_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string",
                                description: "The id of the memory you acted on (from a prior get_memory or save_memory result).",
                            },
                            outcome: {
                                type: "string",
                                enum: ["worked", "failed", "stale"],
                                description: "'worked' — followed it and it was correct. 'failed' — its information was wrong or broken. 'stale' — clearly outdated (e.g. rotated credentials, moved paths).",
                            },
                            note: {
                                type: "string",
                                description: "Optional one-line note on what happened (e.g. \"notarytool flags changed; --wait no longer accepts --timeout\"). Capped at 500 characters.",
                            },
                        },
                        required: ["id", "outcome"],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[5],
                    description: READ_ATTACHMENT_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            memory_id: {
                                type: "string",
                                description: "Id of the parent memory (from save_memory, recall, or get_memory).",
                            },
                            attachment_id: {
                                type: "string",
                                description: "Optional attachment id. Omit when the memory has a single attachment or a single Full transcript file attachment.",
                            },
                            max_chars: {
                                type: "number",
                                description: "Max characters of text/base64 to return (default 1500000). Truncates with an overflow note when exceeded.",
                            },
                        },
                        required: ["memory_id"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            switch (name) {
                case MCP_TOOL_NAMES[0]:
                    return await this.handlers.handleSaveMemory(args);
                case MCP_TOOL_NAMES[1]:
                    return await this.handlers.handleRecall(args);
                case MCP_TOOL_NAMES[2]:
                    return await this.handlers.handleGetMemory(args);
                case MCP_TOOL_NAMES[3]:
                    return await this.handlers.handleUpdateMemory(args);
                case MCP_TOOL_NAMES[4]:
                    return await this.handlers.handleReportOutcome(args);
                case MCP_TOOL_NAMES[5]:
                    return await this.handlers.handleReadAttachment(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('Starting Gemdex Memory MCP server...');
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // `gemdex serve` (or `gemdex-mcp serve`) starts the localhost HTTP sidecar
    // that backs the desktop manager app, instead of the stdio MCP server.
    if (args[0] === 'serve') {
        await runServe(args.slice(1));
        return;
    }

    const cliExitCode = await runCli(args);
    if (cliExitCode !== null) {
        process.exitCode = cliExitCode;
        return;
    }

    const config = createConfig();
    logConfigurationSummary(config);

    const server = new GemdexMemoryServer(config);
    await server.start();
}

process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
