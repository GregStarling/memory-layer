-- memory-layer PostgreSQL schema
-- Compatible with PostgreSQL 14+ with pgvector extension

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS turns (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at INTEGER,
  compaction_log_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_turns_scope ON turns (tenant_id, system_id, workspace_id, collaboration_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns (session_id);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns (status);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns (created_at);

CREATE TABLE IF NOT EXISTS working_memory (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_entities JSONB NOT NULL DEFAULT '[]',
  topic_tags JSONB NOT NULL DEFAULT '[]',
  turn_id_start INTEGER NOT NULL,
  turn_id_end INTEGER NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  compaction_trigger TEXT NOT NULL DEFAULT 'soft',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  expires_at INTEGER,
  promoted_to_knowledge_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS episode_recap JSONB;

CREATE INDEX IF NOT EXISTS idx_wm_scope ON working_memory (tenant_id, system_id, workspace_id, collaboration_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory (session_id);
CREATE INDEX IF NOT EXISTS idx_wm_status ON working_memory (status);

CREATE TABLE IF NOT EXISTS knowledge_memory (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('preference', 'entity', 'decision', 'constraint', 'reference')),
  fact_subject TEXT,
  fact_attribute TEXT,
  fact_value TEXT,
  normalized_fact TEXT,
  slot_key TEXT,
  is_negated BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL CHECK (source IN ('user_stated', 'promoted_from_working', 'manual')),
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium')),
  source_system_id TEXT,
  source_scope_id TEXT,
  source_collaboration_id TEXT,
  source_working_memory_id INTEGER,
  superseded_by_id INTEGER,
  retired_at INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_km_scope ON knowledge_memory (tenant_id, system_id, workspace_id, collaboration_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_km_active ON knowledge_memory (superseded_by_id, retired_at);
CREATE INDEX IF NOT EXISTS idx_km_fact_type ON knowledge_memory (fact_type);
CREATE INDEX IF NOT EXISTS idx_km_slot_key ON knowledge_memory (slot_key);

-- Full-text search on knowledge_memory
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_km_fts ON knowledge_memory USING GIN (search_vector);

-- Trigger to auto-update search_vector
CREATE OR REPLACE FUNCTION knowledge_memory_search_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.fact, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_km_search ON knowledge_memory;
CREATE TRIGGER trg_km_search
  BEFORE INSERT OR UPDATE ON knowledge_memory
  FOR EACH ROW EXECUTE FUNCTION knowledge_memory_search_trigger();

CREATE TABLE IF NOT EXISTS knowledge_memory_audit (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  working_memory_id INTEGER NOT NULL,
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_subject TEXT,
  fact_attribute TEXT,
  fact_value TEXT,
  normalized_fact TEXT,
  slot_key TEXT,
  is_negated BOOLEAN NOT NULL DEFAULT FALSE,
  confidence TEXT NOT NULL DEFAULT 'medium',
  source_text TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT,
  related_knowledge_id INTEGER,
  created_knowledge_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_kma_scope ON knowledge_memory_audit (tenant_id, system_id, workspace_id, collaboration_id, scope_id);

CREATE TABLE IF NOT EXISTS work_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'objective' CHECK (kind IN ('objective', 'unresolved_work', 'constraint')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'done')),
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_wi_scope ON work_items (tenant_id, system_id, workspace_id, collaboration_id, scope_id);

CREATE TABLE IF NOT EXISTS context_monitor (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  compaction_state TEXT NOT NULL DEFAULT 'idle',
  active_turn_count INTEGER NOT NULL DEFAULT 0,
  active_token_estimate INTEGER NOT NULL DEFAULT 0,
  compaction_score REAL NOT NULL DEFAULT 0,
  last_compaction_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  UNIQUE (tenant_id, system_id, workspace_id, collaboration_id, scope_id)
);

CREATE TABLE IF NOT EXISTS compaction_log (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  turn_id_start INTEGER NOT NULL,
  turn_id_end INTEGER NOT NULL,
  turns_compacted INTEGER NOT NULL DEFAULT 0,
  tokens_compacted_estimate INTEGER NOT NULL DEFAULT 0,
  working_memory_id INTEGER NOT NULL,
  active_turn_count_before INTEGER NOT NULL DEFAULT 0,
  active_turn_count_after INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  model_call_made BOOLEAN NOT NULL DEFAULT FALSE,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_cl_scope ON compaction_log (tenant_id, system_id, workspace_id, collaboration_id, scope_id);

-- pgvector extension for semantic search (optional)
-- Run: CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id SERIAL PRIMARY KEY,
  knowledge_memory_id INTEGER NOT NULL UNIQUE REFERENCES knowledge_memory(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  embedding vector,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_ke_scope ON knowledge_embeddings (tenant_id, system_id, workspace_id, collaboration_id, scope_id);
-- For high-volume hosted retrieval, prefer ANN search via pgvector HNSW.
CREATE INDEX IF NOT EXISTS idx_ke_embedding_hnsw
  ON knowledge_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- Full-text search on turns
ALTER TABLE turns ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_turns_fts ON turns USING GIN (search_vector);

CREATE OR REPLACE FUNCTION turns_search_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_turns_search ON turns;
CREATE TRIGGER trg_turns_search
  BEFORE INSERT OR UPDATE ON turns
  FOR EACH ROW EXECUTE FUNCTION turns_search_trigger();

CREATE TABLE IF NOT EXISTS playbooks (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  references_json JSONB NOT NULL DEFAULT '[]',
  templates JSONB NOT NULL DEFAULT '[]',
  scripts JSONB NOT NULL DEFAULT '[]',
  assets JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  source_session_id TEXT,
  source_working_memory_id INTEGER REFERENCES working_memory(id),
  revision_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_pb_scope ON playbooks (tenant_id, system_id, workspace_id, collaboration_id, scope_id);

-- Full-text search on playbooks
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_pb_fts ON playbooks USING GIN (search_vector);

CREATE OR REPLACE FUNCTION playbooks_search_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.instructions, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pb_search ON playbooks;
CREATE TRIGGER trg_pb_search
  BEFORE INSERT OR UPDATE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION playbooks_search_trigger();

CREATE TABLE IF NOT EXISTS playbook_revisions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  playbook_id INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  instructions TEXT NOT NULL,
  revision_reason TEXT NOT NULL,
  source_session_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_pbr_playbook ON playbook_revisions (playbook_id, created_at DESC);

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
