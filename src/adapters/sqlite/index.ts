import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import type { StorageAdapter } from '../../contracts/storage.js';
import type {
  CompactionLog,
  ContextMonitor,
  KnowledgeMemory,
  NewCompactionLog,
  NewKnowledgeMemory,
  NewTurn,
  NewWorkingMemory,
  Turn,
  WorkingMemory,
} from '../../contracts/types.js';
import { estimateTokens } from '../../core/tokens.js';
import {
  assertArchiveInput,
  nowSeconds,
  validateContextMonitorUpsert,
  validateNewCompactionLog,
  validateNewKnowledgeMemory,
  validateNewTurn,
  validateNewWorkingMemory,
} from '../../core/validation.js';
import {
  rowToCompactionLog,
  rowToContextMonitor,
  rowToKnowledgeMemory,
  rowToTurn,
  rowToWorkingMemory,
  serializeStringArray,
  type CompactionLogRow,
  type WorkingMemoryRow,
} from './mappers.js';
import { createSQLiteSchema } from './schema.js';

const SCOPE_WHERE = 'tenant_id = ? AND system_id = ? AND workspace_id = ? AND scope_id = ?';

export function createSQLiteAdapter(dbPath: string | ':memory:'): StorageAdapter {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  createSQLiteSchema(db);

  function getTurnById(id: number): Turn | null {
    const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Turn | undefined;
    return row ? rowToTurn(row) : null;
  }

  function getWorkingMemoryById(id: number): WorkingMemory | null {
    const row = db
      .prepare('SELECT * FROM working_memory WHERE id = ?')
      .get(id) as WorkingMemoryRow | undefined;
    return row ? rowToWorkingMemory(row) : null;
  }

  function getKnowledgeMemoryById(id: number): KnowledgeMemory | null {
    const row = db
      .prepare('SELECT * FROM knowledge_memory WHERE id = ?')
      .get(id) as KnowledgeMemory | undefined;
    return row ? rowToKnowledgeMemory(row) : null;
  }

  function getContextMonitor(scope: Parameters<StorageAdapter['getContextMonitor']>[0]): ContextMonitor | null {
    const normalized = validateContextMonitorUpsert({
      ...scope,
      compaction_state: 'idle',
      active_turn_count: 0,
      active_token_estimate: 0,
      compaction_score: 0,
    });
    const row = db
      .prepare(`SELECT * FROM context_monitor WHERE ${SCOPE_WHERE}`)
      .get(...Object.values(normalized)) as ContextMonitor | undefined;
    return row ? rowToContextMonitor(row) : null;
  }

  function getCompactionLogById(id: number): CompactionLog | null {
    const row = db
      .prepare('SELECT * FROM compaction_log WHERE id = ?')
      .get(id) as CompactionLogRow | undefined;
    return row ? rowToCompactionLog(row) : null;
  }

  return {
    insertTurn(input: NewTurn): Turn {
      const scope = validateNewTurn(input);
      const tokenEstimate = input.token_estimate ?? estimateTokens(input.content);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO turns
            (session_id, tenant_id, system_id, workspace_id, scope_id, actor, role, content, token_estimate, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.scope_id,
          input.actor,
          input.role,
          input.content,
          tokenEstimate,
          createdAt,
        );

      return getTurnById(Number(result.lastInsertRowid))!;
    },

    getTurnById,

    getActiveTurns(scope): Turn[] {
      const normalized = validateContextMonitorUpsert({
        ...scope,
        compaction_state: 'idle',
        active_turn_count: 0,
        active_token_estimate: 0,
        compaction_score: 0,
      });
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE ${SCOPE_WHERE} AND archived_at IS NULL
           ORDER BY id ASC`,
        )
        .all(...Object.values(normalized)) as Turn[];
      return rows.map(rowToTurn);
    },

    archiveTurn(id: number, archivedAt: number, compactionLogId: number): void {
      assertArchiveInput(id, archivedAt, compactionLogId);
      db.prepare(
        `UPDATE turns
         SET archived_at = ?, compaction_log_id = ?
         WHERE id = ? AND archived_at IS NULL`,
      ).run(archivedAt, compactionLogId, id);
    },

    getArchivedTurnRange(sessionId: string, startId: number, endId: number): Turn[] {
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE session_id = ? AND id >= ? AND id <= ? AND archived_at IS NOT NULL
           ORDER BY id ASC`,
        )
        .all(sessionId, startId, endId) as Turn[];
      return rows.map(rowToTurn);
    },

    insertWorkingMemory(input: NewWorkingMemory): WorkingMemory {
      const scope = validateNewWorkingMemory(input);
      const createdAt = nowSeconds();
      const expiresAt = input.expires_at ?? createdAt + 86400;
      const result = db
        .prepare(
          `INSERT INTO working_memory
            (session_id, tenant_id, system_id, workspace_id, scope_id, summary, key_entities, topic_tags,
             turn_id_start, turn_id_end, turn_count, compaction_trigger, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.scope_id,
          input.summary,
          serializeStringArray(input.key_entities),
          serializeStringArray(input.topic_tags),
          input.turn_id_start,
          input.turn_id_end,
          input.turn_count,
          input.compaction_trigger,
          createdAt,
          expiresAt,
        );
      return getWorkingMemoryById(Number(result.lastInsertRowid))!;
    },

    getWorkingMemoryById,

    getWorkingMemoryBySession(sessionId: string): WorkingMemory[] {
      const rows = db
        .prepare('SELECT * FROM working_memory WHERE session_id = ? ORDER BY id ASC')
        .all(sessionId) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
    },

    getActiveWorkingMemory(scope): WorkingMemory[] {
      const normalized = validateContextMonitorUpsert({
        ...scope,
        compaction_state: 'idle',
        active_turn_count: 0,
        active_token_estimate: 0,
        compaction_score: 0,
      });
      const now = nowSeconds();
      const rows = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY id DESC`,
        )
        .all(...Object.values(normalized), now) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
    },

    getLatestWorkingMemory(scope): WorkingMemory | null {
      const normalized = validateContextMonitorUpsert({
        ...scope,
        compaction_state: 'idle',
        active_turn_count: 0,
        active_token_estimate: 0,
        compaction_score: 0,
      });
      const now = nowSeconds();
      const row = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(...Object.values(normalized), now) as WorkingMemoryRow | undefined;
      return row ? rowToWorkingMemory(row) : null;
    },

    expireWorkingMemory(id: number): void {
      db.prepare('UPDATE working_memory SET expires_at = ? WHERE id = ?').run(nowSeconds(), id);
    },

    markWorkingMemoryPromoted(id: number, knowledgeMemoryId: number): void {
      db.prepare(
        'UPDATE working_memory SET promoted_to_knowledge_id = ? WHERE id = ?',
      ).run(knowledgeMemoryId, id);
    },

    insertKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory {
      const scope = validateNewKnowledgeMemory(input);
      const createdAt = nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO knowledge_memory
            (tenant_id, system_id, workspace_id, scope_id, fact, fact_type, source, confidence,
             source_working_memory_id, created_at, last_accessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.scope_id,
          input.fact,
          input.fact_type,
          input.source,
          input.confidence,
          input.source_working_memory_id ?? null,
          createdAt,
          createdAt,
        );
      return getKnowledgeMemoryById(Number(result.lastInsertRowid))!;
    },

    getKnowledgeMemoryById,

    getActiveKnowledgeMemory(scope): KnowledgeMemory[] {
      const normalized = validateContextMonitorUpsert({
        ...scope,
        compaction_state: 'idle',
        active_turn_count: 0,
        active_token_estimate: 0,
        compaction_score: 0,
      });
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_memory
           WHERE ${SCOPE_WHERE} AND superseded_by_id IS NULL
           ORDER BY last_accessed_at DESC`,
        )
        .all(...Object.values(normalized)) as KnowledgeMemory[];
      return rows.map(rowToKnowledgeMemory);
    },

    touchKnowledgeMemory(id: number): void {
      db.prepare(
        `UPDATE knowledge_memory
         SET last_accessed_at = ?, access_count = access_count + 1
         WHERE id = ?`,
      ).run(nowSeconds(), id);
    },

    supersedeKnowledgeMemory(oldId: number, newId: number): void {
      db.prepare('UPDATE knowledge_memory SET superseded_by_id = ? WHERE id = ?').run(newId, oldId);
    },

    upsertContextMonitor(input) {
      const scope = validateContextMonitorUpsert(input);
      const updatedAt = nowSeconds();
      db.prepare(
        `INSERT INTO context_monitor
          (tenant_id, system_id, workspace_id, scope_id, compaction_state, last_compaction_at,
           active_turn_count, active_token_estimate, compaction_score, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, system_id, workspace_id, scope_id) DO UPDATE SET
           compaction_state = excluded.compaction_state,
           last_compaction_at = excluded.last_compaction_at,
           active_turn_count = excluded.active_turn_count,
           active_token_estimate = excluded.active_token_estimate,
           compaction_score = excluded.compaction_score,
           updated_at = excluded.updated_at`,
      ).run(
        scope.tenant_id,
        scope.system_id,
        scope.workspace_id,
        scope.scope_id,
        input.compaction_state,
        input.last_compaction_at ?? null,
        input.active_turn_count,
        input.active_token_estimate,
        input.compaction_score,
        updatedAt,
      );

      return getContextMonitor(scope)!;
    },

    getContextMonitor,

    insertCompactionLog(input: NewCompactionLog): CompactionLog {
      const scope = validateNewCompactionLog(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO compaction_log
            (session_id, tenant_id, system_id, workspace_id, scope_id, trigger_type,
             turn_id_start, turn_id_end, turns_compacted, tokens_compacted_estimate,
             working_memory_id, active_turn_count_before, active_turn_count_after,
             duration_ms, model_call_made, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.scope_id,
          input.trigger_type,
          input.turn_id_start,
          input.turn_id_end,
          input.turns_compacted,
          input.tokens_compacted_estimate,
          input.working_memory_id,
          input.active_turn_count_before,
          input.active_turn_count_after,
          input.duration_ms,
          input.model_call_made ? 1 : 0,
          input.error ?? null,
          createdAt,
        );
      return getCompactionLogById(Number(result.lastInsertRowid))!;
    },

    getCompactionLogById,

    getRecentCompactionLogs(scope, limit = 10): CompactionLog[] {
      const normalized = validateContextMonitorUpsert({
        ...scope,
        compaction_state: 'idle',
        active_turn_count: 0,
        active_token_estimate: 0,
        compaction_score: 0,
      });
      const rows = db
        .prepare(
          `SELECT * FROM compaction_log
           WHERE ${SCOPE_WHERE}
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(...Object.values(normalized), limit) as CompactionLogRow[];
      return rows.map(rowToCompactionLog);
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    close(): void {
      db.close();
    },
  };
}
