import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import type { EmbeddingAdapter } from '../../contracts/embedding.js';
import { normalizeScope, scopeValues, type ScopeLevel } from '../../contracts/identity.js';
import type { StorageAdapter } from '../../contracts/storage.js';
import type {
  CompactionLog,
  ContextMonitor,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewCompactionLog,
  NewKnowledgeMemoryAudit,
  NewKnowledgeMemory,
  NewWorkItem,
  NewTurn,
  NewWorkingMemory,
  PaginationOptions,
  PaginatedResult,
  SearchOptions,
  SearchResult,
  TimeRange,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';
import { estimateTokens } from '../../core/tokens.js';
import { emitMemoryEvent, type TelemetryOptions } from '../../core/telemetry.js';
import {
  assertArchiveInput,
  nowSeconds,
  validateContextMonitorUpsert,
  validateNewCompactionLog,
  validateNewKnowledgeMemoryAudit,
  validateNewKnowledgeMemory,
  validateNewWorkItem,
  validateTimeRange,
  validateNewTurn,
  validateNewWorkingMemory,
} from '../../core/validation.js';
import {
  rowToCompactionLog,
  rowToContextMonitor,
  rowToKnowledgeMemory,
  rowToKnowledgeMemoryAudit,
  rowToTurn,
  rowToWorkItem,
  rowToWorkingMemory,
  serializeNumberArray,
  serializeStringArray,
  type CompactionLogRow,
  type KnowledgeMemoryAuditRow,
  type KnowledgeMemoryRow,
  type WorkingMemoryRow,
} from './mappers.js';
import { createSQLiteEmbeddingAdapter } from './embeddings.js';
import { createSQLiteSchema } from './schema.js';

const SCOPE_WHERE = 'tenant_id = ? AND system_id = ? AND workspace_id = ? AND scope_id = ?';

function scopeWhereForLevel(level: ScopeLevel): string {
  if (level === 'tenant') return 'tenant_id = ?';
  if (level === 'system') return 'tenant_id = ? AND system_id = ?';
  if (level === 'workspace') return 'tenant_id = ? AND system_id = ? AND workspace_id = ?';
  return SCOPE_WHERE;
}

function scopeParamsForLevel(scope: Parameters<typeof normalizeScope>[0], level: ScopeLevel): string[] {
  const normalized = normalizeScope(scope);
  if (level === 'tenant') return [normalized.tenant_id];
  if (level === 'system') return [normalized.tenant_id, normalized.system_id];
  if (level === 'workspace') {
    return [normalized.tenant_id, normalized.system_id, normalized.workspace_id];
  }
  return [...scopeValues(normalized)];
}

function timeRangeWhere(range: TimeRange, column = 'created_at'): { clause: string; params: number[] } {
  validateTimeRange(range);
  const clauses: string[] = [];
  const params: number[] = [];
  if (range.start_at !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(range.start_at);
  }
  if (range.end_at !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(range.end_at);
  }
  return {
    clause: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

type RankedTurnRow = Turn & { raw_rank: number | null };
type RankedKnowledgeRow = KnowledgeMemoryRow & { raw_rank: number | null };

function normalizeRank(rawRank: number | null): number {
  const safe = Number.isFinite(rawRank) ? Math.max(0, Number(rawRank)) : 0;
  return 1 / (1 + safe);
}

function resolveSearchOptions(options?: SearchOptions): Required<SearchOptions> {
  return {
    limit: options?.limit ?? 10,
    activeOnly: options?.activeOnly ?? true,
  };
}

function resolvePaginationOptions(options?: PaginationOptions): Required<PaginationOptions> {
  return {
    limit: options?.limit ?? 25,
    offset: options?.offset ?? 0,
    cursor: options?.cursor ?? 0,
  };
}

export function createSQLiteAdapter(
  dbPath: string | ':memory:',
  telemetry?: TelemetryOptions,
): StorageAdapter {
  const db = openSQLiteDatabase(dbPath);
  return createAdapterFromDatabase(db, telemetry);
}

export function createSQLiteAdapterWithEmbeddings(
  dbPath: string | ':memory:',
  telemetry?: TelemetryOptions,
): StorageAdapter & { embeddings: EmbeddingAdapter } {
  const db = openSQLiteDatabase(dbPath);
  const adapter = createAdapterFromDatabase(db, telemetry);
  const embeddings = createSQLiteEmbeddingAdapter(db, telemetry?.logger);
  return Object.assign(adapter, { embeddings });
}

function openSQLiteDatabase(dbPath: string | ':memory:'): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  createSQLiteSchema(db);
  return db;
}

function createAdapterFromDatabase(
  db: Database.Database,
  telemetry?: TelemetryOptions,
): StorageAdapter {

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
      .get(id) as KnowledgeMemoryRow | undefined;
    return row ? rowToKnowledgeMemory(row) : null;
  }

  function getContextMonitor(scope: Parameters<StorageAdapter['getContextMonitor']>[0]): ContextMonitor | null {
    const row = db
      .prepare(`SELECT * FROM context_monitor WHERE ${SCOPE_WHERE}`)
      .get(...scopeValues(scope)) as ContextMonitor | undefined;
    return row ? rowToContextMonitor(row) : null;
  }

  function getCompactionLogById(id: number): CompactionLog | null {
    const row = db
      .prepare('SELECT * FROM compaction_log WHERE id = ?')
      .get(id) as CompactionLogRow | undefined;
    return row ? rowToCompactionLog(row) : null;
  }

  function getRecentKnowledgeMemoryAudits(
    scope: Parameters<StorageAdapter['getRecentKnowledgeMemoryAudits']>[0],
    limit = 10,
  ): KnowledgeMemoryAudit[] {
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_memory_audit
         WHERE ${SCOPE_WHERE}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...scopeValues(scope), limit) as KnowledgeMemoryAuditRow[];
    return rows.map(rowToKnowledgeMemoryAudit);
  }

  function insertValidatedTurn(input: NewTurn): Turn {
    const scope = validateNewTurn(input);
    const tokenEstimate = input.token_estimate ?? estimateTokens(input.content);
    const createdAt = input.created_at ?? nowSeconds();
    const result = db
      .prepare(
        `INSERT INTO turns
          (session_id, tenant_id, system_id, workspace_id, scope_id, actor, role, content, priority, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.priority ?? (input.role === 'system' ? 1.5 : 1),
        tokenEstimate,
        createdAt,
      );

    return getTurnById(Number(result.lastInsertRowid))!;
  }

  function insertValidatedKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory {
    const scope = validateNewKnowledgeMemory(input);
    const createdAt = nowSeconds();
    const result = db
      .prepare(
        `INSERT INTO knowledge_memory
          (tenant_id, system_id, workspace_id, scope_id, fact, fact_type, fact_subject,
           fact_attribute, fact_value, normalized_fact, slot_key, is_negated, source, confidence,
           confidence_score, verification_status, verification_notes, source_working_memory_id,
           source_turn_ids, retired_at, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.tenant_id,
        scope.system_id,
        scope.workspace_id,
        scope.scope_id,
        input.fact,
        input.fact_type,
        input.fact_subject ?? null,
        input.fact_attribute ?? null,
        input.fact_value ?? null,
        input.normalized_fact ?? null,
        input.slot_key ?? null,
        input.is_negated ? 1 : 0,
        input.source,
        input.confidence,
        input.confidence_score ?? 0.5,
        input.verification_status ?? 'unverified',
        input.verification_notes ?? null,
        input.source_working_memory_id ?? null,
        serializeNumberArray(input.source_turn_ids ?? []),
        input.retired_at ?? null,
        createdAt,
        createdAt,
      );
    return getKnowledgeMemoryById(Number(result.lastInsertRowid))!;
  }

  return {
    insertTurn(input: NewTurn): Turn {
      return insertValidatedTurn(input);
    },

    insertTurns(inputs): Turn[] {
      return db.transaction(() => inputs.map((input) => insertValidatedTurn(input)))();
    },

    getTurnById,

    getActiveTurns(scope): Turn[] {
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE ${SCOPE_WHERE} AND archived_at IS NULL
           ORDER BY id ASC`,
        )
        .all(...scopeValues(scope)) as Turn[];
      return rows.map(rowToTurn);
    },

    getActiveTurnsPaginated(scope, options): PaginatedResult<Turn> {
      const resolved = resolvePaginationOptions(options);
      const cursorClause = resolved.cursor > 0 ? ' AND id > ?' : '';
      const offsetClause = resolved.cursor > 0 ? '' : ' OFFSET ?';
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE ${SCOPE_WHERE} AND archived_at IS NULL${cursorClause}
           ORDER BY id ASC
           LIMIT ?${offsetClause}`,
        )
        .all(
          ...scopeValues(scope),
          ...(resolved.cursor > 0 ? [resolved.cursor] : []),
          resolved.limit + 1,
          ...(resolved.cursor > 0 ? [] : [resolved.offset]),
        ) as Turn[];
      const pageRows = rows.slice(0, resolved.limit).map(rowToTurn);
      return {
        items: pageRows,
        hasMore: rows.length > resolved.limit,
        nextCursor: rows.length > resolved.limit ? pageRows[pageRows.length - 1]?.id ?? null : null,
      };
    },

    getTurnsByTimeRange(scope, range): Turn[] {
      const time = timeRangeWhere(range, 'created_at');
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE ${SCOPE_WHERE}${time.clause}
           ORDER BY created_at ASC`,
        )
        .all(...scopeValues(scope), ...time.params) as Turn[];
      return rows.map(rowToTurn);
    },

    searchTurns(scope, query, options): SearchResult<Turn>[] {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      try {
        const rows = db
          .prepare(
            `SELECT turns.*, bm25(turns_fts) AS raw_rank
             FROM turns_fts
             JOIN turns ON turns_fts.rowid = turns.id
             WHERE turns_fts MATCH ?
               AND ${SCOPE_WHERE}
               AND (? = 0 OR turns.archived_at IS NULL)
             ORDER BY bm25(turns_fts)
             LIMIT ?`,
          )
          .all(query, ...scopeValues(scope), resolved.activeOnly ? 1 : 0, resolved.limit) as RankedTurnRow[];
        const results = rows.map((row) => ({
          item: rowToTurn(row),
          rank: normalizeRank(row.raw_rank),
        }));
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'turns',
          query,
          resultCount: results.length,
        });
        return results;
      } catch {
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'turns',
          query,
          resultCount: 0,
          invalidQuery: true,
        });
        return [];
      }
    },

    archiveTurn(id: number, archivedAt: number, compactionLogId: number): void {
      assertArchiveInput(id, archivedAt, compactionLogId);
      db.prepare(
        `UPDATE turns
         SET archived_at = ?, compaction_log_id = ?
         WHERE id = ? AND archived_at IS NULL`,
      ).run(archivedAt, compactionLogId, id);
    },

    getArchivedTurnRange(sessionId: string, startId: number, endId: number, scope): Turn[] {
      const query = scope
        ? `SELECT * FROM turns
           WHERE session_id = ? AND id >= ? AND id <= ? AND archived_at IS NOT NULL
             AND ${SCOPE_WHERE}
           ORDER BY id ASC`
        : `SELECT * FROM turns
           WHERE session_id = ? AND id >= ? AND id <= ? AND archived_at IS NOT NULL
           ORDER BY id ASC`;
      const rows = db
        .prepare(query)
        .all(
          sessionId,
          startId,
          endId,
          ...(scope ? scopeValues(scope) : []),
        ) as Turn[];
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

    getWorkingMemoryBySession(sessionId: string, scope): WorkingMemory[] {
      const query = scope
        ? `SELECT * FROM working_memory
           WHERE session_id = ? AND ${SCOPE_WHERE}
           ORDER BY id ASC`
        : 'SELECT * FROM working_memory WHERE session_id = ? ORDER BY id ASC';
      const rows = db
        .prepare(query)
        .all(sessionId, ...(scope ? scopeValues(scope) : [])) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
    },

    getActiveWorkingMemory(scope): WorkingMemory[] {
      const now = nowSeconds();
      const rows = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY id DESC`,
        )
        .all(...scopeValues(scope), now) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
    },

    getLatestWorkingMemory(scope): WorkingMemory | null {
      const now = nowSeconds();
      const row = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(...scopeValues(scope), now) as WorkingMemoryRow | undefined;
      return row ? rowToWorkingMemory(row) : null;
    },

    getWorkingMemoryByTimeRange(scope, range): WorkingMemory[] {
      const time = timeRangeWhere(range, 'created_at');
      const rows = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}${time.clause}
           ORDER BY created_at ASC`,
        )
        .all(...scopeValues(scope), ...time.params) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
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
      return insertValidatedKnowledgeMemory(input);
    },

    insertKnowledgeMemories(inputs): KnowledgeMemory[] {
      return db.transaction(() => inputs.map((input) => insertValidatedKnowledgeMemory(input)))();
    },

    getKnowledgeMemoryById,

    getActiveKnowledgeMemory(scope): KnowledgeMemory[] {
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_memory
           WHERE ${SCOPE_WHERE} AND superseded_by_id IS NULL AND retired_at IS NULL
           ORDER BY last_accessed_at DESC`,
        )
        .all(...scopeValues(scope)) as KnowledgeMemoryRow[];
      return rows.map(rowToKnowledgeMemory);
    },

    getActiveKnowledgeMemoryPaginated(scope, options): PaginatedResult<KnowledgeMemory> {
      const resolved = resolvePaginationOptions(options);
      const cursorClause = resolved.cursor > 0 ? ' AND id > ?' : '';
      const offsetClause = resolved.cursor > 0 ? '' : ' OFFSET ?';
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_memory
           WHERE ${SCOPE_WHERE} AND superseded_by_id IS NULL AND retired_at IS NULL${cursorClause}
           ORDER BY id ASC
           LIMIT ?${offsetClause}`,
        )
        .all(
          ...scopeValues(scope),
          ...(resolved.cursor > 0 ? [resolved.cursor] : []),
          resolved.limit + 1,
          ...(resolved.cursor > 0 ? [] : [resolved.offset]),
        ) as KnowledgeMemoryRow[];
      const pageRows = rows.slice(0, resolved.limit).map(rowToKnowledgeMemory);
      return {
        items: pageRows,
        hasMore: rows.length > resolved.limit,
        nextCursor: rows.length > resolved.limit ? pageRows[pageRows.length - 1]?.id ?? null : null,
      };
    },

    getActiveKnowledgeCrossScope(scope, level): KnowledgeMemory[] {
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_memory
           WHERE ${scopeWhereForLevel(level)} AND superseded_by_id IS NULL AND retired_at IS NULL
           ORDER BY last_accessed_at DESC`,
        )
        .all(...scopeParamsForLevel(scope, level)) as KnowledgeMemoryRow[];
      return rows.map(rowToKnowledgeMemory);
    },

    getKnowledgeByTimeRange(scope, range): KnowledgeMemory[] {
      const time = timeRangeWhere(range, 'created_at');
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_memory
           WHERE ${SCOPE_WHERE}${time.clause}
           ORDER BY created_at ASC`,
        )
        .all(...scopeValues(scope), ...time.params) as KnowledgeMemoryRow[];
      return rows.map(rowToKnowledgeMemory);
    },

    searchKnowledge(scope, query, options): SearchResult<KnowledgeMemory>[] {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      try {
        const rows = db
          .prepare(
            `SELECT knowledge_memory.*, bm25(knowledge_memory_fts) AS raw_rank
             FROM knowledge_memory_fts
             JOIN knowledge_memory ON knowledge_memory_fts.rowid = knowledge_memory.id
             WHERE knowledge_memory_fts MATCH ?
               AND ${SCOPE_WHERE}
               AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))
             ORDER BY bm25(knowledge_memory_fts)
             LIMIT ?`,
          )
          .all(query, ...scopeValues(scope), resolved.activeOnly ? 1 : 0, resolved.limit) as RankedKnowledgeRow[];
        const results = rows.map((row) => ({
          item: rowToKnowledgeMemory(row),
          rank: normalizeRank(row.raw_rank),
        }));
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'knowledge',
          query,
          resultCount: results.length,
        });
        return results;
      } catch {
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'knowledge',
          query,
          resultCount: 0,
          invalidQuery: true,
        });
        return [];
      }
    },

    searchKnowledgeCrossScope(scope, level, query, options): SearchResult<KnowledgeMemory>[] {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      try {
        const rows = db
          .prepare(
            `SELECT knowledge_memory.*, bm25(knowledge_memory_fts) AS raw_rank
             FROM knowledge_memory_fts
             JOIN knowledge_memory ON knowledge_memory_fts.rowid = knowledge_memory.id
             WHERE knowledge_memory_fts MATCH ?
               AND ${scopeWhereForLevel(level)}
               AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))
             ORDER BY bm25(knowledge_memory_fts)
             LIMIT ?`,
          )
          .all(
            query,
            ...scopeParamsForLevel(scope, level),
            resolved.activeOnly ? 1 : 0,
            resolved.limit,
          ) as RankedKnowledgeRow[];
        const results = rows.map((row) => ({
          item: rowToKnowledgeMemory(row),
          rank: normalizeRank(row.raw_rank),
        }));
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'knowledge',
          query,
          resultCount: results.length,
          scopeLevel: level,
        });
        return results;
      } catch {
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'knowledge',
          query,
          resultCount: 0,
          invalidQuery: true,
          scopeLevel: level,
        });
        return [];
      }
    },

    insertKnowledgeMemoryAudit(input: NewKnowledgeMemoryAudit): KnowledgeMemoryAudit {
      const scope = validateNewKnowledgeMemoryAudit(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO knowledge_memory_audit
            (tenant_id, system_id, workspace_id, scope_id, working_memory_id, fact, fact_type,
             fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated,
             confidence, confidence_score, verification_status, source_text, decision,
             created_knowledge_id, related_knowledge_id, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.scope_id,
          input.working_memory_id ?? null,
          input.fact,
          input.fact_type,
          input.fact_subject ?? null,
          input.fact_attribute ?? null,
          input.fact_value ?? null,
          input.normalized_fact ?? null,
          input.slot_key ?? null,
          input.is_negated ? 1 : 0,
          input.confidence,
          input.confidence_score ?? 0.5,
          input.verification_status ?? 'unverified',
          input.source_text ?? null,
          input.decision,
          input.created_knowledge_id ?? null,
          input.related_knowledge_id ?? null,
          input.detail ?? null,
          createdAt,
        );
      const row = db
        .prepare('SELECT * FROM knowledge_memory_audit WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as KnowledgeMemoryAuditRow;
      return rowToKnowledgeMemoryAudit(row);
    },

    getRecentKnowledgeMemoryAudits,

    insertWorkItem(input: NewWorkItem): WorkItem {
      const scope = validateNewWorkItem(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO work_items
            (session_id, tenant_id, system_id, workspace_id, scope_id, kind, title, detail, status,
             source_working_memory_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id ?? null,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.scope_id,
          input.kind,
          input.title,
          input.detail ?? null,
          input.status ?? 'open',
          input.source_working_memory_id ?? null,
          createdAt,
          createdAt,
        );
      const row = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as WorkItem;
      return rowToWorkItem(row);
    },

    getActiveWorkItems(scope): WorkItem[] {
      const rows = db
        .prepare(
          `SELECT * FROM work_items
           WHERE ${SCOPE_WHERE} AND status != 'done'
           ORDER BY updated_at DESC`,
        )
        .all(...scopeValues(scope)) as WorkItem[];
      return rows.map(rowToWorkItem);
    },

    getWorkItemsByTimeRange(scope, range): WorkItem[] {
      const time = timeRangeWhere(range, 'created_at');
      const rows = db
        .prepare(
          `SELECT * FROM work_items
           WHERE ${SCOPE_WHERE}${time.clause}
           ORDER BY created_at ASC`,
        )
        .all(...scopeValues(scope), ...time.params) as WorkItem[];
      return rows.map(rowToWorkItem);
    },

    updateWorkItemStatus(id, status): void {
      db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        nowSeconds(),
        id,
      );
    },

    deleteWorkItem(id): void {
      db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
    },

    touchKnowledgeMemory(id: number): void {
      db.prepare(
        `UPDATE knowledge_memory
         SET last_accessed_at = ?, access_count = access_count + 1
         WHERE id = ?`,
      ).run(nowSeconds(), id);
    },

    retireKnowledgeMemory(id: number, retiredAt = nowSeconds()): void {
      db.prepare('UPDATE knowledge_memory SET retired_at = ? WHERE id = ?').run(retiredAt, id);
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
      const rows = db
        .prepare(
          `SELECT * FROM compaction_log
           WHERE ${SCOPE_WHERE}
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(...scopeValues(scope), limit) as CompactionLogRow[];
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
