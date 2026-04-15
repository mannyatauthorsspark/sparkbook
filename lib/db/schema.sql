-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Core
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created', -- created|ingesting|embedding|ready|generating|done
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ingestion
CREATE TABLE ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- youtube|tiktok
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ingestion_job_id UUID REFERENCES ingestion_jobs(id),
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,  -- YouTube video ID or TikTok video ID
  title TEXT,
  url TEXT,
  duration_s INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, platform, external_id)
);

CREATE TABLE transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  source_type TEXT NOT NULL, -- native_captions|downloaded|asr_fallback
  source_confidence REAL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks + Embeddings
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  token_count INTEGER,
  chunk_offset INTEGER,
  source_type TEXT,
  source_confidence REAL DEFAULT 1.0,
  chapter_id UUID,  -- set when assigned to a chapter
  used BOOLEAN DEFAULT FALSE,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for vector similarity search
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON chunks (project_id, used);

-- Book
CREATE TABLE outlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL, -- markdown
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '', -- markdown
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chapter_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add foreign key from chunks → chapters
ALTER TABLE chunks ADD CONSTRAINT chunks_chapter_fk
  FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL;

-- Exports
CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format TEXT NOT NULL, -- epub|pdf|docx
  r2_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
