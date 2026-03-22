import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 4;

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
    CREATE INDEX IF NOT EXISTS idx_turns_scope ON turns(tenant_id, system_id, workspace_id, scope_id);
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
    CREATE INDEX IF NOT EXISTS idx_wm_scope ON working_memory(tenant_id, system_id, workspace_id, scope_id);

    CREATE TABLE IF NOT EXISTS knowledge_memory (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id                TEXT    NOT NULL,
      system_id                TEXT    NOT NULL,
      workspace_id             TEXT    NOT NULL DEFAULT 'default',
      scope_id                 TEXT    NOT NULL,
      fact                     TEXT    NOT NULL,
      fact_type                TEXT    NOT NULL,
      fact_subject             TEXT,
      fact_attribute           TEXT,
      fact_value               TEXT,
      normalized_fact          TEXT,
      slot_key                 TEXT,
      is_negated               INTEGER NOT NULL DEFAULT 0,
      source                   TEXT    NOT NULL,
      confidence               TEXT    NOT NULL DEFAULT 'high',
      confidence_score         REAL    NOT NULL DEFAULT 0.5,
      verification_status      TEXT    NOT NULL DEFAULT 'unverified',
      verification_notes       TEXT,
      source_working_memory_id INTEGER REFERENCES working_memory(id),
      source_turn_ids          TEXT    NOT NULL DEFAULT '[]',
      superseded_by_id         INTEGER REFERENCES knowledge_memory(id),
      retired_at               INTEGER,
      created_at               INTEGER NOT NULL,
      last_accessed_at         INTEGER NOT NULL,
      access_count             INTEGER NOT NULL DEFAULT 1,
      schema_version           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_km_scope ON knowledge_memory(tenant_id, system_id, workspace_id, scope_id);
    CREATE INDEX IF NOT EXISTS idx_km_superseded ON knowledge_memory(superseded_by_id);
    CREATE INDEX IF NOT EXISTS idx_km_slot ON knowledge_memory(tenant_id, system_id, workspace_id, scope_id, slot_key);
    CREATE INDEX IF NOT EXISTS idx_km_access ON knowledge_memory(access_count);
    CREATE INDEX IF NOT EXISTS idx_km_last_accessed ON knowledge_memory(last_accessed_at);

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

    CREATE INDEX IF NOT EXISTS idx_kma_scope ON knowledge_memory_audit(tenant_id, system_id, workspace_id, scope_id, id DESC);

    CREATE TABLE IF NOT EXISTS context_monitor (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id             TEXT    NOT NULL,
      system_id             TEXT    NOT NULL,
      workspace_id          TEXT    NOT NULL DEFAULT 'default',
      scope_id              TEXT    NOT NULL,
      compaction_state      TEXT    NOT NULL DEFAULT 'idle',
      last_compaction_at    INTEGER,
      active_turn_count     INTEGER NOT NULL DEFAULT 0,
      active_token_estimate INTEGER NOT NULL DEFAULT 0,
      compaction_score      INTEGER NOT NULL DEFAULT 0,
      updated_at            INTEGER NOT NULL,
      UNIQUE(tenant_id, system_id, workspace_id, scope_id)
    );

    CREATE TABLE IF NOT EXISTS compaction_log (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id                TEXT    NOT NULL,
      tenant_id                 TEXT    NOT NULL,
      system_id                 TEXT    NOT NULL,
      workspace_id              TEXT    NOT NULL DEFAULT 'default',
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

    CREATE INDEX IF NOT EXISTS idx_cl_scope ON compaction_log(tenant_id, system_id, workspace_id, scope_id);

    CREATE TABLE IF NOT EXISTS work_items (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id             TEXT,
      tenant_id              TEXT    NOT NULL,
      system_id              TEXT    NOT NULL,
      workspace_id           TEXT    NOT NULL DEFAULT 'default',
      scope_id               TEXT    NOT NULL,
      kind                   TEXT    NOT NULL,
      title                  TEXT    NOT NULL,
      detail                 TEXT,
      status                 TEXT    NOT NULL DEFAULT 'open',
      source_working_memory_id INTEGER REFERENCES working_memory(id),
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_scope ON work_items(tenant_id, system_id, workspace_id, scope_id, status);

    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const knowledgeMemoryAlterStatements = [
    'ALTER TABLE knowledge_memory ADD COLUMN fact_subject TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN fact_attribute TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN fact_value TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN normalized_fact TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN slot_key TEXT',
    'ALTER TABLE knowledge_memory ADD COLUMN is_negated INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE knowledge_memory ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0.5',
    "ALTER TABLE knowledge_memory ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'",
    'ALTER TABLE knowledge_memory ADD COLUMN verification_notes TEXT',
    "ALTER TABLE knowledge_memory ADD COLUMN source_turn_ids TEXT NOT NULL DEFAULT '[]'",
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
    database.exec('ALTER TABLE turns ADD COLUMN priority REAL NOT NULL DEFAULT 1.0');
  } catch {
    // Column already exists on upgraded databases.
  }

  database
    .prepare(
      `INSERT INTO schema_meta (id, schema_version, updated_at)
       VALUES (1, ?, strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at`,
    )
    .run(CURRENT_SCHEMA_VERSION);
}
