// ---------------------------------------------------------------------------
// @nanoclaw/memory - SQLite Storage Layer (v1)
// ---------------------------------------------------------------------------
// Standalone extraction. No external config dependency.
// Call initMemoryDatabase(dbPath) with the desired file path,
// or _initTestMemoryDatabase() for in-memory test instances.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import Database from 'better-sqlite3';

import {
  COMPACTION_STATES,
  COMPACTION_TRIGGERS,
  FACT_CONFIDENCES,
  FACT_SOURCES,
  FACT_TYPES,
  TURN_ROLES,
  type CompactionLog,
  type CompactionState,
  type ContextMonitor,
  type ContextMonitorUpsert,
  type KnowledgeMemory,
  type NewCompactionLog,
  type NewKnowledgeMemory,
  type NewTurn,
  type NewWorkingMemory,
  type Turn,
  type WorkingMemory,
} from './types.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let db: Database.Database;
let _dbPath: string | null = null;

/** Returns the path the database was initialized with, or null if in-memory. */
export function getMemoryDbPath(): string | null {
  return _dbPath;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const TOKEN_MULTIPLIER = 1.15;
const CHARS_PER_TOKEN = 4;

/**
 * Conservative token estimate: ceil(length / 4 * 1.15).
 * Intentionally over-counts to avoid under-triggering compaction.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_MULTIPLIER));
}

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

export function createSessionId(channel: string, groupJid: string): string {
  if (!channel) throw new Error("Memory validation: 'channel' must not be empty");
  if (!groupJid) throw new Error("Memory validation: 'group_jid' must not be empty");
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(4).toString('hex');
  return `${channel}_${groupJid}_${date}_${rand}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function assertNonEmpty(value: string, name: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Memory validation: '${name}' must not be empty`);
  }
}

function assertEnum<T>(value: T, allowed: readonly T[], name: string): void {
  if (!allowed.includes(value)) {
    throw new Error(
      `Memory validation: '${name}' must be one of [${allowed.join(', ')}], got '${value}'`,
    );
  }
}

function toJsonArray(arr: string[]): string {
  return JSON.stringify(arr);
}

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function assertValidJsonArray(json: string, name: string): void {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error(`Memory validation: '${name}' must be a JSON array`);
    }
  } catch {
    throw new Error(`Memory validation: '${name}' must be valid JSON`);
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function createMemorySchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT    NOT NULL,
      channel           TEXT    NOT NULL,
      group_jid         TEXT    NOT NULL,
      sender            TEXT    NOT NULL,
      role              TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content           TEXT    NOT NULL,
      token_estimate    INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      archived_at       INTEGER,
      compaction_log_id INTEGER REFERENCES compaction_log(id),
      schema_version    INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_channel_group ON turns(channel, group_jid);
    CREATE INDEX IF NOT EXISTS idx_turns_archived ON turns(archived_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      content, content=turns, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS working_memory (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id               TEXT    NOT NULL,
      channel                  TEXT    NOT NULL,
      group_jid                TEXT    NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_wm_channel_group ON working_memory(channel, group_jid);

    CREATE TABLE IF NOT EXISTS knowledge_memory (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      channel                  TEXT    NOT NULL,
      group_jid                TEXT    NOT NULL,
      fact                     TEXT    NOT NULL,
      fact_type                TEXT    NOT NULL,
      source                   TEXT    NOT NULL,
      confidence               TEXT    NOT NULL DEFAULT 'high',
      source_working_memory_id INTEGER REFERENCES working_memory(id),
      superseded_by_id         INTEGER REFERENCES knowledge_memory(id),
      created_at               INTEGER NOT NULL,
      last_accessed_at         INTEGER NOT NULL,
      access_count             INTEGER NOT NULL DEFAULT 1,
      schema_version           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_km_channel_group ON knowledge_memory(channel, group_jid);
    CREATE INDEX IF NOT EXISTS idx_km_superseded ON knowledge_memory(superseded_by_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_memory_fts USING fts5(
      fact, content=knowledge_memory, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS km_ai AFTER INSERT ON knowledge_memory BEGIN
      INSERT INTO knowledge_memory_fts(rowid, fact) VALUES (new.id, new.fact);
    END;

    CREATE TABLE IF NOT EXISTS context_monitor (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      channel               TEXT    NOT NULL,
      group_jid             TEXT    NOT NULL,
      compaction_state      TEXT    NOT NULL DEFAULT 'idle',
      last_compaction_at    INTEGER,
      active_turn_count     INTEGER NOT NULL DEFAULT 0,
      active_token_estimate INTEGER NOT NULL DEFAULT 0,
      compaction_score      INTEGER NOT NULL DEFAULT 0,
      updated_at            INTEGER NOT NULL,
      UNIQUE(channel, group_jid)
    );

    CREATE TABLE IF NOT EXISTS compaction_log (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id               TEXT    NOT NULL,
      channel                  TEXT    NOT NULL,
      group_jid                TEXT    NOT NULL,
      trigger_type             TEXT    NOT NULL,
      turn_id_start            INTEGER NOT NULL,
      turn_id_end              INTEGER NOT NULL,
      turns_compacted          INTEGER NOT NULL,
      tokens_compacted_estimate INTEGER NOT NULL,
      working_memory_id        INTEGER NOT NULL REFERENCES working_memory(id),
      active_turn_count_before INTEGER NOT NULL,
      active_turn_count_after  INTEGER NOT NULL,
      duration_ms              INTEGER NOT NULL,
      model_call_made          INTEGER NOT NULL DEFAULT 0,
      error                    TEXT,
      created_at               INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cl_channel_group ON compaction_log(channel, group_jid);
  `);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the memory database at the given file path.
 * Creates the directory and file if they don't exist.
 */
export function initMemoryDatabase(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  _dbPath = dbPath;
  createMemorySchema(db);
}

/**
 * Initialize an in-memory database for testing.
 * Safe to call multiple times (recreates a fresh DB each time).
 */
export function _initTestMemoryDatabase(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  db = new Database(':memory:');
  _dbPath = null;
  createMemorySchema(db);
}

/**
 * Close the database connection. Call during graceful shutdown.
 */
export function closeMemoryDatabase(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Turns - CRUD
// ---------------------------------------------------------------------------

export function insertTurn(input: NewTurn): Turn {
  assertNonEmpty(input.session_id, 'session_id');
  assertNonEmpty(input.channel, 'channel');
  assertNonEmpty(input.group_jid, 'group_jid');
  assertNonEmpty(input.sender, 'sender');
  assertNonEmpty(input.content, 'content');
  assertEnum(input.role, TURN_ROLES, 'role');

  const tokenEstimate = input.token_estimate ?? estimateTokens(input.content);
  const createdAt = input.created_at ?? nowSeconds();

  const result = db
    .prepare(
      `INSERT INTO turns (session_id, channel, group_jid, sender, role, content, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.session_id,
      input.channel,
      input.group_jid,
      input.sender,
      input.role,
      input.content,
      tokenEstimate,
      createdAt,
    );

  return getTurnById(Number(result.lastInsertRowid))!;
}

export function getTurnById(id: number): Turn | null {
  return (db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Turn) ?? null;
}

export function getActiveTurns(channel: string, groupJid: string): Turn[] {
  return db
    .prepare(
      `SELECT * FROM turns
       WHERE channel = ? AND group_jid = ? AND archived_at IS NULL
       ORDER BY id ASC`,
    )
    .all(channel, groupJid) as Turn[];
}

/**
 * Mark a turn as archived. Both archivedAt and compactionLogId are required
 * and must be set together.
 */
export function archiveTurn(
  id: number,
  archivedAt: number,
  compactionLogId: number,
): void {
  db.prepare(
    `UPDATE turns
     SET archived_at = ?, compaction_log_id = ?
     WHERE id = ? AND archived_at IS NULL`,
  ).run(archivedAt, compactionLogId, id);
}

export function getArchivedTurnRange(
  sessionId: string,
  startId: number,
  endId: number,
): Turn[] {
  return db
    .prepare(
      `SELECT * FROM turns
       WHERE session_id = ? AND id >= ? AND id <= ? AND archived_at IS NOT NULL
       ORDER BY id ASC`,
    )
    .all(sessionId, startId, endId) as Turn[];
}

// ---------------------------------------------------------------------------
// Working Memory - CRUD
// ---------------------------------------------------------------------------

interface WorkingMemoryRow {
  id: number;
  session_id: string;
  channel: string;
  group_jid: string;
  summary: string;
  key_entities: string;
  topic_tags: string;
  turn_id_start: number;
  turn_id_end: number;
  turn_count: number;
  compaction_trigger: string;
  created_at: number;
  expires_at: number | null;
  promoted_to_knowledge_id: number | null;
  schema_version: number;
}

function rowToWorkingMemory(row: WorkingMemoryRow): WorkingMemory {
  return {
    ...row,
    key_entities: parseJsonArray(row.key_entities),
    topic_tags: parseJsonArray(row.topic_tags),
    compaction_trigger:
      row.compaction_trigger as WorkingMemory['compaction_trigger'],
  };
}

export function insertWorkingMemory(input: NewWorkingMemory): WorkingMemory {
  assertNonEmpty(input.session_id, 'session_id');
  assertNonEmpty(input.channel, 'channel');
  assertNonEmpty(input.group_jid, 'group_jid');
  assertNonEmpty(input.summary, 'summary');
  assertEnum(
    input.compaction_trigger,
    COMPACTION_TRIGGERS,
    'compaction_trigger',
  );

  if (input.topic_tags.length > 5) {
    throw new Error(
      `Memory validation: 'topic_tags' must have at most 5 entries, got ${input.topic_tags.length}`,
    );
  }
  if (input.turn_id_end < input.turn_id_start) {
    throw new Error(
      `Memory validation: 'turn_id_end' (${input.turn_id_end}) must be >= 'turn_id_start' (${input.turn_id_start})`,
    );
  }

  const keyEntitiesJson = toJsonArray(input.key_entities);
  const topicTagsJson = toJsonArray(input.topic_tags);
  assertValidJsonArray(keyEntitiesJson, 'key_entities');
  assertValidJsonArray(topicTagsJson, 'topic_tags');

  const createdAt = nowSeconds();
  const expiresAt = input.expires_at ?? createdAt + 86400; // default 24h

  const result = db
    .prepare(
      `INSERT INTO working_memory
        (session_id, channel, group_jid, summary, key_entities, topic_tags,
         turn_id_start, turn_id_end, turn_count, compaction_trigger, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.session_id,
      input.channel,
      input.group_jid,
      input.summary,
      keyEntitiesJson,
      topicTagsJson,
      input.turn_id_start,
      input.turn_id_end,
      input.turn_count,
      input.compaction_trigger,
      createdAt,
      expiresAt,
    );

  return getWorkingMemoryById(Number(result.lastInsertRowid))!;
}

export function getWorkingMemoryById(id: number): WorkingMemory | null {
  const row = db
    .prepare('SELECT * FROM working_memory WHERE id = ?')
    .get(id) as WorkingMemoryRow | undefined;
  return row ? rowToWorkingMemory(row) : null;
}

export function getWorkingMemoryBySession(sessionId: string): WorkingMemory[] {
  const rows = db
    .prepare('SELECT * FROM working_memory WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as WorkingMemoryRow[];
  return rows.map(rowToWorkingMemory);
}

export function getActiveWorkingMemory(
  channel: string,
  groupJid: string,
): WorkingMemory[] {
  const now = nowSeconds();
  const rows = db
    .prepare(
      `SELECT * FROM working_memory
       WHERE channel = ? AND group_jid = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id DESC`,
    )
    .all(channel, groupJid, now) as WorkingMemoryRow[];
  return rows.map(rowToWorkingMemory);
}

export function getLatestWorkingMemory(
  channel: string,
  groupJid: string,
): WorkingMemory | null {
  const now = nowSeconds();
  const row = db
    .prepare(
      `SELECT * FROM working_memory
       WHERE channel = ? AND group_jid = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(channel, groupJid, now) as WorkingMemoryRow | undefined;
  return row ? rowToWorkingMemory(row) : null;
}

export function expireWorkingMemory(id: number): void {
  db.prepare(
    `UPDATE working_memory SET expires_at = ? WHERE id = ?`,
  ).run(nowSeconds(), id);
}

export function markWorkingMemoryPromoted(
  id: number,
  knowledgeMemoryId: number,
): void {
  db.prepare(
    `UPDATE working_memory SET promoted_to_knowledge_id = ? WHERE id = ?`,
  ).run(knowledgeMemoryId, id);
}

// ---------------------------------------------------------------------------
// Knowledge Memory - CRUD
// ---------------------------------------------------------------------------

export function insertKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory {
  assertNonEmpty(input.channel, 'channel');
  assertNonEmpty(input.group_jid, 'group_jid');
  assertNonEmpty(input.fact, 'fact');
  assertEnum(input.fact_type, FACT_TYPES, 'fact_type');
  assertEnum(input.source, FACT_SOURCES, 'source');
  assertEnum(input.confidence, FACT_CONFIDENCES, 'confidence');

  const createdAt = nowSeconds();

  const result = db
    .prepare(
      `INSERT INTO knowledge_memory
        (channel, group_jid, fact, fact_type, source, confidence,
         source_working_memory_id, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.channel,
      input.group_jid,
      input.fact,
      input.fact_type,
      input.source,
      input.confidence,
      input.source_working_memory_id ?? null,
      createdAt,
      createdAt,
    );

  return getKnowledgeMemoryById(Number(result.lastInsertRowid))!;
}

export function getKnowledgeMemoryById(id: number): KnowledgeMemory | null {
  return (
    (db.prepare('SELECT * FROM knowledge_memory WHERE id = ?').get(id) as KnowledgeMemory) ??
    null
  );
}

export function getActiveKnowledgeMemory(
  channel: string,
  groupJid: string,
): KnowledgeMemory[] {
  return db
    .prepare(
      `SELECT * FROM knowledge_memory
       WHERE channel = ? AND group_jid = ? AND superseded_by_id IS NULL
       ORDER BY last_accessed_at DESC`,
    )
    .all(channel, groupJid) as KnowledgeMemory[];
}

export function touchKnowledgeMemory(id: number): void {
  db.prepare(
    `UPDATE knowledge_memory
     SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id = ?`,
  ).run(nowSeconds(), id);
}

export function supersedeKnowledgeMemory(
  oldId: number,
  newId: number,
): void {
  db.prepare(
    `UPDATE knowledge_memory SET superseded_by_id = ? WHERE id = ?`,
  ).run(newId, oldId);
}

// ---------------------------------------------------------------------------
// Context Monitor - CRUD
// ---------------------------------------------------------------------------

export function upsertContextMonitor(input: ContextMonitorUpsert): ContextMonitor {
  assertNonEmpty(input.channel, 'channel');
  assertNonEmpty(input.group_jid, 'group_jid');
  assertEnum(input.compaction_state, COMPACTION_STATES, 'compaction_state');

  const updatedAt = nowSeconds();
  const lastCompactionAt = input.last_compaction_at ?? null;

  db.prepare(
    `INSERT INTO context_monitor
      (channel, group_jid, compaction_state, last_compaction_at,
       active_turn_count, active_token_estimate, compaction_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, group_jid) DO UPDATE SET
       compaction_state = excluded.compaction_state,
       last_compaction_at = excluded.last_compaction_at,
       active_turn_count = excluded.active_turn_count,
       active_token_estimate = excluded.active_token_estimate,
       compaction_score = excluded.compaction_score,
       updated_at = excluded.updated_at`,
  ).run(
    input.channel,
    input.group_jid,
    input.compaction_state,
    lastCompactionAt,
    input.active_turn_count,
    input.active_token_estimate,
    input.compaction_score,
    updatedAt,
  );

  return getContextMonitor(input.channel, input.group_jid)!;
}

export function getContextMonitor(
  channel: string,
  groupJid: string,
): ContextMonitor | null {
  return (
    (db
      .prepare(
        'SELECT * FROM context_monitor WHERE channel = ? AND group_jid = ?',
      )
      .get(channel, groupJid) as ContextMonitor) ?? null
  );
}

// ---------------------------------------------------------------------------
// Compaction Log - CRUD
// ---------------------------------------------------------------------------

export function insertCompactionLog(input: NewCompactionLog): CompactionLog {
  assertNonEmpty(input.session_id, 'session_id');
  assertNonEmpty(input.channel, 'channel');
  assertNonEmpty(input.group_jid, 'group_jid');
  assertEnum(input.trigger_type, COMPACTION_TRIGGERS, 'trigger_type');

  const createdAt = input.created_at ?? nowSeconds();
  const modelCallMade = input.model_call_made ? 1 : 0;

  const result = db
    .prepare(
      `INSERT INTO compaction_log
        (session_id, channel, group_jid, trigger_type,
         turn_id_start, turn_id_end, turns_compacted, tokens_compacted_estimate,
         working_memory_id, active_turn_count_before, active_turn_count_after,
         duration_ms, model_call_made, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.session_id,
      input.channel,
      input.group_jid,
      input.trigger_type,
      input.turn_id_start,
      input.turn_id_end,
      input.turns_compacted,
      input.tokens_compacted_estimate,
      input.working_memory_id,
      input.active_turn_count_before,
      input.active_turn_count_after,
      input.duration_ms,
      modelCallMade,
      input.error ?? null,
      createdAt,
    );

  return getCompactionLogById(Number(result.lastInsertRowid))!;
}

export function getCompactionLogById(id: number): CompactionLog | null {
  const row = db
    .prepare('SELECT * FROM compaction_log WHERE id = ?')
    .get(id) as (Omit<CompactionLog, 'model_call_made'> & { model_call_made: number }) | undefined;
  if (!row) return null;
  return { ...row, model_call_made: row.model_call_made === 1 };
}

/**
 * Most recent compaction logs for a (channel, group_jid), newest first.
 */
export function getRecentCompactionLogs(
  channel: string,
  groupJid: string,
  limit = 10,
): CompactionLog[] {
  const rows = db
    .prepare(
      `SELECT * FROM compaction_log
       WHERE channel = ? AND group_jid = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(channel, groupJid, limit) as (Omit<CompactionLog, 'model_call_made'> & {
    model_call_made: number;
  })[];
  return rows.map((row) => ({
    ...row,
    model_call_made: row.model_call_made === 1,
  }));
}
