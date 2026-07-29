export interface SqlMigration {
    version: string;
    name: string;
    sql: string;
}

export const MIGRATIONS: SqlMigration[] = [
    {
        version: '001',
        name: 'initial_remote_memories',
        sql: `
CREATE TABLE IF NOT EXISTS gemdex_schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gemdex_memory_documents (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS gemdex_attachment_blobs (
    id UUID PRIMARY KEY,
    storage_provider TEXT NOT NULL DEFAULT 'postgres',
    storage_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS gemdex_memory_attachments (
    memory_id UUID NOT NULL REFERENCES gemdex_memory_documents(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'pdf')),
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    caption TEXT,
    blob_ref_id UUID NOT NULL REFERENCES gemdex_attachment_blobs(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (memory_id, id),
    UNIQUE (memory_id, ordinal),
    UNIQUE (blob_ref_id)
);

CREATE TABLE IF NOT EXISTS gemdex_memory_chunks (
    id UUID PRIMARY KEY,
    memory_id UUID NOT NULL REFERENCES gemdex_memory_documents(id) ON DELETE CASCADE,
    attachment_id TEXT,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_kind TEXT NOT NULL CHECK (chunk_kind IN ('text', 'attachment')),
    content TEXT NOT NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    embedding DOUBLE PRECISION[],
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    FOREIGN KEY (memory_id, attachment_id) REFERENCES gemdex_memory_attachments(memory_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS gemdex_memory_chunks_unique_text_idx
    ON gemdex_memory_chunks (memory_id, chunk_kind, chunk_index)
    WHERE attachment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gemdex_memory_chunks_unique_attachment_idx
    ON gemdex_memory_chunks (memory_id, attachment_id)
    WHERE attachment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gemdex_memory_documents_updated_idx
    ON gemdex_memory_documents (updated_at DESC, id);

CREATE INDEX IF NOT EXISTS gemdex_memory_chunks_memory_idx
    ON gemdex_memory_chunks (memory_id);

CREATE INDEX IF NOT EXISTS gemdex_memory_attachments_memory_idx
    ON gemdex_memory_attachments (memory_id, ordinal);
`,
    },
    {
        version: '002',
        name: 'pgvector_recall',
        sql: `
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE gemdex_memory_chunks
    ADD COLUMN IF NOT EXISTS embedding_vector vector;
`,
    },
    {
        // Option C: deterministic digest ids (`chat:<source>:<sessionId>`) are not
        // UUIDs. Real UUID strings remain valid as TEXT. Also allow blob-only
        // `file` attachments (full transcripts) without embedding the body.
        //
        // Table rebuild (not in-place ALTER … TYPE) so:
        // 1. Real Postgres widens UUID → TEXT safely with data copy.
        // 2. pg-mem (tests) retains a working primary key / FK graph after the change
        //    (in-place ALTER COLUMN TYPE leaves its unique indexes unusable for FKs).
        version: '003',
        name: 'text_memory_ids_and_file_attachments',
        sql: `
-- Copy → drop children first → drop parents → rename. Avoids relying on
-- auto-generated FK constraint names (Postgres uses _fkey; pg-mem uses _fk).

CREATE TABLE gemdex_memory_documents_v3 (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO gemdex_memory_documents_v3 (id, title, content, created_at, updated_at, metadata)
SELECT id::text, title, content, created_at, updated_at, metadata
FROM gemdex_memory_documents;

CREATE TABLE gemdex_memory_attachments_v3 (
    memory_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'pdf', 'file')),
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    caption TEXT,
    blob_ref_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (memory_id, id),
    UNIQUE (memory_id, ordinal),
    UNIQUE (blob_ref_id)
);
INSERT INTO gemdex_memory_attachments_v3 (
    memory_id, id, ordinal, kind, mime_type, byte_length, caption, blob_ref_id, created_at, updated_at, metadata
)
SELECT memory_id::text, id, ordinal, kind, mime_type, byte_length, caption, blob_ref_id, created_at, updated_at, metadata
FROM gemdex_memory_attachments;

CREATE TABLE gemdex_memory_chunks_v3 (
    id UUID PRIMARY KEY,
    memory_id TEXT NOT NULL,
    attachment_id TEXT,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_kind TEXT NOT NULL CHECK (chunk_kind IN ('text', 'attachment')),
    content TEXT NOT NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    embedding DOUBLE PRECISION[],
    embedding_vector vector,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO gemdex_memory_chunks_v3 (
    id, memory_id, attachment_id, chunk_index, chunk_kind, content, start_offset, end_offset,
    embedding, embedding_vector, created_at, updated_at, metadata
)
SELECT id, memory_id::text, attachment_id, chunk_index, chunk_kind, content, start_offset, end_offset,
    embedding, embedding_vector, created_at, updated_at, metadata
FROM gemdex_memory_chunks;

DROP TABLE gemdex_memory_chunks;
DROP TABLE gemdex_memory_attachments;
DROP TABLE gemdex_memory_documents;

ALTER TABLE gemdex_memory_documents_v3 RENAME TO gemdex_memory_documents;
ALTER TABLE gemdex_memory_attachments_v3 RENAME TO gemdex_memory_attachments;
ALTER TABLE gemdex_memory_chunks_v3 RENAME TO gemdex_memory_chunks;

ALTER TABLE gemdex_memory_attachments
    ADD CONSTRAINT gemdex_memory_attachments_memory_id_fkey
    FOREIGN KEY (memory_id) REFERENCES gemdex_memory_documents(id) ON DELETE CASCADE;
ALTER TABLE gemdex_memory_attachments
    ADD CONSTRAINT gemdex_memory_attachments_blob_ref_id_fkey
    FOREIGN KEY (blob_ref_id) REFERENCES gemdex_attachment_blobs(id) ON DELETE RESTRICT;
ALTER TABLE gemdex_memory_chunks
    ADD CONSTRAINT gemdex_memory_chunks_memory_id_fkey
    FOREIGN KEY (memory_id) REFERENCES gemdex_memory_documents(id) ON DELETE CASCADE;
ALTER TABLE gemdex_memory_chunks
    ADD CONSTRAINT gemdex_memory_chunks_memory_id_attachment_id_fkey
    FOREIGN KEY (memory_id, attachment_id)
    REFERENCES gemdex_memory_attachments(memory_id, id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS gemdex_memory_chunks_unique_text_idx
    ON gemdex_memory_chunks (memory_id, chunk_kind, chunk_index)
    WHERE attachment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gemdex_memory_chunks_unique_attachment_idx
    ON gemdex_memory_chunks (memory_id, attachment_id)
    WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gemdex_memory_documents_updated_idx
    ON gemdex_memory_documents (updated_at DESC, id);
CREATE INDEX IF NOT EXISTS gemdex_memory_chunks_memory_idx
    ON gemdex_memory_chunks (memory_id);
CREATE INDEX IF NOT EXISTS gemdex_memory_attachments_memory_idx
    ON gemdex_memory_attachments (memory_id, ordinal);
`,
    },
];
