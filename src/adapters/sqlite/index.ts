import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import type Database from 'better-sqlite3';

import type { EmbeddingAdapter } from '../../contracts/embedding.js';
import { normalizeScope, scopeValues, type ScopeLevel } from '../../contracts/identity.js';
import type { StorageAdapter } from '../../contracts/storage.js';
import type {
  CompactionLog,
  ContextMonitor,
  KnowledgeCandidate,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewCompactionLog,
  NewKnowledgeCandidate,
  NewKnowledgeEvidence,
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
import { matchesKnowledgeSearchOptions } from '../../core/retrieval.js';
import {
  assertArchiveInput,
  nowSeconds,
  validateContextMonitorUpsert,
  validateNewCompactionLog,
  validateNewKnowledgeCandidate,
  validateNewKnowledgeEvidence,
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
  rowToKnowledgeCandidate,
  rowToKnowledgeEvidence,
  rowToKnowledgeMemory,
  rowToKnowledgeMemoryAudit,
  rowToTurn,
  rowToWorkItem,
  rowToWorkingMemory,
  serializeNumberArray,
  serializeStringArray,
  type CompactionLogRow,
  type KnowledgeCandidateRow,
  type KnowledgeEvidenceRow,
  type KnowledgeMemoryAuditRow,
  type KnowledgeMemoryRow,
  type WorkingMemoryRow,
} from './mappers.js';
import { createSQLiteEmbeddingAdapter } from './embeddings.js';
import { createSQLiteSchema } from './schema.js';

const SCOPE_WHERE =
  'tenant_id = ? AND system_id = ? AND workspace_id = ? AND collaboration_id = ? AND scope_id = ?';
const require = createRequire(import.meta.url);

type BetterSqliteConstructor = typeof import('better-sqlite3');

function loadBetterSqlite3(): BetterSqliteConstructor {
  try {
    return require('better-sqlite3') as BetterSqliteConstructor;
  } catch (error) {
    throw new Error(
      'memory-layer: SQLite support requires the optional "better-sqlite3" package. Install it with: npm install better-sqlite3',
      { cause: error },
    );
  }
}

function scopeWhereForLevel(scope: Parameters<typeof normalizeScope>[0], level: ScopeLevel): string {
  const normalized = normalizeScope(scope);
  if (level === 'tenant') return 'tenant_id = ?';
  if (level === 'system') return 'tenant_id = ? AND system_id = ?';
  if (level === 'workspace') {
    return normalized.collaboration_id.length > 0
      ? 'tenant_id = ? AND collaboration_id = ?'
      : 'tenant_id = ? AND system_id = ? AND workspace_id = ?';
  }
  return SCOPE_WHERE;
}

function scopeParamsForLevel(scope: Parameters<typeof normalizeScope>[0], level: ScopeLevel): string[] {
  const normalized = normalizeScope(scope);
  if (level === 'tenant') return [normalized.tenant_id];
  if (level === 'system') return [normalized.tenant_id, normalized.system_id];
  if (level === 'workspace') {
    return normalized.collaboration_id.length > 0
      ? [normalized.tenant_id, normalized.collaboration_id]
      : [normalized.tenant_id, normalized.system_id, normalized.workspace_id];
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

function sessionWhere(sessionId?: string, column = 'session_id'): { clause: string; params: string[] } {
  if (!sessionId) {
    return { clause: '', params: [] };
  }
  return {
    clause: ` AND ${column} = ?`,
    params: [sessionId],
  };
}

type RankedTurnRow = Turn & { raw_rank: number | null };
type RankedKnowledgeRow = KnowledgeMemoryRow & { raw_rank: number | null };

function normalizeRank(rawRank: number | null): number {
  const safe = Number.isFinite(rawRank) ? Math.max(0, Number(rawRank)) : 0;
  return 1 / (1 + safe);
}

function tokenizeSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0);
}

function scoreSearchText(query: string, text: string): number {
  const queryTokens = new Set(tokenizeSearch(query));
  const textTokens = new Set(tokenizeSearch(text));
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) matches += 1;
  }
  if (matches === 0) return 0;
  return matches / queryTokens.size + (text.toLowerCase().includes(query.toLowerCase()) ? 0.25 : 0);
}

function toSafeFtsQuery(query: string): string {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0)
    .join(' ');
}

function resolveSearchOptions(options?: SearchOptions): Required<SearchOptions> {
  return {
    limit: options?.limit ?? 10,
    activeOnly: options?.activeOnly ?? true,
    includeProvisional: options?.includeProvisional ?? false,
    includeDisputed: options?.includeDisputed ?? false,
    minimumTrustScore: options?.minimumTrustScore ?? 0,
    knowledgeStates: options?.knowledgeStates ?? [],
    knowledgeClasses: options?.knowledgeClasses ?? [],
    preferLocalTrusted: options?.preferLocalTrusted ?? false,
    preferLineageMemory: options?.preferLineageMemory ?? false,
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

  const BetterSqlite3 = loadBetterSqlite3();
  const db = new BetterSqlite3(dbPath);
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

  function getKnowledgeCandidateById(id: number): KnowledgeCandidate | null {
    const row = db
      .prepare('SELECT * FROM knowledge_candidate WHERE id = ?')
      .get(id) as KnowledgeCandidateRow | undefined;
    return row ? rowToKnowledgeCandidate(row) : null;
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

  function getKnowledgeMemoryAuditsForKnowledge(
    scope: Parameters<StorageAdapter['getKnowledgeMemoryAuditsForKnowledge']>[0],
    knowledgeId: number,
    limit = 10,
  ): KnowledgeMemoryAudit[] {
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_memory_audit
         WHERE ${SCOPE_WHERE}
           AND (created_knowledge_id = ? OR related_knowledge_id = ?)
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...scopeValues(scope), knowledgeId, knowledgeId, limit) as KnowledgeMemoryAuditRow[];
    return rows.map(rowToKnowledgeMemoryAudit);
  }

  function insertValidatedTurn(input: NewTurn): Turn {
    const scope = validateNewTurn(input);
    const tokenEstimate = input.token_estimate ?? estimateTokens(input.content);
    const createdAt = input.created_at ?? nowSeconds();
    const result = db
      .prepare(
        `INSERT INTO turns
          (session_id, tenant_id, system_id, workspace_id, collaboration_id, scope_id, actor, role, content, priority, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.session_id,
        scope.tenant_id,
        scope.system_id,
        scope.workspace_id,
        scope.collaboration_id,
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
          (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type, knowledge_state,
           knowledge_class, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key,
           is_negated, source, confidence, confidence_score, grounding_strength, evidence_count,
           trust_score, verification_status, verification_notes, last_verified_at,
           next_reverification_at, last_confirmed_at, confirmation_count,
           source_system_id, source_scope_id, source_collaboration_id, source_working_memory_id,
           source_turn_ids, successful_use_count, failed_use_count, disputed_at, dispute_reason,
           contradiction_score, superseded_at, retired_at, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.tenant_id,
        scope.system_id,
        scope.workspace_id,
        scope.collaboration_id,
        scope.scope_id,
        input.fact,
        input.fact_type,
        input.knowledge_state ?? 'trusted',
        input.knowledge_class ?? 'project_fact',
        input.fact_subject ?? null,
        input.fact_attribute ?? null,
        input.fact_value ?? null,
        input.normalized_fact ?? null,
        input.slot_key ?? null,
        input.is_negated ? 1 : 0,
        input.source,
        input.confidence,
        input.confidence_score ?? 0.5,
        input.grounding_strength ?? 'moderate',
        input.evidence_count ?? Math.max(1, (input.source_turn_ids ?? []).length),
        input.trust_score ?? (input.confidence_score ?? 0.5),
        input.verification_status ?? 'unverified',
        input.verification_notes ?? null,
        input.last_verified_at ?? null,
        input.next_reverification_at ?? null,
        input.last_confirmed_at ?? null,
        input.confirmation_count ?? 0,
        input.source_system_id ?? scope.system_id,
        input.source_scope_id ?? scope.scope_id,
        input.source_collaboration_id ?? scope.collaboration_id,
        input.source_working_memory_id ?? null,
        serializeNumberArray(input.source_turn_ids ?? []),
        input.successful_use_count ?? 0,
        input.failed_use_count ?? 0,
        input.disputed_at ?? null,
        input.dispute_reason ?? null,
        input.contradiction_score ?? 0,
        input.superseded_at ?? null,
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

    getActiveTurns(scope, sessionId): Turn[] {
      const session = sessionWhere(sessionId);
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE ${SCOPE_WHERE} AND archived_at IS NULL${session.clause}
           ORDER BY id ASC`,
        )
        .all(...scopeValues(scope), ...session.params) as Turn[];
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
      const query = `SELECT * FROM turns
           WHERE session_id = ? AND id >= ? AND id <= ? AND archived_at IS NOT NULL
             AND ${SCOPE_WHERE}
           ORDER BY id ASC`;
      const rows = db
        .prepare(query)
        .all(sessionId, startId, endId, ...scopeValues(scope)) as Turn[];
      return rows.map(rowToTurn);
    },

    insertWorkingMemory(input: NewWorkingMemory): WorkingMemory {
      const scope = validateNewWorkingMemory(input);
      const createdAt = nowSeconds();
      const expiresAt = input.expires_at ?? createdAt + 86400;
      const result = db
        .prepare(
          `INSERT INTO working_memory
            (session_id, tenant_id, system_id, workspace_id, collaboration_id, scope_id, summary, key_entities, topic_tags,
             turn_id_start, turn_id_end, turn_count, compaction_trigger, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.collaboration_id,
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
      const query = `SELECT * FROM working_memory
           WHERE session_id = ? AND ${SCOPE_WHERE}
           ORDER BY id ASC`;
      const rows = db
        .prepare(query)
        .all(sessionId, ...scopeValues(scope)) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
    },

    getActiveWorkingMemory(scope, sessionId): WorkingMemory[] {
      const now = nowSeconds();
      const session = sessionWhere(sessionId);
      const rows = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}
             AND (expires_at IS NULL OR expires_at > ?)${session.clause}
           ORDER BY id DESC`,
        )
        .all(...scopeValues(scope), now, ...session.params) as WorkingMemoryRow[];
      return rows.map(rowToWorkingMemory);
    },

    getLatestWorkingMemory(scope, sessionId): WorkingMemory | null {
      const now = nowSeconds();
      const session = sessionWhere(sessionId);
      const row = db
        .prepare(
          `SELECT * FROM working_memory
           WHERE ${SCOPE_WHERE}
             AND (expires_at IS NULL OR expires_at > ?)${session.clause}
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(...scopeValues(scope), now, ...session.params) as WorkingMemoryRow | undefined;
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

    insertKnowledgeCandidate(input): KnowledgeCandidate {
      const scope = validateNewKnowledgeCandidate(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO knowledge_candidate
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, working_memory_id, fact, fact_type,
             knowledge_class, normalized_fact, slot_key, confidence, source_summary, source_turns,
             grounding_strength, evidence_count, trust_score, state, promoted_knowledge_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.collaboration_id,
          scope.scope_id,
          input.working_memory_id,
          input.fact,
          input.fact_type,
          input.knowledge_class,
          input.normalized_fact,
          input.slot_key ?? null,
          input.confidence,
          input.source_summary ? 1 : 0,
          input.source_turns === false ? 0 : 1,
          input.grounding_strength ?? 'weak',
          input.evidence_count ?? 0,
          input.trust_score ?? 0,
          input.state ?? 'candidate',
          input.promoted_knowledge_id ?? null,
          createdAt,
        );
      return getKnowledgeCandidateById(Number(result.lastInsertRowid))!;
    },

    insertKnowledgeCandidates(inputs): KnowledgeCandidate[] {
      return db.transaction(() => inputs.map((input) => this.insertKnowledgeCandidate(input)))();
    },

    getKnowledgeCandidateById,

    listKnowledgeCandidates(scope, options): KnowledgeCandidate[] {
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_candidate
           WHERE ${SCOPE_WHERE}
           ORDER BY created_at DESC, id DESC`,
        )
        .all(...scopeValues(scope)) as KnowledgeCandidateRow[];
      return rows
        .map(rowToKnowledgeCandidate)
        .filter((item) => !options?.state || options.state.includes(item.state));
    },

    insertKnowledgeEvidence(input): KnowledgeEvidence {
      const scope = validateNewKnowledgeEvidence(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO knowledge_evidence
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, knowledge_memory_id, knowledge_candidate_id,
             working_memory_id, turn_id, source_type, support_polarity, speaker_role, actor, excerpt,
             start_offset, end_offset, is_explicit, explicitness_score, outcome, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.collaboration_id,
          scope.scope_id,
          input.knowledge_memory_id ?? null,
          input.knowledge_candidate_id ?? null,
          input.working_memory_id ?? null,
          input.turn_id ?? null,
          input.source_type,
          input.support_polarity,
          input.speaker_role ?? null,
          input.actor ?? null,
          input.excerpt,
          input.start_offset ?? null,
          input.end_offset ?? null,
          input.is_explicit ? 1 : 0,
          input.explicitness_score ?? 0,
          input.outcome ?? null,
          createdAt,
        );
      const row = db
        .prepare('SELECT * FROM knowledge_evidence WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as KnowledgeEvidenceRow | undefined;
      return rowToKnowledgeEvidence(row!);
    },

    insertKnowledgeEvidenceBatch(inputs): KnowledgeEvidence[] {
      return db.transaction(() => inputs.map((input) => this.insertKnowledgeEvidence(input)))();
    },

    listKnowledgeEvidenceForKnowledge(knowledgeId): KnowledgeEvidence[] {
      const rows = db
        .prepare(
          'SELECT * FROM knowledge_evidence WHERE knowledge_memory_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(knowledgeId) as KnowledgeEvidenceRow[];
      return rows.map(rowToKnowledgeEvidence);
    },

    listKnowledgeEvidenceForCandidate(candidateId): KnowledgeEvidence[] {
      const rows = db
        .prepare(
          'SELECT * FROM knowledge_evidence WHERE knowledge_candidate_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(candidateId) as KnowledgeEvidenceRow[];
      return rows.map(rowToKnowledgeEvidence);
    },

    promoteKnowledgeCandidate(candidateId, input): KnowledgeMemory {
      const knowledge = insertValidatedKnowledgeMemory(input);
      db.prepare(
        'UPDATE knowledge_candidate SET promoted_knowledge_id = ?, state = ? WHERE id = ?',
      ).run(knowledge.id, 'provisional', candidateId);
      return knowledge;
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
           WHERE ${scopeWhereForLevel(scope, level)} AND superseded_by_id IS NULL AND retired_at IS NULL
           ORDER BY last_accessed_at DESC`,
        )
        .all(...scopeParamsForLevel(scope, level)) as KnowledgeMemoryRow[];
      return rows.map(rowToKnowledgeMemory);
    },

    getKnowledgeSince(scope, level, since): KnowledgeMemory[] {
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_memory
           WHERE ${scopeWhereForLevel(scope, level)}
             AND created_at >= ?
             AND superseded_by_id IS NULL
             AND retired_at IS NULL
           ORDER BY created_at ASC, id ASC`,
        )
        .all(...scopeParamsForLevel(scope, level), since) as KnowledgeMemoryRow[];
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
        const statement = db.prepare(
          `SELECT knowledge_memory.*, bm25(knowledge_memory_fts) AS raw_rank
           FROM knowledge_memory_fts
           JOIN knowledge_memory ON knowledge_memory_fts.rowid = knowledge_memory.id
           WHERE knowledge_memory_fts MATCH ?
             AND ${SCOPE_WHERE}
             AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))
           ORDER BY bm25(knowledge_memory_fts)
           LIMIT ?`,
        );
        let rows = statement.all(
          query,
          ...scopeValues(scope),
          resolved.activeOnly ? 1 : 0,
          resolved.limit,
        ) as RankedKnowledgeRow[];
        const safeQuery = toSafeFtsQuery(query);
        if (rows.length === 0 && safeQuery.length > 0 && safeQuery !== query && !/["']/.test(query)) {
          rows = statement.all(
            safeQuery,
            ...scopeValues(scope),
            resolved.activeOnly ? 1 : 0,
            resolved.limit,
          ) as RankedKnowledgeRow[];
        }
        let results = rows
          .map((row) => ({
            item: rowToKnowledgeMemory(row),
            rank: normalizeRank(row.raw_rank),
          }))
          .filter((result) => matchesKnowledgeSearchOptions(result.item, resolved))
          .slice(0, resolved.limit);
        if (results.length === 0 && !/["']/.test(query)) {
          const fallbackRows = db
            .prepare(
              `SELECT knowledge_memory.*
               FROM knowledge_memory
               WHERE ${SCOPE_WHERE}
                 AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))`,
            )
            .all(...scopeValues(scope), resolved.activeOnly ? 1 : 0) as KnowledgeMemoryRow[];
          results = fallbackRows
            .map((row) => {
              const item = rowToKnowledgeMemory(row);
              return {
                item,
                rank: scoreSearchText(query, item.fact),
              };
            })
            .filter((result) => result.rank > 0 && matchesKnowledgeSearchOptions(result.item, resolved))
            .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
            .slice(0, resolved.limit);
        }
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'knowledge',
          query,
          resultCount: results.length,
        });
        return results;
      } catch {
        if (!/["']/.test(query)) {
          const fallbackRows = db
            .prepare(
              `SELECT knowledge_memory.*
               FROM knowledge_memory
               WHERE ${SCOPE_WHERE}
                 AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))`,
            )
            .all(...scopeValues(scope), resolved.activeOnly ? 1 : 0) as KnowledgeMemoryRow[];
          const fallbackResults = fallbackRows
            .map((row) => {
              const item = rowToKnowledgeMemory(row);
              return {
                item,
                rank: scoreSearchText(query, item.fact),
              };
            })
            .filter((result) => result.rank > 0 && matchesKnowledgeSearchOptions(result.item, resolved))
            .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
            .slice(0, resolved.limit);
          emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
            entity: 'knowledge',
            query,
            resultCount: fallbackResults.length,
            fallbackQuery: true,
          });
          return fallbackResults;
        }
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
        const statement = db.prepare(
          `SELECT knowledge_memory.*, bm25(knowledge_memory_fts) AS raw_rank
           FROM knowledge_memory_fts
           JOIN knowledge_memory ON knowledge_memory_fts.rowid = knowledge_memory.id
           WHERE knowledge_memory_fts MATCH ?
             AND ${scopeWhereForLevel(scope, level)}
             AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))
           ORDER BY bm25(knowledge_memory_fts)
           LIMIT ?`,
        );
        let rows = statement.all(
          query,
          ...scopeParamsForLevel(scope, level),
          resolved.activeOnly ? 1 : 0,
          resolved.limit,
        ) as RankedKnowledgeRow[];
        const safeQuery = toSafeFtsQuery(query);
        if (rows.length === 0 && safeQuery.length > 0 && safeQuery !== query && !/["']/.test(query)) {
          rows = statement.all(
            safeQuery,
            ...scopeParamsForLevel(scope, level),
            resolved.activeOnly ? 1 : 0,
            resolved.limit,
          ) as RankedKnowledgeRow[];
        }
        let results = rows
          .map((row) => ({
            item: rowToKnowledgeMemory(row),
            rank: normalizeRank(row.raw_rank),
          }))
          .filter((result) => matchesKnowledgeSearchOptions(result.item, resolved))
          .slice(0, resolved.limit);
        if (results.length === 0 && !/["']/.test(query)) {
          const fallbackRows = db
            .prepare(
              `SELECT knowledge_memory.*
               FROM knowledge_memory
               WHERE ${scopeWhereForLevel(scope, level)}
                 AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))`,
            )
            .all(...scopeParamsForLevel(scope, level), resolved.activeOnly ? 1 : 0) as KnowledgeMemoryRow[];
          results = fallbackRows
            .map((row) => {
              const item = rowToKnowledgeMemory(row);
              return {
                item,
                rank: scoreSearchText(query, item.fact),
              };
            })
            .filter((result) => result.rank > 0 && matchesKnowledgeSearchOptions(result.item, resolved))
            .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
            .slice(0, resolved.limit);
        }
        emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
          entity: 'knowledge',
          query,
          resultCount: results.length,
          scopeLevel: level,
        });
        return results;
      } catch {
        if (!/["']/.test(query)) {
          const fallbackRows = db
            .prepare(
              `SELECT knowledge_memory.*
               FROM knowledge_memory
               WHERE ${scopeWhereForLevel(scope, level)}
                 AND (? = 0 OR (knowledge_memory.superseded_by_id IS NULL AND knowledge_memory.retired_at IS NULL))`,
            )
            .all(...scopeParamsForLevel(scope, level), resolved.activeOnly ? 1 : 0) as KnowledgeMemoryRow[];
          const fallbackResults = fallbackRows
            .map((row) => {
              const item = rowToKnowledgeMemory(row);
              return {
                item,
                rank: scoreSearchText(query, item.fact),
              };
            })
            .filter((result) => result.rank > 0 && matchesKnowledgeSearchOptions(result.item, resolved))
            .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
            .slice(0, resolved.limit);
          emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
            entity: 'knowledge',
            query,
            resultCount: fallbackResults.length,
            scopeLevel: level,
            fallbackQuery: true,
          });
          return fallbackResults;
        }
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
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, working_memory_id, fact, fact_type,
             fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated,
             confidence, confidence_score, verification_status, source_text, decision,
             created_knowledge_id, related_knowledge_id, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.collaboration_id,
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

    getKnowledgeMemoryAuditsForKnowledge,

    updateKnowledgeMemory(id, patch): KnowledgeMemory | null {
      const assignments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.knowledge_state !== undefined) push('knowledge_state', patch.knowledge_state);
      if (patch.knowledge_class !== undefined) push('knowledge_class', patch.knowledge_class);
      if (patch.trust_score !== undefined) push('trust_score', patch.trust_score);
      if (patch.verification_status !== undefined) push('verification_status', patch.verification_status);
      if (patch.verification_notes !== undefined) push('verification_notes', patch.verification_notes);
      if (patch.last_verified_at !== undefined) push('last_verified_at', patch.last_verified_at);
      if (patch.next_reverification_at !== undefined) {
        push('next_reverification_at', patch.next_reverification_at);
      }
      if (patch.last_confirmed_at !== undefined) push('last_confirmed_at', patch.last_confirmed_at);
      if (patch.confirmation_count !== undefined) push('confirmation_count', patch.confirmation_count);
      if (patch.disputed_at !== undefined) push('disputed_at', patch.disputed_at);
      if (patch.dispute_reason !== undefined) push('dispute_reason', patch.dispute_reason);
      if (patch.contradiction_score !== undefined) push('contradiction_score', patch.contradiction_score);
      if (patch.superseded_at !== undefined) push('superseded_at', patch.superseded_at);
      if (patch.successful_use_count !== undefined) push('successful_use_count', patch.successful_use_count);
      if (patch.failed_use_count !== undefined) push('failed_use_count', patch.failed_use_count);
      if (assignments.length === 0) {
        return getKnowledgeMemoryById(id);
      }
      db.prepare(`UPDATE knowledge_memory SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
      return getKnowledgeMemoryById(id);
    },

    insertWorkItem(input: NewWorkItem): WorkItem {
      const scope = validateNewWorkItem(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO work_items
            (session_id, tenant_id, system_id, workspace_id, collaboration_id, scope_id, kind, title, detail, status,
             source_working_memory_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id ?? null,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.collaboration_id,
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
      db.prepare(
        `UPDATE knowledge_memory
         SET superseded_by_id = ?, superseded_at = ?, knowledge_state = 'superseded'
         WHERE id = ?`,
      ).run(newId, nowSeconds(), oldId);
    },

    upsertContextMonitor(input) {
      const scope = validateContextMonitorUpsert(input);
      const updatedAt = nowSeconds();
      db.prepare(
        `INSERT INTO context_monitor
          (tenant_id, system_id, workspace_id, collaboration_id, scope_id, compaction_state, last_compaction_at,
           active_turn_count, active_token_estimate, compaction_score, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, system_id, workspace_id, collaboration_id, scope_id) DO UPDATE SET
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
        scope.collaboration_id,
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
            (session_id, tenant_id, system_id, workspace_id, collaboration_id, scope_id, trigger_type,
             turn_id_start, turn_id_end, turns_compacted, tokens_compacted_estimate,
             working_memory_id, active_turn_count_before, active_turn_count_after,
             duration_ms, model_call_made, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id,
          scope.tenant_id,
          scope.system_id,
          scope.workspace_id,
          scope.collaboration_id,
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
