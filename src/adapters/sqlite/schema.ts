import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 21;

/**
 * Returns true when a failed `ALTER TABLE ... ADD COLUMN` probe is benign for
 * our migration strategy: either the column already exists (upgraded database)
 * or the target table does not exist yet on a fresh install (the probe targets
 * a table created later in this function and only matters for upgrade paths).
 * Any other failure — disk full, database locked, corruption — is a real error
 * and must be rethrown rather than silently swallowed.
 */
function isBenignAlterProbeError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '').toLowerCase();
  return message.includes('duplicate column') || message.includes('no such table');
}

/**
 * Returns true when a failed `CREATE INDEX` probe is benign (the index already
 * exists). Other failures are real and rethrown.
 */
function isBenignIndexProbeError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '').toLowerCase();
  return message.includes('already exists');
}

export function createSQLiteSchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  // schema_meta must exist before we can read the on-disk schema version.
  // Created outside the migration transaction so the version read below is
  // always possible, even on a brand-new database.
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Note: schema_meta will have no rows on a fresh database — yielding
  // undefined, which falls back to version 0.
  const existingVersion = (
    database.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get() as
      | { schema_version: number }
      | undefined
  )?.schema_version ?? 0;

  // Downgrade guard: refuse to open a database created by a newer version of
  // the library rather than silently re-stamping it down to our version.
  if (existingVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `SQLite database was created by a newer version of ai-memory-layer ` +
        `(schema version ${existingVersion}); this build supports up to ${CURRENT_SCHEMA_VERSION}. ` +
        `Upgrade the library to open this database.`,
    );
  }

  // All schema construction and version-gated migrations run inside a single
  // transaction so that the destructive v17→v18 rebuild is atomic: a mid-flight
  // failure rolls back, leaving either the old state or the new state — never
  // stranded `_v17` data. The schema_version stamp is applied LAST, inside the
  // same transaction, so a crash before completion leaves the version unchanged
  // and the migration re-runs on next open.
  const runMigration = database.transaction(() => {
    // ── Recovery: complete an interrupted v17→v18 copy ──────────────────────
    // If a prior run crashed after RENAME-to-_v17 but before the copy+drop
    // completed, `context_contracts_v17` still exists. Finish the copy so we
    // never leave stranded data. This runs first, before the version gate,
    // because the schema_version was not yet stamped when the interruption
    // happened (so `existingVersion` may still read as pre-18).
    rebuildContractsFromV17IfPresent(database);

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
      } catch (error) {
        // Column already exists on upgraded databases; rethrow real failures.
        if (!isBenignAlterProbeError(error)) throw error;
      }
    }

    try {
      database.exec(
        'CREATE INDEX IF NOT EXISTS idx_km_reverify ON knowledge_memory(knowledge_state, next_reverification_at, knowledge_class, trust_score DESC)',
      );
    } catch (error) {
      if (!isBenignIndexProbeError(error)) throw error;
    }

    try {
      database.exec('ALTER TABLE turns ADD COLUMN priority REAL NOT NULL DEFAULT 1.0');
    } catch (error) {
      // Column already exists on upgraded databases; rethrow real failures.
      if (!isBenignAlterProbeError(error)) throw error;
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
      } catch (error) {
        // Column already exists on upgraded databases; rethrow real failures.
        if (!isBenignAlterProbeError(error)) throw error;
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
      } catch (error) {
        // Column already exists (upgraded db) or target table not yet created
        // (fresh db — these tables are built later and the probe only matters
        // for upgrade paths). Rethrow real failures.
        if (!isBenignAlterProbeError(error)) throw error;
      }
    }

    // Only run the collaboration_id backfill on databases created before v16,
    // which may contain rows with the legacy sentinel 'default' instead of ''.
    const COLLABORATION_BACKFILL_VERSION = 16;

    if (existingVersion < COLLABORATION_BACKFILL_VERSION) {
      const collaborationBackfills = [
        "UPDATE turns SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE working_memory SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE knowledge_memory SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE knowledge_memory SET source_collaboration_id = '' WHERE source_collaboration_id = 'default'",
        "UPDATE knowledge_memory_audit SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE knowledge_candidate SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE knowledge_evidence SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE context_monitor SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE compaction_log SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE work_items SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE playbooks SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE playbook_revisions SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE associations SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE memory_event_log SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE session_state_current SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE work_claims_current SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
        "UPDATE handoff_records SET collaboration_id = '' WHERE collaboration_id IS NULL OR collaboration_id = 'default'",
      ];

      for (const statement of collaborationBackfills) {
        try {
          database.exec(statement);
        } catch (error) {
          // Best-effort backfill: the target table may not exist yet on a
          // fresh database. Rethrow anything other than a missing table.
          if (!String((error as { message?: unknown })?.message ?? '').toLowerCase().includes('no such table')) {
            throw error;
          }
        }
      }
    }

    try {
      database.exec('ALTER TABLE working_memory ADD COLUMN episode_recap TEXT');
    } catch (error) {
      // Column already exists on upgraded databases; rethrow real failures.
      if (!isBenignAlterProbeError(error)) throw error;
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
      } catch (error) {
        // Column already exists (upgraded db) or target table not yet created
        // (fresh db). Rethrow real failures.
        if (!isBenignAlterProbeError(error)) throw error;
      }
    }

    // v15: Backfill existing associations confidence from 0.5 → 0.8
    try {
      database.exec("UPDATE associations SET confidence = 0.8 WHERE confidence = 0.5");
    } catch (error) {
      // Best-effort backfill; associations may not exist yet on a fresh db.
      if (!String((error as { message?: unknown })?.message ?? '').toLowerCase().includes('no such table')) {
        throw error;
      }
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

    -- Current-state projection only; historical claim transitions are moved to
    -- work_claims_history when a work item is reclaimed (see 0.1). This table
    -- holds at most one row per work_item_id (enforced by UNIQUE below).
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

    -- v20: history of displaced (expired/released) claims. Preserves each
    -- claim's original id so getWorkClaimById and claim listings continue to
    -- surface historical claims. No UNIQUE(work_item_id): many historical
    -- claims may exist per work item.
    CREATE TABLE IF NOT EXISTS work_claims_history (
      id                 INTEGER PRIMARY KEY,
      tenant_id          TEXT    NOT NULL,
      system_id          TEXT    NOT NULL,
      workspace_id       TEXT    NOT NULL DEFAULT 'default',
      collaboration_id   TEXT    NOT NULL DEFAULT '',
      scope_id           TEXT    NOT NULL,
      work_item_id       INTEGER NOT NULL,
      session_id         TEXT,
      actor_kind         TEXT    NOT NULL,
      actor_id           TEXT    NOT NULL,
      actor_system_id    TEXT,
      actor_display_name TEXT,
      actor_metadata     TEXT,
      claim_token        TEXT    NOT NULL,
      status             TEXT    NOT NULL,
      claimed_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      released_at        INTEGER,
      release_reason     TEXT,
      source_event_id    INTEGER,
      visibility_class   TEXT    NOT NULL DEFAULT 'private',
      version            INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_work_claims_history_work_item
      ON work_claims_history(work_item_id, claimed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_claims_history_scope
      ON work_claims_history(tenant_id, system_id, workspace_id, collaboration_id, scope_id, claimed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_claims_history_actor_status
      ON work_claims_history(actor_kind, actor_id, status);

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

    CREATE TABLE IF NOT EXISTS scope_config (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      config_key        TEXT    NOT NULL,
      config_value      TEXT    NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_config_key
      ON scope_config(tenant_id, system_id, workspace_id, collaboration_id, scope_id, config_key);
  `);

    // ──────────────────────────── context governance (v18) ────────────────────────────
    database.exec(`
    CREATE TABLE IF NOT EXISTS context_contracts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      name              TEXT,
      is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      is_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
      contract_json     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (
        (is_default = 1 AND name IS NULL) OR
        (is_default = 0 AND name IS NOT NULL)
      ),
      CHECK (
        (is_deleted = 0 AND contract_json IS NOT NULL) OR
        (is_deleted = 1 AND contract_json IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_contract_scope_default
      ON context_contracts(tenant_id, system_id, workspace_id, collaboration_id, scope_id)
      WHERE is_default = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_contract_scope_name
      ON context_contracts(tenant_id, system_id, workspace_id, collaboration_id, scope_id, name)
      WHERE is_default = 0;

    CREATE TABLE IF NOT EXISTS context_invariants (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      invariant_id      TEXT    NOT NULL,
      title             TEXT,
      instruction       TEXT,
      severity          TEXT,
      scope_level       TEXT,
      is_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (
        (is_deleted = 0 AND title IS NOT NULL AND instruction IS NOT NULL) OR
        (is_deleted = 1 AND title IS NULL AND instruction IS NULL AND severity IS NULL AND scope_level IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_invariant_scope_id
      ON context_invariants(tenant_id, system_id, workspace_id, collaboration_id, scope_id, invariant_id);

    CREATE TABLE IF NOT EXISTS context_escalation_policies (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      policy_json       TEXT    NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_escalation_scope
      ON context_escalation_policies(tenant_id, system_id, workspace_id, collaboration_id, scope_id);
  `);

    if (existingVersion >= 17 && existingVersion < 18) {
      // Normal upgrade path: the live governance tables still hold v17-shaped
      // data. Rename them aside so the copy-with-transform below can rebuild
      // them. If a prior run already renamed (crash recovery), the rename is a
      // no-op because the _v17 tables already exist.
      renameContractsToV17(database);
      rebuildContractsFromV17IfPresent(database);
    }

    // ── v21 (Phase 2.4): embedding provenance columns ───────────────────────
    // Make the knowledge_embeddings table AND its `model`/`dimensions`
    // provenance columns a REAL gated migration so a v21 stamp genuinely implies
    // the columns exist. Previously these columns were added lazily by
    // ensureEmbeddingSchema (embeddings.ts) only when the embedding adapter was
    // constructed — so a plain createSQLiteAdapter stamped v21 without the schema
    // change, and the Phase 0 downgrade guard then blocked reopening with 4.2.x
    // for no real change. Idempotent + transactional; the version stamp below
    // runs last, so a crash before it rolls the whole migration back.
    database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        knowledge_memory_id INTEGER PRIMARY KEY REFERENCES knowledge_memory(id) ON DELETE CASCADE,
        vector BLOB NOT NULL,
        dimensions INTEGER,
        model TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL
      );
    `);
    if (existingVersion < 21) {
      // Pre-v21 databases created knowledge_embeddings without the `model` column.
      // Add it idempotently, then backfill `dimensions` from the packed Float32
      // blob length (4 bytes per component) for any legacy row missing it.
      try {
        database.exec("ALTER TABLE knowledge_embeddings ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'");
      } catch (error) {
        if (!isBenignAlterProbeError(error)) throw error;
      }
      database.exec(
        'UPDATE knowledge_embeddings SET dimensions = length(vector) / 4 WHERE dimensions IS NULL',
      );
    }

    // ── Stamp the schema version LAST ───────────────────────────────────────
    // Only after every version-gated migration above has completed successfully.
    // Because this runs inside the migration transaction, a crash before this
    // point rolls back the whole migration and leaves the version unstamped, so
    // the migration re-runs cleanly on the next open.
    database
      .prepare(
        `INSERT INTO schema_meta (id, schema_version, updated_at)
         VALUES (1, ?, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(CURRENT_SCHEMA_VERSION);
  });

  runMigration();
}


/** Returns true when a table with the given name exists. */
function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { name?: string } | undefined
    )?.name,
  );
}

/** Returns true when the named table exists and holds at least one row. */
function tableHasRows(database: Database.Database, name: string): boolean {
  if (!tableExists(database, name)) return false;
  const row = database
    .prepare(`SELECT EXISTS(SELECT 1 FROM ${name}) AS present`)
    .get() as { present: number } | undefined;
  return Boolean(row?.present);
}

/**
 * Rename the live v17 governance tables aside to `_v17` so the rebuild can copy
 * from them with the v17→v18 data transform. Safe to call when the `_v17`
 * tables already exist (crash recovery): the rename of an already-renamed table
 * is skipped. Only renames the live tables when their `_v17` counterparts do not
 * yet exist.
 */
function renameContractsToV17(database: Database.Database): void {
  if (tableExists(database, 'context_contracts') && !tableExists(database, 'context_contracts_v17')) {
    database.exec(`
      DROP INDEX IF EXISTS idx_ctx_contract_scope_default;
      DROP INDEX IF EXISTS idx_ctx_contract_scope_name;
      ALTER TABLE context_contracts RENAME TO context_contracts_v17;
    `);
  }
  if (tableExists(database, 'context_invariants') && !tableExists(database, 'context_invariants_v17')) {
    database.exec(`
      DROP INDEX IF EXISTS idx_ctx_invariant_scope_id;
      ALTER TABLE context_invariants RENAME TO context_invariants_v17;
    `);
  }
}

/**
 * Complete (or perform) the v17→v18 rebuild for whichever `_v17` governance
 * tables are present. This is the single code path for both the normal upgrade
 * (after {@link renameContractsToV17}) and crash recovery (where a prior run
 * left `_v17` tables stranded).
 *
 * DATA-SAFETY GUARD (plan 0.3c): the copy runs ONLY when the corresponding live
 * table is empty. This is the invariant that distinguishes the two safe states
 * from the dangerous one:
 *
 *  - Normal upgrade / new-code crash recovery: the RENAME moved the live rows
 *    into `_v17`, so the live table is absent or freshly (empty-)created. The
 *    copy completes the interrupted migration.
 *  - OLD-code stranded state: the old migration stamped the schema version
 *    BEFORE the rebuild, so a user could reopen with new code, write rows into
 *    the live table, and leave `_v17` stranded alongside a NON-empty live table.
 *    Blindly dropping+recopying would destroy those user-written rows. Instead
 *    we leave the live table untouched and rename the stale `_v17` aside to
 *    `*_v17_orphaned` so it stops re-triggering recovery, warning the operator
 *    that it holds pre-migration governance rows that were not auto-restored.
 *
 * Idempotent and a no-op when no `_v17` tables exist. Runs within the caller's
 * transaction so the whole operation is atomic.
 */
function rebuildContractsFromV17IfPresent(database: Database.Database): void {
  if (tableExists(database, 'context_contracts_v17')) {
    if (tableHasRows(database, 'context_contracts')) {
      // Live table already holds rows a user wrote after an interrupted OLD-code
      // migration. Do NOT overwrite them. Rename the stale copy aside so it stops
      // triggering recovery on every open, and tell the operator it was preserved
      // but not auto-restored.
      database.exec(`
        DROP TABLE IF EXISTS context_contracts_v17_orphaned;
        ALTER TABLE context_contracts_v17 RENAME TO context_contracts_v17_orphaned;
      `);
      console.warn(
        '[ai-memory-layer] Found stranded pre-migration governance data in ' +
          '"context_contracts_v17" alongside a non-empty live "context_contracts" ' +
          'table. To avoid destroying rows written after an interrupted migration, ' +
          'the live table was left untouched and the stale copy was renamed to ' +
          '"context_contracts_v17_orphaned". It was NOT auto-restored; inspect it ' +
          'manually if you need those rows and drop it once reconciled.',
      );
    } else {
      database.exec(`
      DROP INDEX IF EXISTS idx_ctx_contract_scope_default;
      DROP INDEX IF EXISTS idx_ctx_contract_scope_name;
      DROP TABLE IF EXISTS context_contracts;

      CREATE TABLE context_contracts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id         TEXT    NOT NULL,
        system_id         TEXT    NOT NULL,
        workspace_id      TEXT    NOT NULL DEFAULT 'default',
        collaboration_id  TEXT    NOT NULL DEFAULT '',
        scope_id          TEXT    NOT NULL,
        name              TEXT,
        is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        is_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
        contract_json     TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        CHECK (
          (is_default = 1 AND name IS NULL) OR
          (is_default = 0 AND name IS NOT NULL)
        ),
        CHECK (
          (is_deleted = 0 AND contract_json IS NOT NULL) OR
          (is_deleted = 1 AND contract_json IS NULL)
        )
      );
      CREATE UNIQUE INDEX idx_ctx_contract_scope_default
        ON context_contracts(tenant_id, system_id, workspace_id, collaboration_id, scope_id)
        WHERE is_default = 1;
      CREATE UNIQUE INDEX idx_ctx_contract_scope_name
        ON context_contracts(tenant_id, system_id, workspace_id, collaboration_id, scope_id, name)
        WHERE is_default = 0;

      INSERT INTO context_contracts (
        tenant_id, system_id, workspace_id, collaboration_id, scope_id,
        name, is_default, is_deleted, contract_json, created_at, updated_at
      )
      SELECT
        tenant_id, system_id, workspace_id, collaboration_id, scope_id,
        CASE WHEN is_default = 1 AND name = '__default__' THEN NULL ELSE name END,
        CASE WHEN is_default = 1 AND name = '__default__' THEN 1 ELSE 0 END,
        0,
        contract_json, created_at, updated_at
      FROM context_contracts_v17;

      DROP TABLE context_contracts_v17;
    `);
    }
  }

  if (tableExists(database, 'context_invariants_v17')) {
    if (tableHasRows(database, 'context_invariants')) {
      // See the contracts branch above: preserve the user-written live rows and
      // rename the stranded pre-migration copy aside instead of overwriting.
      database.exec(`
        DROP TABLE IF EXISTS context_invariants_v17_orphaned;
        ALTER TABLE context_invariants_v17 RENAME TO context_invariants_v17_orphaned;
      `);
      console.warn(
        '[ai-memory-layer] Found stranded pre-migration governance data in ' +
          '"context_invariants_v17" alongside a non-empty live "context_invariants" ' +
          'table. To avoid destroying rows written after an interrupted migration, ' +
          'the live table was left untouched and the stale copy was renamed to ' +
          '"context_invariants_v17_orphaned". It was NOT auto-restored; inspect it ' +
          'manually if you need those rows and drop it once reconciled.',
      );
    } else {
      database.exec(`
      DROP INDEX IF EXISTS idx_ctx_invariant_scope_id;
      DROP TABLE IF EXISTS context_invariants;

      CREATE TABLE context_invariants (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id         TEXT    NOT NULL,
        system_id         TEXT    NOT NULL,
        workspace_id      TEXT    NOT NULL DEFAULT 'default',
        collaboration_id  TEXT    NOT NULL DEFAULT '',
        scope_id          TEXT    NOT NULL,
        invariant_id      TEXT    NOT NULL,
        title             TEXT,
        instruction       TEXT,
        severity          TEXT,
        scope_level       TEXT,
        is_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        CHECK (
          (is_deleted = 0 AND title IS NOT NULL AND instruction IS NOT NULL) OR
          (is_deleted = 1 AND title IS NULL AND instruction IS NULL AND severity IS NULL AND scope_level IS NULL)
        )
      );
      CREATE UNIQUE INDEX idx_ctx_invariant_scope_id
        ON context_invariants(tenant_id, system_id, workspace_id, collaboration_id, scope_id, invariant_id);

      INSERT INTO context_invariants (
        tenant_id, system_id, workspace_id, collaboration_id, scope_id,
        invariant_id, title, instruction, severity, scope_level, is_deleted,
        created_at, updated_at
      )
      SELECT
        tenant_id, system_id, workspace_id, collaboration_id, scope_id,
        invariant_id, title, instruction, severity, scope_level, 0,
        created_at, updated_at
      FROM context_invariants_v17;

      DROP TABLE context_invariants_v17;
    `);
    }
  }
}
