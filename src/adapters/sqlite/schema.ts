import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 16;

export function createSQLiteSchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT    NOT NULL,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      actor             TEXT    NOT NULL,
      role              TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content           TEXT    NOT NULL,
      priority          REAL    NOT NULL DEFAULT 1.0,
      token_estimate    INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      archived_at       INTEGER,
      compaction_log_id INTEGER REFERENCES compaction_log(id),
      schema_version    INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_scope ON turns(tenant_id, system_id, workspace_id, collaboration_id, scope_id);
    CREATE INDEX IF NOT EXISTS idx_turns_archived ON turns(archived_at);
    CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      content, content=turns, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    CREATE TABLE IF NOT EXISTS working_memory (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id               TEXT    NOT NULL,
      tenant_id                TEXT    NOT NULL,
      system_id                TEXT    NOT NULL,
      workspace_id             TEXT    NOT NULL DEFAULT 'default',
      collaboration_id         TEXT    NOT NULL DEFAULT '',
      scope_id                 TEXT    NOT NULL,
      summary                  TEXT    NOT NULL,
      key_entities             TEXT    NOT NULL DEFAULT '[]',
      topic_tags               TEXT    NOT NULL DEFAULT '[]',
      turn_id_start            INTEGER NOT NULL,
      turn_id_end              INTEGER NOT NULL,
      turn_count               INTEGER NOT NULL,
      compaction_trigger       TEXT    NOT NULL,
      created_at               INTEGER NOT NULL,
      expires_at               INTEGER,
      promoted_to_knowledge_id INTEGER REFERENCES knowledge_memory(id),
      schema_version           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id);
    CREATE INDEX IF NOT EXISTS idx_wm_scope ON working_memory(tenant_id, system_id, workspace_id, collaboration_id, scope_id);

    CREATE TABLE IF NOT EXISTS knowledge_memory (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id                TEXT    NOT NULL,
      system_id                TEXT    NOT NULL,
      workspace_id             TEXT    NOT NULL DEFAULT 'default',
      collaboration_id         TEXT    NOT NULL DEFAULT '',
      scope_id                 TEXT    NOT NULL,
      fact                     TEXT    NOT NULL,
      fact_type                TEXT    NOT NULL,
      knowledge_state          TEXT    NOT NULL DEFAULT 'trusted',
      knowledge_class          TEXT    NOT NULL DEFAULT 'project_fact',
      fact_subject             TEXT,
      fact_attribute           TEXT,
      fact_value               TEXT,
      normalized_fact          TEXT,
      slot_key                 TEXT,
      is_negated               INTEGER NOT NULL DEFAULT 0,
      source                   TEXT    NOT NULL,
      confidence               TEXT    NOT NULL DEFAULT 'high',
      confidence_score         REAL    NOT NULL DEFAULT 0.5,
      grounding_strength       TEXT    NOT NULL DEFAULT 'moderate',
      evidence_count           INTEGER NOT NULL DEFAULT 0,
      trust_score              REAL    NOT NULL DEFAULT 0.7,
      verification_status      TEXT    NOT NULL DEFAULT 'unverified',
      verification_notes       TEXT,
      last_verified_at         INTEGER,
      next_reverification_at   INTEGER,
      last_confirmed_at        INTEGER,
      confirmation_count       INTEGER NOT NULL DEFAULT 0,
      source_system_id         TEXT,
      source_scope_id          TEXT,
      source_collaboration_id  TEXT,
      source_working_memory_id INTEGER REFERENCES working_memory(id),
      source_turn_ids          TEXT    NOT NULL DEFAULT '[]',
      successful_use_count     INTEGER NOT NULL DEFAULT 0,
      failed_use_count         INTEGER NOT NULL DEFAULT 0,
      disputed_at             INTEGER,
      dispute_reason          TEXT,
      contradiction_score     REAL    NOT NULL DEFAULT 0,
      superseded_at           INTEGER,
      superseded_by_id         INTEGER REFERENCES knowledge_memory(id),
      retired_at               INTEGER,
      created_at               INTEGER NOT NULL,
      last_accessed_at         INTEGER NOT NULL,
      access_count             INTEGER NOT NULL DEFAULT 1,
      schema_version           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_km_scope ON knowledge_memory(tenant_id, system_id, workspace_id, collaboration_id, scope_id);
    CREATE INDEX IF NOT EXISTS idx_km_superseded ON knowledge_memory(superseded_by_id);
    CREATE INDEX IF NOT EXISTS idx_km_slot ON knowledge_memory(tenant_id, system_id, workspace_id, collaboration_id, scope_id, slot_key);
    CREATE INDEX IF NOT EXISTS idx_km_access ON knowledge_memory(access_count);
    CREATE INDEX IF NOT EXISTS idx_km_last_accessed ON knowledge_memory(last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_km_state_trust_class ON knowledge_memory(tenant_id, collaboration_id, knowledge_state, trust_score DESC, knowledge_class);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_memory_fts USING fts5(
      fact, content=knowledge_memory, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS km_ai AFTER INSERT ON knowledge_memory BEGIN
      INSERT INTO knowledge_memory_fts(rowid, fact) VALUES (new.id, new.fact);
    END;

    CREATE TRIGGER IF NOT EXISTS km_au AFTER UPDATE ON knowledge_memory BEGIN
      INSERT INTO knowledge_memory_fts(knowledge_memory_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      INSERT INTO knowledge_memory_fts(rowid, fact) VALUES (new.id, new.fact);
    END;

    CREATE TRIGGER IF NOT EXISTS km_ad AFTER DELETE ON knowledge_memory BEGIN
      INSERT INTO knowledge_memory_fts(knowledge_memory_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
    END;

    CREATE TABLE IF NOT EXISTS knowledge_memory_audit (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id            TEXT    NOT NULL,
      system_id            TEXT    NOT NULL,
      workspace_id         TEXT    NOT NULL DEFAULT 'default',
      collaboration_id     TEXT    NOT NULL DEFAULT '',
      scope_id             TEXT    NOT NULL,
      working_memory_id    INTEGER REFERENCES working_memory(id),
      fact                 TEXT    NOT NULL,
      fact_type            TEXT    NOT NULL,
      fact_subject         TEXT,
      fact_attribute       TEXT,
      fact_value           TEXT,
      normalized_fact      TEXT,
      slot_key             TEXT,
      is_negated           INTEGER NOT NULL DEFAULT 0,
      confidence           TEXT    NOT NULL DEFAULT 'medium',
      confidence_score     REAL    NOT NULL DEFAULT 0.5,
      verification_status  TEXT    NOT NULL DEFAULT 'unverified',
      source_text          TEXT,
      decision             TEXT    NOT NULL,
      created_knowledge_id INTEGER REFERENCES knowledge_memory(id),
      related_knowledge_id INTEGER REFERENCES knowledge_memory(id),
      detail               TEXT,
      created_at           INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kma_scope ON knowledge_memory_audit(tenant_id, system_id, workspace_id, collaboration_id, scope_id, id DESC);

    CREATE TABLE IF NOT EXISTS knowledge_candidate (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id            TEXT    NOT NULL,
      system_id            TEXT    NOT NULL,
      workspace_id         TEXT    NOT NULL DEFAULT 'default',
      collaboration_id     TEXT    NOT NULL DEFAULT '',
      scope_id             TEXT    NOT NULL,
      working_memory_id    INTEGER NOT NULL REFERENCES working_memory(id) ON DELETE CASCADE,
      fact                 TEXT    NOT NULL,
      fact_type            TEXT    NOT NULL,
      knowledge_class      TEXT    NOT NULL,
      normalized_fact      TEXT    NOT NULL,
      slot_key             TEXT,
      confidence           TEXT    NOT NULL,
      source_summary       INTEGER NOT NULL DEFAULT 0,
      source_turns         INTEGER NOT NULL DEFAULT 1,
      grounding_strength   TEXT    NOT NULL DEFAULT 'weak',
      evidence_count       INTEGER NOT NULL DEFAULT 0,
      trust_score          REAL    NOT NULL DEFAULT 0,
      state                TEXT    NOT NULL DEFAULT 'candidate',
      promoted_knowledge_id INTEGER REFERENCES knowledge_memory(id) ON DELETE SET NULL,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_kc_scope_state_created
      ON knowledge_candidate(tenant_id, system_id, workspace_id, collaboration_id, scope_id, state, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_evidence (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id            TEXT    NOT NULL,
      system_id            TEXT    NOT NULL,
      workspace_id         TEXT    NOT NULL DEFAULT 'default',
      collaboration_id     TEXT    NOT NULL DEFAULT '',
      scope_id             TEXT    NOT NULL,
      knowledge_memory_id  INTEGER REFERENCES knowledge_memory(id) ON DELETE CASCADE,
      knowledge_candidate_id INTEGER REFERENCES knowledge_candidate(id) ON DELETE CASCADE,
      working_memory_id    INTEGER REFERENCES working_memory(id) ON DELETE CASCADE,
      turn_id              INTEGER REFERENCES turns(id) ON DELETE CASCADE,
      source_type          TEXT    NOT NULL,
      support_polarity     TEXT    NOT NULL,
      speaker_role         TEXT,
      actor                TEXT,
      excerpt              TEXT    NOT NULL,
      start_offset         INTEGER,
      end_offset           INTEGER,
      is_explicit          INTEGER NOT NULL DEFAULT 0,
      explicitness_score   REAL    NOT NULL DEFAULT 0,
      outcome              TEXT,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_ke_knowledge_memory
      ON knowledge_evidence(knowledge_memory_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_ke_candidate
      ON knowledge_evidence(knowledge_candidate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS context_monitor (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id             TEXT    NOT NULL,
      system_id             TEXT    NOT NULL,
      workspace_id          TEXT    NOT NULL DEFAULT 'default',
      collaboration_id      TEXT    NOT NULL DEFAULT '',
      scope_id              TEXT    NOT NULL,
      compaction_state      TEXT    NOT NULL DEFAULT 'idle',
      last_compaction_at    INTEGER,
      active_turn_count     INTEGER NOT NULL DEFAULT 0,
      active_token_estimate INTEGER NOT NULL DEFAULT 0,
      compaction_score      INTEGER NOT NULL DEFAULT 0,
      updated_at            INTEGER NOT NULL,
      UNIQUE(tenant_id, system_id, workspace_id, collaboration_id, scope_id)
    );

    CREATE TABLE IF NOT EXISTS compaction_log (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id                TEXT    NOT NULL,
      tenant_id                 TEXT    NOT NULL,
      system_id                 TEXT    NOT NULL,
      workspace_id              TEXT    NOT NULL DEFAULT 'default',
      collaboration_id          TEXT    NOT NULL DEFAULT '',
      scope_id                  TEXT    NOT NULL,
      trigger_type              TEXT    NOT NULL,
      turn_id_start             INTEGER NOT NULL,
      turn_id_end               INTEGER NOT NULL,
      turns_compacted           INTEGER NOT NULL,
      tokens_compacted_estimate INTEGER NOT NULL,
      working_memory_id         INTEGER NOT NULL REFERENCES working_memory(id),
      active_turn_count_before  INTEGER NOT NULL,
      active_turn_count_after   INTEGER NOT NULL,
      duration_ms               INTEGER NOT NULL,
      model_call_made           INTEGER NOT NULL DEFAULT 0,
      error                     TEXT,
      created_at                INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_context_monitor_scope_unique
      ON context_monitor(tenant_id, system_id, workspace_id, collaboration_id, scope_id);

    CREATE INDEX IF NOT EXISTS idx_cl_scope ON compaction_log(tenant_id, system_id, workspace_id, collaboration_id, scope_id);

    CREATE TABLE IF NOT EXISTS work_items (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id             TEXT,
      tenant_id              TEXT    NOT NULL,
      system_id              TEXT    NOT NULL,
      workspace_id           TEXT    NOT NULL DEFAULT 'default',
      collaboration_id       TEXT    NOT NULL DEFAULT '',
      scope_id               TEXT    NOT NULL,
      kind                   TEXT    NOT NULL,
      title                  TEXT    NOT NULL,
      detail                 TEXT,
      status                 TEXT    NOT NULL DEFAULT 'open',
      visibility_class       TEXT    NOT NULL DEFAULT 'private',
      source_working_memory_id INTEGER REFERENCES working_memory(id),
      version                INTEGER NOT NULL DEFAULT 1,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_scope ON work_items(tenant_id, system_id, workspace_id, collaboration_id, scope_id, status);

    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const knowledgeMemoryAlterStatements = [
    "ALTER TABLE knowledge_memory ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE knowledge_memory ADD COLUMN knowledge_state TEXT NOT NULL DEFAULT 'trusted'",
    "ALTER TABLE knowledge_memory ADD COLUMN knowledge_class TEXT NOT NULL DEFAULT 'project_fact'",
    'ALTER TABLE knowledge_memory ADD COLUMN fact_subject TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN fact_attribute TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN fact_value TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN normalized_fact TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN slot_key TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN is_negated INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0.5',
    "ALTER TABLE knowledge_memory ADD COLUMN grounding_strength TEXT NOT NULL DEFAULT 'moderate'",
    'ALTER TABLE knowledge_memory ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN trust_score REAL NOT NULL DEFAULT 0.7',
    "ALTER TABLE knowledge_memory ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'",
    'ALTER TABLE knowledge_memory ADD COLUMN verification_notes TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN last_verified_at INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN next_reverification_at INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN last_confirmed_at INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN source_system_id TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN source_scope_id TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN source_collaboration_id TEXT',
    "ALTER TABLE knowledge_memory ADD COLUMN source_turn_ids TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE knowledge_memory ADD COLUMN successful_use_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN failed_use_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN disputed_at INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN dispute_reason TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN contradiction_score REAL NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN superseded_at INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN retired_at INTEGER',
  ];

  for (const statement of knowledgeMemoryAlterStatements) {
    try {
      database.exec(statement);
    } catch {
      // Column already exists on upgraded databases.
    }
  }

  try {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_km_reverify ON knowledge_memory(knowledge_state, next_reverification_at, knowledge_class, trust_score DESC)',
    );
  } catch {
    // Index already exists on upgraded databases.
  }

  try {
    database.exec('ALTER TABLE turns ADD COLUMN priority REAL NOT NULL DEFAULT 1.0');
  } catch {
    // Column already exists on upgraded databases.
  }

  const collaborationAlterStatements = [
    "ALTER TABLE turns ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE working_memory ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE knowledge_memory_audit ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE knowledge_candidate ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE knowledge_evidence ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE context_monitor ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE compaction_log ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE work_items ADD COLUMN collaboration_id TEXT NOT NULL DEFAULT ''",
  ];

  for (const statement of collaborationAlterStatements) {
    try {
      database.exec(statement);
    } catch {
      // Column already exists on upgraded databases.
    }
  }

  const coordinationAlterStatements = [
    "ALTER TABLE knowledge_memory ADD COLUMN visibility_class TEXT NOT NULL DEFAULT 'private'",
    "ALTER TABLE work_items ADD COLUMN visibility_class TEXT NOT NULL DEFAULT 'private'",
    'ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE playbooks ADD COLUMN visibility_class TEXT NOT NULL DEFAULT 'private'",
    "ALTER TABLE associations ADD COLUMN visibility_class TEXT NOT NULL DEFAULT 'private'",
    'ALTER TABLE memory_event_log ADD COLUMN actor_kind TEXT',
    'ALTER TABLE memory_event_log ADD COLUMN actor_system_id TEXT',
    'ALTER TABLE memory_event_log ADD COLUMN actor_display_name TEXT',
    'ALTER TABLE memory_event_log ADD COLUMN actor_metadata TEXT',
  ];

  for (const statement of coordinationAlterStatements) {
    try {
      database.exec(statement);
    } catch {
      // Column already exists on upgraded databases.
    }
  }

  const collaborationBackfills = [
    'UPDATE turns SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE working_memory SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE knowledge_memory SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE knowledge_memory_audit SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE knowledge_candidate SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE knowledge_evidence SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE context_monitor SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE compaction_log SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE work_items SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE playbooks SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE playbook_revisions SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE associations SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE memory_event_log SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE session_state_current SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE work_claims_current SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
    'UPDATE handoff_records SET collaboration_id = "" WHERE collaboration_id IS NULL OR collaboration_id = "default"',
  ];

  for (const statement of collaborationBackfills) {
    try {
      database.exec(statement);
    } catch {
      // Best-effort backfill for upgraded databases.
    }
  }

  try {
    database.exec('ALTER TABLE working_memory ADD COLUMN episode_recap TEXT');
  } catch {
    // Column already exists on upgraded databases.
  }

  // v15: Phase 5 field extensions
  const phase5AlterStatements = [
    'ALTER TABLE knowledge_memory ADD COLUMN valid_from INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN valid_until INTEGER',
    'ALTER TABLE knowledge_memory ADD COLUMN rationale TEXT',
    "ALTER TABLE knowledge_memory ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE playbooks ADD COLUMN rationale TEXT',
    "ALTER TABLE associations ADD COLUMN provenance TEXT NOT NULL DEFAULT 'inferred'",
  ];

  for (const statement of phase5AlterStatements) {
    try {
      database.exec(statement);
    } catch {
      // Column already exists on upgraded databases.
    }
  }

  // v15: Backfill existing associations confidence from 0.5 → 0.8
  try {
    database.exec("UPDATE associations SET confidence = 0.8 WHERE confidence = 0.5");
  } catch {
    // Best-effort backfill.
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id                TEXT    NOT NULL,
      system_id                TEXT    NOT NULL,
      workspace_id             TEXT    NOT NULL DEFAULT 'default',
      collaboration_id         TEXT    NOT NULL DEFAULT '',
      scope_id                 TEXT    NOT NULL,
      title                    TEXT    NOT NULL,
      description              TEXT    NOT NULL,
      instructions             TEXT    NOT NULL,
      references_json          TEXT    NOT NULL DEFAULT '[]',
      templates                TEXT    NOT NULL DEFAULT '[]',
      scripts                  TEXT    NOT NULL DEFAULT '[]',
      assets                   TEXT    NOT NULL DEFAULT '[]',
      tags                     TEXT    NOT NULL DEFAULT '[]',
      rationale                TEXT,
      status                   TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
      source_session_id        TEXT,
      source_working_memory_id INTEGER REFERENCES working_memory(id),
      revision_count           INTEGER NOT NULL DEFAULT 0,
      last_used_at             INTEGER,
      use_count                INTEGER NOT NULL DEFAULT 0,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      schema_version           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_pb_scope ON playbooks(tenant_id, system_id, workspace_id, collaboration_id, scope_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS playbooks_fts USING fts5(
      title, description, instructions, content=playbooks, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS pb_ai AFTER INSERT ON playbooks BEGIN
      INSERT INTO playbooks_fts(rowid, title, description, instructions) VALUES (new.id, new.title, new.description, new.instructions);
    END;

    CREATE TRIGGER IF NOT EXISTS pb_au AFTER UPDATE ON playbooks BEGIN
      INSERT INTO playbooks_fts(playbooks_fts, rowid, title, description, instructions) VALUES ('delete', old.id, old.title, old.description, old.instructions);
      INSERT INTO playbooks_fts(rowid, title, description, instructions) VALUES (new.id, new.title, new.description, new.instructions);
    END;

    CREATE TRIGGER IF NOT EXISTS pb_ad AFTER DELETE ON playbooks BEGIN
      INSERT INTO playbooks_fts(playbooks_fts, rowid, title, description, instructions) VALUES ('delete', old.id, old.title, old.description, old.instructions);
    END;

    CREATE TABLE IF NOT EXISTS playbook_revisions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      playbook_id       INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
      instructions      TEXT    NOT NULL,
      revision_reason   TEXT    NOT NULL,
      source_session_id TEXT,
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pbr_playbook ON playbook_revisions(playbook_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS associations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      source_kind       TEXT    NOT NULL,
      source_id         INTEGER NOT NULL,
      target_kind       TEXT    NOT NULL,
      target_id         INTEGER NOT NULL,
      association_type   TEXT    NOT NULL,
      provenance        TEXT    NOT NULL DEFAULT 'inferred',
      confidence        REAL    NOT NULL DEFAULT 0.8,
      auto_generated    INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      UNIQUE(source_kind, source_id, target_kind, target_id, association_type)
    );

    CREATE INDEX IF NOT EXISTS idx_assoc_source ON associations(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_assoc_target ON associations(target_kind, target_id);
    CREATE INDEX IF NOT EXISTS idx_assoc_scope ON associations(tenant_id, system_id, workspace_id, collaboration_id, scope_id);

    CREATE TABLE IF NOT EXISTS memory_event_log (
      event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      session_id         TEXT,
      actor_id           TEXT,
      actor_kind         TEXT,
      actor_system_id    TEXT,
      actor_display_name TEXT,
      actor_metadata     TEXT,
      entity_kind        TEXT    NOT NULL,
      entity_id          TEXT    NOT NULL,
      event_type         TEXT    NOT NULL,
      payload            TEXT    NOT NULL DEFAULT '{}',
      causation_id       TEXT,
      correlation_id     TEXT,
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_event_scope_created
      ON memory_event_log(tenant_id, system_id, workspace_id, collaboration_id, scope_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_event_entity_created
      ON memory_event_log(entity_kind, entity_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_event_session_created
      ON memory_event_log(session_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_event_correlation
      ON memory_event_log(correlation_id);

    CREATE TABLE IF NOT EXISTS session_state_current (
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      session_id         TEXT    NOT NULL,
      current_objective  TEXT,
      blockers           TEXT    NOT NULL DEFAULT '[]',
      assumptions        TEXT    NOT NULL DEFAULT '[]',
      pending_decisions  TEXT    NOT NULL DEFAULT '[]',
      active_tools       TEXT    NOT NULL DEFAULT '[]',
      recent_outputs     TEXT    NOT NULL DEFAULT '[]',
      updated_at         INTEGER NOT NULL,
      source_event_id    INTEGER,
      PRIMARY KEY (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS projection_watermarks (
      projection_name    TEXT PRIMARY KEY,
      last_event_id      INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL,
      cutover_at         INTEGER,
      metadata           TEXT
    );

    -- Current-state projection only; historical claim transitions remain in memory_event_log.
    CREATE TABLE IF NOT EXISTS work_claims_current (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      work_item_id       INTEGER NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
      session_id         TEXT,
      actor_kind         TEXT    NOT NULL,
      actor_id           TEXT    NOT NULL,
      actor_system_id    TEXT,
      actor_display_name TEXT,
      actor_metadata     TEXT,
      claim_token        TEXT    NOT NULL,
      status             TEXT    NOT NULL DEFAULT 'active',
      claimed_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      released_at        INTEGER,
      release_reason     TEXT,
      source_event_id    INTEGER,
      visibility_class   TEXT    NOT NULL DEFAULT 'private',
      version            INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_work_claims_actor_status
      ON work_claims_current(actor_kind, actor_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_work_claims_scope_visibility
      ON work_claims_current(tenant_id, system_id, workspace_id, collaboration_id, scope_id, visibility_class);

    CREATE TABLE IF NOT EXISTS handoff_records (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      work_item_id       INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      session_id         TEXT,
      from_actor_kind    TEXT    NOT NULL,
      from_actor_id      TEXT    NOT NULL,
      from_actor_system_id TEXT,
      from_actor_display_name TEXT,
      from_actor_metadata TEXT,
      to_actor_kind      TEXT    NOT NULL,
      to_actor_id        TEXT    NOT NULL,
      to_actor_system_id TEXT,
      to_actor_display_name TEXT,
      to_actor_metadata  TEXT,
      summary            TEXT    NOT NULL,
      context_bundle_ref TEXT,
      status             TEXT    NOT NULL DEFAULT 'pending',
      created_at         INTEGER NOT NULL,
      accepted_at        INTEGER,
      rejected_at        INTEGER,
      canceled_at        INTEGER,
      expires_at         INTEGER,
      decision_reason    TEXT,
      source_event_id    INTEGER,
      visibility_class   TEXT    NOT NULL DEFAULT 'private',
      version            INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_handoffs_to_actor_status
      ON handoff_records(to_actor_kind, to_actor_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_handoffs_from_actor_status
      ON handoff_records(from_actor_kind, from_actor_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_handoffs_work_item_status
      ON handoff_records(work_item_id, status);

    CREATE TABLE IF NOT EXISTS source_documents (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id          TEXT    NOT NULL DEFAULT '',
      system_id          TEXT    NOT NULL DEFAULT '',
      workspace_id       TEXT    NOT NULL DEFAULT '',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL DEFAULT '',
      title              TEXT    NOT NULL,
      content_hash       TEXT    NOT NULL,
      mime_type          TEXT    NOT NULL DEFAULT 'text/plain',
      url                TEXT,
      metadata           TEXT    NOT NULL DEFAULT '{}',
      status             TEXT    NOT NULL DEFAULT 'pending',
      fact_count         INTEGER NOT NULL DEFAULT 0,
      token_estimate     INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      processed_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_source_documents_scope
      ON source_documents(tenant_id, system_id, scope_id);
    CREATE INDEX IF NOT EXISTS idx_source_documents_hash
      ON source_documents(content_hash, tenant_id, system_id, scope_id);
  `);

  database
    .prepare(
      `INSERT INTO schema_meta (id, schema_version, updated_at)
       VALUES (1, ?, strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at`,
    )
    .run(CURRENT_SCHEMA_VERSION);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_event_log (
      event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      session_id         TEXT,
      actor_id           TEXT,
      actor_kind         TEXT,
      actor_system_id    TEXT,
      actor_display_name TEXT,
      actor_metadata     TEXT,
      entity_kind        TEXT    NOT NULL,
      entity_id          TEXT    NOT NULL,
      event_type         TEXT    NOT NULL,
      payload            TEXT    NOT NULL DEFAULT '{}',
      causation_id       TEXT,
      correlation_id     TEXT,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_event_scope_created
      ON memory_event_log(tenant_id, system_id, workspace_id, collaboration_id, scope_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_event_entity_created
      ON memory_event_log(entity_kind, entity_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_event_session_created
      ON memory_event_log(session_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS idx_memory_event_correlation
      ON memory_event_log(correlation_id);

    CREATE TABLE IF NOT EXISTS session_state_current (
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      session_id         TEXT    NOT NULL,
      current_objective  TEXT,
      blockers           TEXT    NOT NULL DEFAULT '[]',
      assumptions        TEXT    NOT NULL DEFAULT '[]',
      pending_decisions  TEXT    NOT NULL DEFAULT '[]',
      active_tools       TEXT    NOT NULL DEFAULT '[]',
      recent_outputs     TEXT    NOT NULL DEFAULT '[]',
      updated_at         INTEGER NOT NULL,
      source_event_id    INTEGER,
      PRIMARY KEY (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS projection_watermarks (
      projection_name    TEXT PRIMARY KEY,
      last_event_id      INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL,
      cutover_at         INTEGER,
      metadata           TEXT
    );
  `);
}
