export type AgentSource = 'Claude Code' | 'Codex' | 'Factory' | 'Manual' | (string & {});

export interface Attachment {
  id: string;
  kind: string;
  caption: string;
  mimeType: string;
  byteSize: number;
}

export interface Memory {
  id: string;
  title: string | null;
  preview: string | null;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: AgentSource;
  repo: string | null;
  branch: string | null;
  sessionId: string | null;
  attachments: Attachment[];
  /** Only present on recall (semantic) results. */
  score?: number;
}

/** Total memories in the pool on the backend; the client holds a page of them. */
export const POOL_TOTAL = 0;
export const INGESTED_TOTAL = 0;

export const MEMORIES: Memory[] = [];

export function memoryTitle(memory: Memory): string {
  if (memory.title && memory.title.trim()) return memory.title;
  if (memory.preview && memory.preview.trim()) return memory.preview.slice(0, 60);
  return 'Untitled memory';
}
