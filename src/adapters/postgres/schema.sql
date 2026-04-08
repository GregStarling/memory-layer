-- memory-layer PostgreSQL schema
-- Compatible with PostgreSQL 14+ with pgvector extension.
--
-- This file is a FRESH install + FORWARD-ONLY idempotent migration.
-- Every CREATE TABLE uses IF NOT EXISTS and every schema change after the
-- initial v1 baseline uses ALTER TABLE ADD COLUMN IF NOT EXISTS so the
-- same script is safe to run on empty and populated databases alike.
--
-- Schema version history (match src/adapters/sqlite/schema.ts):
--   v1  initial turns/working_memory/knowledge_memory
--   v9  cross-scope collaboration_id on every scoped table
--   v10 working_memory.episode_recap
--   v11 playbooks + playbook_revisions
--   v12 associations + full knowledge_memory parity with SQLite
--   v13 temporal event log + session_state_current + projection_watermarks
--   v14 coordination visibility + work claims + handoffs
-- Postgres tracks applied versions in schema_version.

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
  priority REAL NOT NULL DEFAULT 1.0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at INTEGER,
  compaction_log_id INTEGER,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

-- Forward-only: populated DBs created before v12 may lack priority/schema_version.
ALTER TABLE turns ADD COLUMN IF NOT EXISTS priority REAL NOT NULL DEFAULT 1.0;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;

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
  episode_recap JSONB,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

-- v10 forward migration
ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS episode_recap JSONB;
ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;

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
  knowledge_state TEXT NOT NULL DEFAULT 'trusted',
  knowledge_class TEXT NOT NULL DEFAULT 'project_fact',
  fact_subject TEXT,
  fact_attribute TEXT,
  fact_value TEXT,
  normalized_fact TEXT,
  slot_key TEXT,
  is_negated BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL CHECK (source IN ('user_stated', 'promoted_from_working', 'manual')),
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  confidence_score REAL NOT NULL DEFAULT 0.5,
  grounding_strength TEXT NOT NULL DEFAULT 'moderate',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  trust_score REAL NOT NULL DEFAULT 0.7,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_notes TEXT,
  last_verified_at INTEGER,
  next_reverification_at INTEGER,
  last_confirmed_at INTEGER,
  confirmation_count INTEGER NOT NULL DEFAULT 0,
  source_system_id TEXT,
  source_scope_id TEXT,
  source_collaboration_id TEXT,
  source_working_memory_id INTEGER,
  visibility_class TEXT NOT NULL DEFAULT 'private',
  source_turn_ids JSONB NOT NULL DEFAULT '[]',
  successful_use_count INTEGER NOT NULL DEFAULT 0,
  failed_use_count INTEGER NOT NULL DEFAULT 0,
  disputed_at INTEGER,
  dispute_reason TEXT,
  contradiction_score REAL NOT NULL DEFAULT 0,
  superseded_at INTEGER,
  superseded_by_id INTEGER,
  retired_at INTEGER,
  access_count INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 1,
  last_accessed_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

-- Forward-only parity columns (v12). Populated DBs from earlier versions may
-- be missing any of these; each is additive and nullable/defaulted so the
-- migration is safe to re-run.
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS knowledge_state TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS knowledge_class TEXT NOT NULL DEFAULT 'project_fact';
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS confidence_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS grounding_strength TEXT NOT NULL DEFAULT 'moderate';
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS trust_score REAL NOT NULL DEFAULT 0.7;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS verification_notes TEXT;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS last_verified_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS next_reverification_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS last_confirmed_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS confirmation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS source_turn_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS visibility_class TEXT NOT NULL DEFAULT 'private';
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS successful_use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS failed_use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS disputed_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS contradiction_score REAL NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS superseded_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS last_accessed_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER);
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;

-- v13: Phase 5 field extensions for knowledge_memory
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS valid_from INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS valid_until INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS rationale TEXT;
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'knowledge_memory'
      AND c.conname = 'knowledge_memory_confidence_check'
  ) THEN
    ALTER TABLE knowledge_memory DROP CONSTRAINT knowledge_memory_confidence_check;
  END IF;

  ALTER TABLE knowledge_memory
    ADD CONSTRAINT knowledge_memory_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low'));
END $$;

CREATE INDEX IF NOT EXISTS idx_km_scope ON knowledge_memory (tenant_id, system_id, workspace_id, collaboration_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_km_active ON knowledge_memory (superseded_by_id, retired_at);
CREATE INDEX IF NOT EXISTS idx_km_fact_type ON knowledge_memory (fact_type);
CREATE INDEX IF NOT EXISTS idx_km_slot_key ON knowledge_memory (slot_key);
CREATE INDEX IF NOT EXISTS idx_km_reverify
  ON knowledge_memory (knowledge_state, next_reverification_at, knowledge_class, trust_score DESC);

-- Full-text search on knowledge_memory
ALTER TABLE knowledge_memory ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_km_fts ON knowledge_memory USING GIN (search_vector);

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
  working_memory_id INTEGER,
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_subject TEXT,
  fact_attribute TEXT,
  fact_value TEXT,
  normalized_fact TEXT,
  slot_key TEXT,
  is_negated BOOLEAN NOT NULL DEFAULT FALSE,
  confidence TEXT NOT NULL DEFAULT 'medium',
  confidence_score REAL NOT NULL DEFAULT 0.5,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  source_text TEXT,
  decision TEXT NOT NULL,
  detail TEXT,
  related_knowledge_id INTEGER,
  created_knowledge_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

ALTER TABLE knowledge_memory_audit ADD COLUMN IF NOT EXISTS confidence_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE knowledge_memory_audit ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified';

CREATE INDEX IF NOT EXISTS idx_kma_scope ON knowledge_memory_audit (tenant_id, system_id, workspace_id, collaboration_id, scope_id);

CREATE TABLE IF NOT EXISTS knowledge_candidate (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  working_memory_id INTEGER NOT NULL REFERENCES working_memory(id) ON DELETE CASCADE,
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  knowledge_class TEXT NOT NULL,
  normalized_fact TEXT NOT NULL,
  slot_key TEXT,
  confidence TEXT NOT NULL,
  source_summary BOOLEAN NOT NULL DEFAULT FALSE,
  source_turns BOOLEAN NOT NULL DEFAULT TRUE,
  grounding_strength TEXT NOT NULL DEFAULT 'weak',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  trust_score REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'candidate',
  promoted_knowledge_id INTEGER REFERENCES knowledge_memory(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'knowledge_candidate'
      AND column_name = 'source_summary'
      AND data_type <> 'boolean'
  ) THEN
    ALTER TABLE knowledge_candidate
      ALTER COLUMN source_summary DROP DEFAULT,
      ALTER COLUMN source_summary TYPE BOOLEAN USING COALESCE(source_summary, 0) <> 0,
      ALTER COLUMN source_summary SET DEFAULT FALSE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'knowledge_candidate'
      AND column_name = 'source_turns'
      AND data_type <> 'boolean'
  ) THEN
    ALTER TABLE knowledge_candidate
      ALTER COLUMN source_turns DROP DEFAULT,
      ALTER COLUMN source_turns TYPE BOOLEAN USING COALESCE(source_turns, 0) <> 0,
      ALTER COLUMN source_turns SET DEFAULT TRUE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kc_scope_state_created
  ON knowledge_candidate (tenant_id, system_id, workspace_id, collaboration_id, scope_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  knowledge_memory_id INTEGER REFERENCES knowledge_memory(id) ON DELETE CASCADE,
  knowledge_candidate_id INTEGER REFERENCES knowledge_candidate(id) ON DELETE CASCADE,
  working_memory_id INTEGER REFERENCES working_memory(id) ON DELETE CASCADE,
  turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  support_polarity TEXT NOT NULL,
  speaker_role TEXT,
  actor TEXT,
  excerpt TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  is_explicit BOOLEAN NOT NULL DEFAULT FALSE,
  explicitness_score REAL NOT NULL DEFAULT 0,
  outcome TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_ke_knowledge_memory
  ON knowledge_evidence (knowledge_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ke_candidate
  ON knowledge_evidence (knowledge_candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'objective' CHECK (kind IN ('objective', 'unresolved_work', 'constraint')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'done')),
  detail TEXT,
  visibility_class TEXT NOT NULL DEFAULT 'private',
  source_working_memory_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

ALTER TABLE work_items ADD COLUMN IF NOT EXISTS source_working_memory_id INTEGER;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS visibility_class TEXT NOT NULL DEFAULT 'private';
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

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
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

ALTER TABLE compaction_log ADD COLUMN IF NOT EXISTS error TEXT;

CREATE INDEX IF NOT EXISTS idx_cl_scope ON compaction_log (tenant_id, system_id, workspace_id, collaboration_id, scope_id);

-- pgvector extension for semantic search (optional).
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

-- v11: playbooks + revisions
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
  visibility_class TEXT NOT NULL DEFAULT 'private',
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
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS visibility_class TEXT NOT NULL DEFAULT 'private';

-- v13: Phase 5 field extensions for playbooks
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS rationale TEXT;

-- Full-text search on playbooks
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_pb_fts ON playbooks USING GIN (search_vector);

CREATE OR REPLACE FUNCTION playbooks_search_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.description, '') || ' ' ||
    COALESCE(NEW.instructions, '')
  );
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

-- v12: associations
CREATE TABLE IF NOT EXISTS associations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  association_type TEXT NOT NULL,
  visibility_class TEXT NOT NULL DEFAULT 'private',
  confidence REAL NOT NULL DEFAULT 0.8,
  auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  provenance TEXT NOT NULL DEFAULT 'inferred',
  UNIQUE (source_kind, source_id, target_kind, target_id, association_type)
);

CREATE INDEX IF NOT EXISTS idx_assoc_source ON associations (source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_assoc_target ON associations (target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_assoc_scope ON associations (tenant_id, system_id, workspace_id, collaboration_id, scope_id);
ALTER TABLE associations ADD COLUMN IF NOT EXISTS visibility_class TEXT NOT NULL DEFAULT 'private';

-- v13: Phase 5 field extensions for associations
ALTER TABLE associations ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'inferred';
ALTER TABLE associations ALTER COLUMN confidence SET DEFAULT 0.8;
UPDATE associations SET confidence = 0.8 WHERE confidence = 0.5;

CREATE TABLE IF NOT EXISTS memory_event_log (
  event_id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT,
  actor_id TEXT,
  actor_kind TEXT,
  actor_system_id TEXT,
  actor_display_name TEXT,
  actor_metadata JSONB,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  causation_id TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

ALTER TABLE memory_event_log ADD COLUMN IF NOT EXISTS actor_kind TEXT;
ALTER TABLE memory_event_log ADD COLUMN IF NOT EXISTS actor_system_id TEXT;
ALTER TABLE memory_event_log ADD COLUMN IF NOT EXISTS actor_display_name TEXT;
ALTER TABLE memory_event_log ADD COLUMN IF NOT EXISTS actor_metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_event_log_scope_created
  ON memory_event_log (tenant_id, system_id, workspace_id, collaboration_id, scope_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_event_log_entity_created
  ON memory_event_log (entity_kind, entity_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_event_log_session_created
  ON memory_event_log (session_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_event_log_correlation
  ON memory_event_log (correlation_id);

CREATE TABLE IF NOT EXISTS session_state_current (
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  current_objective TEXT,
  blockers JSONB NOT NULL DEFAULT '[]',
  assumptions JSONB NOT NULL DEFAULT '[]',
  pending_decisions JSONB NOT NULL DEFAULT '[]',
  active_tools JSONB NOT NULL DEFAULT '[]',
  recent_outputs JSONB NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  source_event_id BIGINT,
  PRIMARY KEY (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id)
);

CREATE TABLE IF NOT EXISTS projection_watermarks (
  projection_name TEXT PRIMARY KEY,
  last_event_id BIGINT NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  cutover_at INTEGER,
  metadata JSONB
);

-- Current-state projection only; historical claim transitions remain in memory_event_log.
CREATE TABLE IF NOT EXISTS work_claims_current (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  work_item_id INTEGER NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
  session_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_system_id TEXT,
  actor_display_name TEXT,
  actor_metadata JSONB,
  claim_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT,
  source_event_id BIGINT,
  visibility_class TEXT NOT NULL DEFAULT 'private',
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_work_claims_actor_status
  ON work_claims_current (actor_kind, actor_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_work_claims_scope_visibility
  ON work_claims_current (tenant_id, system_id, workspace_id, collaboration_id, scope_id, visibility_class);

CREATE TABLE IF NOT EXISTS handoff_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  session_id TEXT,
  from_actor_kind TEXT NOT NULL,
  from_actor_id TEXT NOT NULL,
  from_actor_system_id TEXT,
  from_actor_display_name TEXT,
  from_actor_metadata JSONB,
  to_actor_kind TEXT NOT NULL,
  to_actor_id TEXT NOT NULL,
  to_actor_system_id TEXT,
  to_actor_display_name TEXT,
  to_actor_metadata JSONB,
  summary TEXT NOT NULL,
  context_bundle_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  accepted_at INTEGER,
  rejected_at INTEGER,
  canceled_at INTEGER,
  expires_at INTEGER,
  decision_reason TEXT,
  source_event_id BIGINT,
  visibility_class TEXT NOT NULL DEFAULT 'private',
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_handoffs_to_actor_status
  ON handoff_records (to_actor_kind, to_actor_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_from_actor_status
  ON handoff_records (from_actor_kind, from_actor_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_work_item_status
  ON handoff_records (work_item_id, status);

-- v15: source_documents table + knowledge_evidence.source_document_id + associations.visibility_class
CREATE TABLE IF NOT EXISTS source_documents (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '',
  system_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  fact_count INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_source_documents_scope
  ON source_documents (tenant_id, system_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_hash
  ON source_documents (content_hash, tenant_id, system_id, scope_id);

-- v16: durable scope-scoped config for aliases and ontology
CREATE TABLE IF NOT EXISTS scope_config (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  collaboration_id TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_config_key
  ON scope_config (tenant_id, system_id, workspace_id, collaboration_id, scope_id, config_key);

ALTER TABLE knowledge_evidence ADD COLUMN IF NOT EXISTS source_document_id INTEGER REFERENCES source_documents(id) ON DELETE SET NULL;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS visibility_class TEXT NOT NULL DEFAULT 'private';

-- Record all applied schema versions so upgrades are visible and auditable.
-- ON CONFLICT DO NOTHING keeps this idempotent across repeated applies.
INSERT INTO schema_version (version) VALUES
  (1), (9), (10), (11), (12), (13), (14), (15), (16)
ON CONFLICT DO NOTHING;
