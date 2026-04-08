import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import type Database from 'better-sqlite3';

import type { EmbeddingAdapter } from '../../contracts/embedding.js';
import {
  normalizeScope,
  scopeValues as baseScopeValues,
  type ScopeLevel,
} from '../../contracts/identity.js';
import type {
  ActorRef,
  HandoffQuery,
  HandoffRecord,
  NewHandoffInput,
  NewWorkClaimInput,
  WorkClaim,
  WorkClaimQuery,
  WorkItemPatch,
} from '../../contracts/coordination.js';
import type { StorageAdapter } from '../../contracts/storage.js';
import { UniqueConstraintError } from '../../contracts/storage.js';
import { ConflictError } from '../../contracts/errors.js';
import type {
  MemoryEventEntityKind,
  MemoryEventQuery,
  MemoryEventRecord,
  NewMemoryEventRecord,
  NewSessionStateProjection,
  NewTemporalProjectionWatermark,
  SessionStateProjection,
  TemporalId,
  TemporalProjectionWatermark,
  TimelineResult,
} from '../../contracts/temporal.js';
import { compareTemporalIds, normalizeTemporalId } from '../../contracts/temporal.js';
import type {
  Association,
  AssociationTargetKind,
  CompactionLog,
  ContextMonitor,
  KnowledgeCandidate,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewAssociation,
  NewCompactionLog,
  NewKnowledgeCandidate,
  NewKnowledgeEvidence,
  NewKnowledgeMemoryAudit,
  NewKnowledgeMemory,
  NewPlaybook,
  NewPlaybookRevision,
  NewSourceDocument,
  NewWorkItem,
  NewTurn,
  NewWorkingMemory,
  Playbook,
  PlaybookRevision,
  PaginationOptions,
  PaginatedResult,
  SearchOptions,
  SearchResult,
  SourceDocument,
  SourceDocumentStatus,
  TimeRange,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';
import { estimateTokens } from '../../core/tokens.js';
import { emitMemoryEvent, type TelemetryOptions } from '../../core/telemetry.js';
import { matchesKnowledgeSearchOptions } from '../../core/retrieval.js';
import {
  assertActorRef,
  assertArchiveInput,
  assertMemoryVisibilityClass,
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
  rowToMemoryEvent,
  rowToAssociation,
  rowToTurn,
  rowToPlaybook,
  rowToPlaybookRevision,
  rowToSessionStateProjection,
  rowToTemporalProjectionWatermark,
  rowToWorkItem,
  rowToWorkingMemory,
  serializeObject,
  serializeNumberArray,
  serializeStringArray,
  type CompactionLogRow,
  type MemoryEventRow,
  type PlaybookRow,
  type KnowledgeCandidateRow,
  type KnowledgeEvidenceRow,
  type KnowledgeMemoryAuditRow,
  type KnowledgeMemoryRow,
  type SessionStateProjectionRow,
  type TemporalProjectionWatermarkRow,
  type WorkingMemoryRow,
} from './mappers.js';
import { createSQLiteEmbeddingAdapter } from './embeddings.js';
import { createSQLiteSchema } from './schema.js';

const SCOPE_WHERE =
  `tenant_id = ? AND system_id = ? AND workspace_id = ? ` +
  `AND (collaboration_id = ? OR (? = '' AND collaboration_id = 'default')) AND scope_id = ?`;
const require = createRequire(import.meta.url);

function normalizeStoredCollaborationId(value: unknown): string {
  const normalized = value == null ? '' : String(value);
  return normalized === 'default' ? '' : normalized;
}

function scopeValues(scope: Parameters<typeof normalizeScope>[0]): string[] {
  const normalized = normalizeScope(scope);
  const values = baseScopeValues(normalized);
  return [values[0], values[1], values[2], values[3], values[3], values[4]];
}

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
  if (level === 'tenant') return 'tenant_id = ?';
  if (level === 'system') return 'tenant_id = ? AND system_id = ?';
  if (level === 'workspace') return 'tenant_id = ? AND workspace_id = ?';
  return SCOPE_WHERE;
}

function scopeWhereForLevelWithPrefix(
  scope: Parameters<typeof normalizeScope>[0],
  level: ScopeLevel,
  prefix: string,
): string {
  return scopeWhereForLevel(scope, level)
    .replaceAll('tenant_id', `${prefix}.tenant_id`)
    .replaceAll('system_id', `${prefix}.system_id`)
    .replaceAll('workspace_id', `${prefix}.workspace_id`)
    .replaceAll('collaboration_id', `${prefix}.collaboration_id`)
    .replaceAll('scope_id', `${prefix}.scope_id`);
}

function scopeParamsForLevel(scope: Parameters<typeof normalizeScope>[0], level: ScopeLevel): string[] {
  const normalized = normalizeScope(scope);
  if (level === 'tenant') return [normalized.tenant_id];
  if (level === 'system') return [normalized.tenant_id, normalized.system_id];
  if (level === 'workspace') return [normalized.tenant_id, normalized.workspace_id];
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
    tags: options?.tags ?? [],
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

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function resolveEventQuery(query?: MemoryEventQuery): {
  sessionId: string;
  entityKind: MemoryEventEntityKind | null;
  entityId: string;
  startAt: number;
  endAt: number;
  limit: number;
  cursor: TemporalId | null;
} {
  return {
    sessionId: query?.sessionId ?? '',
    entityKind: query?.entityKind ?? null,
    entityId: query?.entityId ?? '',
    startAt: query?.startAt ?? Number.NEGATIVE_INFINITY,
    endAt: query?.endAt ?? Number.POSITIVE_INFINITY,
    limit: query?.limit ?? 100,
    cursor: query?.cursor != null ? normalizeTemporalId(query.cursor) : null,
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
  function readTemporalWatermark(
    projectionName = 'temporal',
  ): TemporalProjectionWatermark | null {
    const row = db
      .prepare('SELECT * FROM projection_watermarks WHERE projection_name = ?')
      .get(projectionName) as TemporalProjectionWatermarkRow | undefined;
    return row ? rowToTemporalProjectionWatermark(row) : null;
  }

  function writeTemporalWatermark(
    input: NewTemporalProjectionWatermark,
  ): TemporalProjectionWatermark {
    const lastEventId = normalizeTemporalId(input.last_event_id);
    const updatedAt = input.updated_at ?? nowSeconds();
    db.prepare(
      `INSERT INTO projection_watermarks
        (projection_name, last_event_id, updated_at, cutover_at, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at,
         cutover_at = excluded.cutover_at,
         metadata = excluded.metadata`,
    ).run(
      input.projection_name,
      lastEventId,
      updatedAt,
      input.cutover_at ?? null,
      serializeObject(input.metadata ?? null),
    );
    return readTemporalWatermark(input.projection_name)!;
  }

  function insertMemoryEventInternal(input: NewMemoryEventRecord): MemoryEventRecord {
    const normalized = normalizeScope(input);
    const createdAt = input.created_at ?? nowSeconds();
    const result = db
      .prepare(
        `INSERT INTO memory_event_log
          (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, actor_id,
           actor_kind, actor_system_id, actor_display_name, actor_metadata,
           entity_kind, entity_id, event_type, payload, causation_id, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.tenant_id,
        normalized.system_id,
        normalized.workspace_id,
        normalized.collaboration_id,
        normalized.scope_id,
        input.session_id ?? null,
        input.actor_id ?? null,
        input.actor_kind ?? null,
        input.actor_system_id ?? null,
        input.actor_display_name ?? null,
        input.actor_metadata ? JSON.stringify(input.actor_metadata) : null,
        input.entity_kind,
        input.entity_id,
        input.event_type,
        JSON.stringify(input.payload ?? {}),
        input.causation_id ?? null,
        input.correlation_id ?? null,
        createdAt,
      );
    const eventId = normalizeTemporalId(result.lastInsertRowid as string | number | bigint);
    writeTemporalWatermark({
      projection_name: 'temporal',
      last_event_id: eventId,
      updated_at: createdAt,
      cutover_at: readTemporalWatermark('temporal')?.cutover_at ?? createdAt,
      metadata: readTemporalWatermark('temporal')?.metadata ?? null,
    });
    const row = db
      .prepare('SELECT * FROM memory_event_log WHERE event_id = ?')
      .get(eventId) as MemoryEventRow | undefined;
    return rowToMemoryEvent(row!);
  }

  function insertMemoryEventsBatchInternal(
    inputs: NewMemoryEventRecord[],
  ): MemoryEventRecord[] {
    if (inputs.length === 0) return [];
    const tx = db.transaction((batch: NewMemoryEventRecord[]) => {
      const normalizedBatch = batch.map((input) => ({
        normalized: normalizeScope(input),
        input,
        createdAt: input.created_at ?? nowSeconds(),
      }));
      const values = normalizedBatch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params: unknown[] = [];
      for (const { normalized, input, createdAt } of normalizedBatch) {
        params.push(
          normalized.tenant_id,
          normalized.system_id,
          normalized.workspace_id,
          normalized.collaboration_id,
          normalized.scope_id,
          input.session_id ?? null,
          input.actor_id ?? null,
          input.actor_kind ?? null,
          input.actor_system_id ?? null,
          input.actor_display_name ?? null,
          input.actor_metadata ? JSON.stringify(input.actor_metadata) : null,
          input.entity_kind,
          input.entity_id,
          input.event_type,
          JSON.stringify(input.payload ?? {}),
          input.causation_id ?? null,
          input.correlation_id ?? null,
          createdAt,
        );
      }
      const result = db.prepare(
        `INSERT INTO memory_event_log
          (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, actor_id,
           actor_kind, actor_system_id, actor_display_name, actor_metadata,
           entity_kind, entity_id, event_type, payload, causation_id, correlation_id, created_at)
         VALUES ${values}`,
      ).run(...params);
      const lastEventId = normalizeTemporalId(result.lastInsertRowid as string | number | bigint);
      const firstEventId = normalizeTemporalId(
        BigInt(lastEventId) - BigInt(normalizedBatch.length) + 1n,
      );
      const records = (
        db
          .prepare(
            `SELECT * FROM memory_event_log
             WHERE event_id BETWEEN ? AND ?
             ORDER BY event_id ASC`,
          )
          .all(firstEventId, lastEventId) as MemoryEventRow[]
      ).map(rowToMemoryEvent);
      if (lastEventId != null) {
        writeTemporalWatermark({
          projection_name: 'temporal',
          last_event_id: lastEventId,
          updated_at: normalizedBatch[normalizedBatch.length - 1]!.createdAt,
          cutover_at:
            readTemporalWatermark('temporal')?.cutover_at ??
            normalizedBatch[normalizedBatch.length - 1]!.createdAt,
          metadata: readTemporalWatermark('temporal')?.metadata ?? null,
        });
      }
      return records;
    });
    return tx(inputs);
  }

  function listScopedMemoryEvents(
    scope: Parameters<StorageAdapter['listMemoryEvents']>[0],
    query?: MemoryEventQuery,
  ): TimelineResult {
    const resolved = resolveEventQuery(query);
    const clauses = [SCOPE_WHERE, 'created_at >= ?', 'created_at <= ?'];
    const params: unknown[] = [...scopeValues(scope), resolved.startAt, resolved.endAt];
    if (resolved.cursor != null && compareTemporalIds(resolved.cursor, '0') > 0) {
      clauses.push('event_id > ?');
      params.push(resolved.cursor);
    }
    if (resolved.sessionId) {
      clauses.push('session_id = ?');
      params.push(resolved.sessionId);
    }
    if (resolved.entityKind) {
      clauses.push('entity_kind = ?');
      params.push(resolved.entityKind);
    }
    if (resolved.entityId) {
      clauses.push('entity_id = ?');
      params.push(resolved.entityId);
    }
    const rows = db
      .prepare(
        `SELECT * FROM memory_event_log
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ASC, event_id ASC
         LIMIT ?`,
      )
      .all(...params, resolved.limit + 1) as MemoryEventRow[];
    const pageRows = rows.slice(0, resolved.limit).map(rowToMemoryEvent);
    return {
      events: pageRows,
      nextCursor:
        rows.length > resolved.limit ? pageRows[pageRows.length - 1]?.event_id ?? null : null,
    };
  }

  function listScopedMemoryEventsCrossScope(
    scope: Parameters<StorageAdapter['listMemoryEvents']>[0],
    level: ScopeLevel,
    query?: MemoryEventQuery,
  ): TimelineResult {
    const resolved = resolveEventQuery(query);
    const clauses = [scopeWhereForLevel(scope, level), 'created_at >= ?', 'created_at <= ?'];
    const params: unknown[] = [...scopeParamsForLevel(scope, level), resolved.startAt, resolved.endAt];
    if (resolved.cursor != null && compareTemporalIds(resolved.cursor, '0') > 0) {
      clauses.push('event_id > ?');
      params.push(resolved.cursor);
    }
    if (resolved.sessionId) {
      clauses.push('session_id = ?');
      params.push(resolved.sessionId);
    }
    if (resolved.entityKind) {
      clauses.push('entity_kind = ?');
      params.push(resolved.entityKind);
    }
    if (resolved.entityId) {
      clauses.push('entity_id = ?');
      params.push(resolved.entityId);
    }
    const rows = db
      .prepare(
        `SELECT * FROM memory_event_log
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ASC, event_id ASC
         LIMIT ?`,
      )
      .all(...params, resolved.limit + 1) as MemoryEventRow[];
    const pageRows = rows.slice(0, resolved.limit).map(rowToMemoryEvent);
    return {
      events: pageRows,
      nextCursor:
        rows.length > resolved.limit ? pageRows[pageRows.length - 1]?.event_id ?? null : null,
    };
  }

  function readSessionStateProjection(
    scope: Parameters<StorageAdapter['getSessionState']>[0],
    sessionId: string,
  ): SessionStateProjection | null {
    const row = db
      .prepare(
        `SELECT * FROM session_state_current
         WHERE ${SCOPE_WHERE} AND session_id = ?`,
      )
      .get(...scopeValues(scope), sessionId) as SessionStateProjectionRow | undefined;
    return row ? rowToSessionStateProjection(row) : null;
  }

  function writeSessionStateProjection(
    input: NewSessionStateProjection,
  ): SessionStateProjection {
    const normalized = normalizeScope(input);
    db.prepare(
      `INSERT INTO session_state_current
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id,
         current_objective, blockers, assumptions, pending_decisions, active_tools, recent_outputs,
         updated_at, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id) DO UPDATE SET
         current_objective = excluded.current_objective,
         blockers = excluded.blockers,
         assumptions = excluded.assumptions,
         pending_decisions = excluded.pending_decisions,
         active_tools = excluded.active_tools,
         recent_outputs = excluded.recent_outputs,
         updated_at = excluded.updated_at,
         source_event_id = excluded.source_event_id`,
    ).run(
      normalized.tenant_id,
      normalized.system_id,
      normalized.workspace_id,
      normalized.collaboration_id,
      normalized.scope_id,
      input.session_id,
      input.currentObjective,
      serializeStringArray(input.blockers),
      serializeStringArray(input.assumptions),
      serializeStringArray(input.pendingDecisions),
      serializeStringArray(input.activeTools),
      serializeStringArray(input.recentOutputs),
      input.updatedAt,
      input.source_event_id != null ? normalizeTemporalId(input.source_event_id) : null,
    );
    return readSessionStateProjection(normalized, input.session_id)!;
  }

  function serializeActorMetadata(actor: ActorRef): [string, string, string | null, string | null, string | null] {
    return [
      actor.actor_kind,
      actor.actor_id,
      actor.system_id ?? null,
      actor.display_name ?? null,
      actor.metadata ? JSON.stringify(actor.metadata) : null,
    ];
  }

  function parseActorRef(
    row: Record<string, unknown>,
    prefix: '' | 'from_' | 'to_' = '',
  ): ActorRef {
    const value = (field: string) => row[`${prefix}${field}`];
    let metadata: Record<string, unknown> | null = null;
    if (value('actor_metadata') != null) {
      try {
        const parsed = JSON.parse(String(value('actor_metadata')));
        metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        metadata = null;
      }
    }
    return {
      actor_kind: String(value('actor_kind')) as ActorRef['actor_kind'],
      actor_id: String(value('actor_id')),
      system_id: value('actor_system_id') != null ? String(value('actor_system_id')) : null,
      display_name:
        value('actor_display_name') != null ? String(value('actor_display_name')) : null,
      metadata,
    };
  }

  function mapWorkClaim(row: Record<string, unknown>): WorkClaim {
    return {
      id: Number(row.id),
      tenant_id: String(row.tenant_id),
      system_id: String(row.system_id),
      workspace_id: String(row.workspace_id ?? ''),
      collaboration_id: normalizeStoredCollaborationId(row.collaboration_id),
      scope_id: String(row.scope_id),
      work_item_id: Number(row.work_item_id),
      actor: parseActorRef(row),
      session_id: row.session_id != null ? String(row.session_id) : null,
      claim_token: String(row.claim_token),
      status: String(row.status) as WorkClaim['status'],
      claimed_at: Number(row.claimed_at),
      expires_at: Number(row.expires_at),
      released_at: row.released_at != null ? Number(row.released_at) : null,
      release_reason: row.release_reason != null ? String(row.release_reason) : null,
      source_event_id: row.source_event_id != null ? String(row.source_event_id) : null,
      visibility_class: (row.visibility_class as WorkClaim['visibility_class']) ?? 'private',
      version: Number(row.version ?? 1),
    };
  }

  function mapHandoff(row: Record<string, unknown>): HandoffRecord {
    return {
      id: Number(row.id),
      tenant_id: String(row.tenant_id),
      system_id: String(row.system_id),
      workspace_id: String(row.workspace_id ?? ''),
      collaboration_id: normalizeStoredCollaborationId(row.collaboration_id),
      scope_id: String(row.scope_id),
      work_item_id: Number(row.work_item_id),
      from_actor: parseActorRef(row, 'from_'),
      to_actor: parseActorRef(row, 'to_'),
      session_id: row.session_id != null ? String(row.session_id) : null,
      summary: String(row.summary),
      context_bundle_ref: row.context_bundle_ref != null ? String(row.context_bundle_ref) : null,
      status: String(row.status) as HandoffRecord['status'],
      created_at: Number(row.created_at),
      accepted_at: row.accepted_at != null ? Number(row.accepted_at) : null,
      rejected_at: row.rejected_at != null ? Number(row.rejected_at) : null,
      canceled_at: row.canceled_at != null ? Number(row.canceled_at) : null,
      expires_at: row.expires_at != null ? Number(row.expires_at) : null,
      decision_reason: row.decision_reason != null ? String(row.decision_reason) : null,
      source_event_id: row.source_event_id != null ? String(row.source_event_id) : null,
      visibility_class: (row.visibility_class as HandoffRecord['visibility_class']) ?? 'private',
      version: Number(row.version ?? 1),
    };
  }

  function mapSourceDocumentRow(row: Record<string, unknown>): SourceDocument {
    return {
      id: Number(row.id),
      tenant_id: String(row.tenant_id ?? ''),
      system_id: String(row.system_id ?? ''),
      workspace_id: String(row.workspace_id ?? ''),
      collaboration_id: normalizeStoredCollaborationId(row.collaboration_id),
      scope_id: String(row.scope_id ?? ''),
      title: String(row.title),
      content_hash: String(row.content_hash),
      mime_type: String(row.mime_type ?? 'text/plain'),
      url: row.url != null ? String(row.url) : null,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : {},
      status: String(row.status ?? 'pending') as SourceDocumentStatus,
      fact_count: Number(row.fact_count ?? 0),
      token_estimate: Number(row.token_estimate ?? 0),
      created_at: Number(row.created_at),
      processed_at: row.processed_at != null ? Number(row.processed_at) : null,
    };
  }

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

  function getExistingIds(
    table: 'working_memory' | 'knowledge_memory' | 'work_items' | 'playbooks',
    ids: number[],
  ): number[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return [];
    }
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`)
      .all(...uniqueIds) as Array<{ id: number }>;
    const existing = new Set(rows.map((row) => Number(row.id)));
    return uniqueIds.filter((id) => existing.has(id));
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
    const turn = getTurnById(Number(result.lastInsertRowid))!;
    insertMemoryEventInternal({
      ...scope,
      session_id: turn.session_id,
      actor_id: turn.actor,
      entity_kind: 'turn',
      entity_id: String(turn.id),
      event_type: 'turn.created',
      payload: {
        after: cloneValue(turn),
      },
      created_at: turn.created_at,
    });
    return turn;
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
           contradiction_score, superseded_at, retired_at, valid_from, valid_until, rationale, tags,
           created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.valid_from ?? null,
        input.valid_until ?? null,
        input.rationale ?? null,
        JSON.stringify(input.tags ?? []),
        createdAt,
        createdAt,
      );
    const knowledge = getKnowledgeMemoryById(Number(result.lastInsertRowid))!;
    insertMemoryEventInternal({
      ...scope,
      entity_kind: 'knowledge_memory',
      entity_id: String(knowledge.id),
      event_type: 'knowledge.created',
      payload: {
        after: cloneValue(knowledge),
      },
      created_at: knowledge.created_at,
    });
    return knowledge;
  }

  function bootstrapTemporalCutover(): void {
    const existing = readTemporalWatermark('temporal');
    if (existing?.cutover_at != null) {
      return;
    }

    const cutoverAt = nowSeconds();
    const correlationId = 'temporal-cutover-v1';
    db.transaction(() => {
      writeTemporalWatermark({
        projection_name: 'temporal',
        last_event_id: existing?.last_event_id ?? 0,
        updated_at: cutoverAt,
        cutover_at: cutoverAt,
        metadata: {
          correlation_id: correlationId,
        },
      });

      const turnRows = db.prepare('SELECT * FROM turns ORDER BY created_at ASC, id ASC').all() as Turn[];
      for (const row of turnRows.map(rowToTurn)) {
        insertMemoryEventInternal({
          ...normalizeScope(row),
          session_id: row.session_id,
          actor_id: row.actor,
          entity_kind: 'turn',
          entity_id: String(row.id),
          event_type: 'turn.seeded',
          payload: { after: cloneValue(row) },
          correlation_id: correlationId,
          created_at: cutoverAt,
        });
      }

      const workingRows = db
        .prepare('SELECT * FROM working_memory ORDER BY created_at ASC, id ASC')
        .all() as WorkingMemoryRow[];
      for (const row of workingRows.map(rowToWorkingMemory)) {
        insertMemoryEventInternal({
          ...normalizeScope(row),
          session_id: row.session_id,
          entity_kind: 'working_memory',
          entity_id: String(row.id),
          event_type: 'working_memory.seeded',
          payload: { after: cloneValue(row) },
          correlation_id: correlationId,
          created_at: cutoverAt,
        });
      }

      const knowledgeRows = db
        .prepare('SELECT * FROM knowledge_memory ORDER BY created_at ASC, id ASC')
        .all() as KnowledgeMemoryRow[];
      for (const row of knowledgeRows.map(rowToKnowledgeMemory)) {
        insertMemoryEventInternal({
          ...normalizeScope(row),
          entity_kind: 'knowledge_memory',
          entity_id: String(row.id),
          event_type: 'knowledge.seeded',
          payload: { after: cloneValue(row) },
          correlation_id: correlationId,
          created_at: cutoverAt,
        });
      }

      const workItemRows = db
        .prepare('SELECT * FROM work_items ORDER BY created_at ASC, id ASC')
        .all() as WorkItem[];
      for (const row of workItemRows.map(rowToWorkItem)) {
        insertMemoryEventInternal({
          ...normalizeScope(row),
          session_id: row.session_id,
          entity_kind: 'work_item',
          entity_id: String(row.id),
          event_type: 'work_item.seeded',
          payload: { after: cloneValue(row) },
          correlation_id: correlationId,
          created_at: cutoverAt,
        });
      }

      const associationRows = db
        .prepare('SELECT * FROM associations ORDER BY created_at ASC, id ASC')
        .all() as Array<Record<string, unknown>>;
      for (const row of associationRows.map((item) =>
        rowToAssociation({
          id: Number(item.id),
          tenant_id: String(item.tenant_id),
          system_id: String(item.system_id),
          workspace_id: String(item.workspace_id ?? ''),
          collaboration_id: String(item.collaboration_id ?? item.workspace_id ?? ''),
          scope_id: String(item.scope_id),
          visibility_class: (item.visibility_class as Association['visibility_class']) ?? 'private',
          source_kind: item.source_kind as AssociationTargetKind,
          source_id: Number(item.source_id),
          target_kind: item.target_kind as AssociationTargetKind,
          target_id: Number(item.target_id),
          association_type: item.association_type as Association['association_type'],
          confidence: Number(item.confidence ?? 0),
          auto_generated: Number(item.auto_generated ?? 0) === 1,
          created_at: Number(item.created_at),
        } as Association),
      )) {
        insertMemoryEventInternal({
          ...normalizeScope(row),
          entity_kind: 'association',
          entity_id: String(row.id),
          event_type: 'association.seeded',
          payload: { after: cloneValue(row) },
          correlation_id: correlationId,
          created_at: cutoverAt,
        });
      }

      const playbookRows = db.prepare('SELECT * FROM playbooks ORDER BY created_at ASC, id ASC').all() as PlaybookRow[];
      for (const row of playbookRows.map(rowToPlaybook)) {
        insertMemoryEventInternal({
          ...normalizeScope(row),
          session_id: row.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(row.id),
          event_type: 'playbook.seeded',
          payload: { after: cloneValue(row) },
          correlation_id: correlationId,
          created_at: cutoverAt,
        });
      }
    })();
  }

  bootstrapTemporalCutover();

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
      const safeQuery = toSafeFtsQuery(query);
      const executeSearch = (ftsQuery: string): RankedTurnRow[] =>
        db.prepare(
          `SELECT turns.*, bm25(turns_fts) AS raw_rank
           FROM turns_fts
           JOIN turns ON turns_fts.rowid = turns.id
           WHERE turns_fts MATCH ?
             AND ${SCOPE_WHERE}
             AND (? = 0 OR turns.archived_at IS NULL)
           ORDER BY bm25(turns_fts)
           LIMIT ?`,
        ).all(
          ftsQuery,
          ...scopeValues(scope),
          resolved.activeOnly ? 1 : 0,
          resolved.limit,
        ) as RankedTurnRow[];
      try {
        let rows: RankedTurnRow[];
        try {
          rows = executeSearch(query);
        } catch (error) {
          if (safeQuery.length === 0 || safeQuery === query) throw error;
          rows = executeSearch(safeQuery);
        }
        if (rows.length === 0 && safeQuery.length > 0 && safeQuery !== query && !/["']/.test(query)) {
          rows = executeSearch(safeQuery);
        }
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
      const before = getTurnById(id);
      db.prepare(
        `UPDATE turns
         SET archived_at = ?, compaction_log_id = ?
         WHERE id = ? AND archived_at IS NULL`,
      ).run(archivedAt, compactionLogId, id);
      const after = getTurnById(id);
      if (before && after && before.archived_at !== after.archived_at) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor,
          entity_kind: 'turn',
          entity_id: String(after.id),
          event_type: 'turn.archived',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            patch: {
              archived_at: archivedAt,
              compaction_log_id: compactionLogId,
            },
          },
          created_at: archivedAt,
        });
      }
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
             turn_id_start, turn_id_end, turn_count, compaction_trigger, created_at, expires_at, episode_recap)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.episode_recap ? JSON.stringify(input.episode_recap) : null,
        );
      const workingMemory = getWorkingMemoryById(Number(result.lastInsertRowid))!;
      insertMemoryEventInternal({
        ...scope,
        session_id: workingMemory.session_id,
        entity_kind: 'working_memory',
        entity_id: String(workingMemory.id),
        event_type: 'working_memory.created',
        payload: {
          after: cloneValue(workingMemory),
        },
        created_at: workingMemory.created_at,
      });
      return workingMemory;
    },

    getWorkingMemoryById,

    getExistingWorkingMemoryIds(ids: number[]): number[] {
      return getExistingIds('working_memory', ids);
    },

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
      const before = getWorkingMemoryById(id);
      const expiredAt = nowSeconds();
      db.prepare('UPDATE working_memory SET expires_at = ? WHERE id = ?').run(expiredAt, id);
      const after = getWorkingMemoryById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          entity_kind: 'working_memory',
          entity_id: String(after.id),
          event_type: 'working_memory.expired',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            patch: {
              expires_at: expiredAt,
            },
          },
          created_at: expiredAt,
        });
      }
    },

    markWorkingMemoryPromoted(id: number, knowledgeMemoryId: number): void {
      const before = getWorkingMemoryById(id);
      db.prepare(
        'UPDATE working_memory SET promoted_to_knowledge_id = ? WHERE id = ?',
      ).run(knowledgeMemoryId, id);
      const after = getWorkingMemoryById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          entity_kind: 'working_memory',
          entity_id: String(after.id),
          event_type: 'working_memory.promoted',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            refs: {
              knowledge_memory_id: knowledgeMemoryId,
            },
          },
          created_at: nowSeconds(),
        });
      }
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

    deleteExpiredKnowledgeCandidates(scope, olderThan): number[] {
      const rows = db
        .prepare(
          `SELECT id FROM knowledge_candidate
           WHERE ${SCOPE_WHERE} AND promoted_knowledge_id IS NULL AND created_at < ?`,
        )
        .all(...scopeValues(scope), olderThan) as Array<{ id: number }>;
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        db.prepare(
          `DELETE FROM knowledge_candidate
           WHERE ${SCOPE_WHERE} AND promoted_knowledge_id IS NULL AND created_at < ?`,
        ).run(...scopeValues(scope), olderThan);
      }
      return ids;
    },

    getKnowledgeMemoryById,

    getExistingKnowledgeMemoryIds(ids: number[]): number[] {
      return getExistingIds('knowledge_memory', ids);
    },

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
      const before = getKnowledgeMemoryById(id);
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
      const after = getKnowledgeMemoryById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          entity_kind: 'knowledge_memory',
          entity_id: String(after.id),
          event_type: 'knowledge.updated',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            patch: cloneValue(patch as Record<string, unknown>),
          },
          created_at: nowSeconds(),
        });
      }
      return after;
    },

    insertWorkItem(input: NewWorkItem): WorkItem {
      const scope = validateNewWorkItem(input);
      const createdAt = input.created_at ?? nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO work_items
            (session_id, tenant_id, system_id, workspace_id, collaboration_id, scope_id, kind, title, detail, status,
             visibility_class, source_working_memory_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.visibility_class ?? 'private',
          input.source_working_memory_id ?? null,
          1,
          createdAt,
          createdAt,
        );
      const row = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as WorkItem;
      const workItem = rowToWorkItem(row);
      insertMemoryEventInternal({
        ...scope,
        session_id: workItem.session_id,
        entity_kind: 'work_item',
        entity_id: String(workItem.id),
        event_type: 'work_item.created',
        payload: {
          after: cloneValue(workItem),
        },
        created_at: workItem.created_at,
      });
      return workItem;
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

    getWorkItemById(id: number): WorkItem | null {
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItem | undefined;
      return row ? rowToWorkItem(row) : null;
    },

    getExistingWorkItemIds(ids: number[]): number[] {
      return getExistingIds('work_items', ids);
    },

    getActiveWorkItemsCrossScope(scope, level): WorkItem[] {
      const rows = db
        .prepare(
          `SELECT * FROM work_items
           WHERE ${scopeWhereForLevel(scope, level)} AND status != 'done'
           ORDER BY updated_at DESC`,
        )
        .all(...scopeParamsForLevel(scope, level)) as WorkItem[];
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

    getWorkItemsByTimeRangeCrossScope(scope, level, range): WorkItem[] {
      const time = timeRangeWhere(range, 'created_at');
      const rows = db
        .prepare(
          `SELECT * FROM work_items
           WHERE ${scopeWhereForLevel(scope, level)}${time.clause}
           ORDER BY created_at ASC`,
        )
        .all(...scopeParamsForLevel(scope, level), ...time.params) as WorkItem[];
      return rows.map(rowToWorkItem);
    },

    updateWorkItemStatus(id, status): void {
      const before = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(id) as WorkItem | undefined;
      const updatedAt = nowSeconds();
      db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        updatedAt,
        id,
      );
      const after = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(id) as WorkItem | undefined;
      if (before && after) {
        const afterItem = rowToWorkItem(after);
        insertMemoryEventInternal({
          ...normalizeScope(afterItem),
          session_id: afterItem.session_id,
          entity_kind: 'work_item',
          entity_id: String(afterItem.id),
          event_type: 'work_item.status_changed',
          payload: {
            before: cloneValue(rowToWorkItem(before)),
            after: cloneValue(afterItem),
            patch: {
              status,
              updated_at: updatedAt,
            },
          },
          created_at: updatedAt,
        });
      }
    },

    updateWorkItem(id, patch: WorkItemPatch, options?: { expectedVersion?: number }): WorkItem | null {
      const before = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(id) as WorkItem | undefined;
      if (!before) return null;
      const beforeItem = rowToWorkItem(before);
      if (options?.expectedVersion != null && beforeItem.version !== options.expectedVersion) {
        throw new ConflictError(`Work item ${id} version mismatch`);
      }
      const updatedAt = nowSeconds();
      const next = {
        title: patch.title ?? beforeItem.title,
        detail: patch.detail !== undefined ? patch.detail : beforeItem.detail,
        status: patch.status ?? beforeItem.status,
        visibility_class: patch.visibility_class ?? beforeItem.visibility_class,
      };
      db.prepare(
        `UPDATE work_items
         SET title = ?, detail = ?, status = ?, visibility_class = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(next.title, next.detail ?? null, next.status, next.visibility_class, updatedAt, id);
      const after = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(id) as WorkItem | undefined;
      if (!after) return null;
      const afterItem = rowToWorkItem(after);
      insertMemoryEventInternal({
        ...normalizeScope(afterItem),
        session_id: afterItem.session_id,
        entity_kind: 'work_item',
        entity_id: String(afterItem.id),
        event_type:
          patch.visibility_class !== undefined &&
          patch.title === undefined &&
          patch.detail === undefined &&
          patch.status === undefined
            ? 'work_item.visibility_changed'
            : 'work_item.updated',
        payload: {
          before: cloneValue(beforeItem),
          after: cloneValue(afterItem),
          patch: cloneValue(patch as Record<string, unknown>),
        },
        created_at: updatedAt,
      });
      return afterItem;
    },

    deleteWorkItem(id): void {
      const before = db
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(id) as WorkItem | undefined;
      db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
      if (before) {
        const item = rowToWorkItem(before);
        insertMemoryEventInternal({
          ...normalizeScope(item),
          session_id: item.session_id,
          entity_kind: 'work_item',
          entity_id: String(item.id),
          event_type: 'work_item.deleted',
          payload: {
            before: cloneValue(item),
          },
          created_at: nowSeconds(),
        });
      }
    },

    claimWorkItem(input: NewWorkClaimInput): WorkClaim {
      const tx = db.transaction((): WorkClaim => {
        assertActorRef(input.actor);
        const workItemRow = db.prepare('SELECT * FROM work_items WHERE id = ?').get(input.work_item_id) as
          | WorkItem
          | undefined;
        if (!workItemRow) throw new ConflictError(`Work item ${input.work_item_id} does not exist`);
        const workItem = rowToWorkItem(workItemRow);
        if (workItem.status === 'done') throw new ConflictError(`Work item ${input.work_item_id} is done`);
        const now = input.claimed_at ?? nowSeconds();
        const existingRow = db
          .prepare('SELECT * FROM work_claims_current WHERE work_item_id = ?')
          .get(input.work_item_id) as Record<string, unknown> | undefined;
        if (existingRow) {
          const existing = mapWorkClaim(existingRow);
          if (existing.status === 'active' && existing.expires_at > now) {
            if (
              existing.actor.actor_kind !== input.actor.actor_kind ||
              existing.actor.actor_id !== input.actor.actor_id
            ) {
              throw new ConflictError(`Work item ${input.work_item_id} is already claimed`);
            }
            return this.renewWorkClaim(existing.id, input.actor, input.lease_seconds ?? 300)!;
          }
          db.prepare(
            `UPDATE work_claims_current
             SET status = 'expired', released_at = ?, release_reason = 'expired', version = version + 1
             WHERE id = ?`,
          ).run(now, existing.id);
          const expired = mapWorkClaim(
            db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(existing.id) as Record<string, unknown>,
          );
          insertMemoryEventInternal({
            ...normalizeScope(expired),
            session_id: expired.session_id,
            actor_id: expired.actor.actor_id,
            actor_kind: expired.actor.actor_kind,
            actor_system_id: expired.actor.system_id,
            actor_display_name: expired.actor.display_name,
            actor_metadata: expired.actor.metadata,
            entity_kind: 'work_claim',
            entity_id: String(expired.id),
            event_type: 'work_claim.expired',
            payload: { after: cloneValue(expired) },
            created_at: now,
          });
        }
        const normalized = normalizeScope(input);
        const actorParts = serializeActorMetadata(input.actor);
        const claimToken = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const result = db.prepare(
          `INSERT INTO work_claims_current
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, work_item_id, session_id,
             actor_kind, actor_id, actor_system_id, actor_display_name, actor_metadata,
             claim_token, status, claimed_at, expires_at, visibility_class, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1)`,
        ).run(
          normalized.tenant_id,
          normalized.system_id,
          normalized.workspace_id,
          normalized.collaboration_id,
          normalized.scope_id,
          input.work_item_id,
          input.session_id ?? null,
          ...actorParts,
          claimToken,
          now,
          now + (input.lease_seconds ?? 300),
          input.visibility_class,
        );
        const claim = mapWorkClaim(
          db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(Number(result.lastInsertRowid)) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalized,
          session_id: claim.session_id,
          actor_id: claim.actor.actor_id,
          actor_kind: claim.actor.actor_kind,
          actor_system_id: claim.actor.system_id,
          actor_display_name: claim.actor.display_name,
          actor_metadata: claim.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(claim.id),
          event_type: 'work_claim.claimed',
          payload: { after: cloneValue(claim) },
          created_at: now,
        });
        return claim;
      });
      try {
        return tx();
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
        ) {
          throw new ConflictError(`Work item ${input.work_item_id} is already claimed`);
        }
        throw error;
      }
    },

    renewWorkClaim(claimId, actor, leaseSeconds = 300): WorkClaim | null {
      return db.transaction(() => {
        assertActorRef(actor);
        const before = db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(claimId) as Record<string, unknown> | undefined;
        if (!before) return null;
        const claim = mapWorkClaim(before);
        if (claim.actor.actor_kind !== actor.actor_kind || claim.actor.actor_id !== actor.actor_id) {
          throw new ConflictError(`Claim ${claimId} is owned by another actor`);
        }
        const now = nowSeconds();
        if (claim.status !== 'active') {
          throw new ConflictError(`Claim ${claimId} is no longer active`);
        }
        if (claim.expires_at <= now) {
          db.prepare(
            `UPDATE work_claims_current
             SET status = 'expired', released_at = ?, release_reason = 'expired', version = version + 1
             WHERE id = ?`,
          ).run(now, claimId);
          const expired = mapWorkClaim(
            db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(claimId) as Record<string, unknown>,
          );
          insertMemoryEventInternal({
            ...normalizeScope(expired),
            session_id: expired.session_id,
            actor_id: expired.actor.actor_id,
            actor_kind: expired.actor.actor_kind,
            actor_system_id: expired.actor.system_id,
            actor_display_name: expired.actor.display_name,
            actor_metadata: expired.actor.metadata,
            entity_kind: 'work_claim',
            entity_id: String(expired.id),
            event_type: 'work_claim.expired',
            payload: { before: cloneValue(claim), after: cloneValue(expired) },
            created_at: now,
          });
          return null;
        }
        db.prepare(
          `UPDATE work_claims_current
           SET expires_at = ?, version = version + 1
           WHERE id = ?`,
        ).run(Math.max(claim.expires_at, now) + leaseSeconds, claimId);
        const after = mapWorkClaim(
          db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(claimId) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor.actor_id,
          actor_kind: after.actor.actor_kind,
          actor_system_id: after.actor.system_id,
          actor_display_name: after.actor.display_name,
          actor_metadata: after.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(after.id),
          event_type: 'work_claim.renewed',
          payload: { before: cloneValue(claim), after: cloneValue(after) },
          created_at: now,
        });
        return after;
      })();
    },

    releaseWorkClaim(claimId, actor, reason): WorkClaim | null {
      return db.transaction(() => {
        assertActorRef(actor);
        const before = db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(claimId) as Record<string, unknown> | undefined;
        if (!before) return null;
        const claim = mapWorkClaim(before);
        if (claim.actor.actor_kind !== actor.actor_kind || claim.actor.actor_id !== actor.actor_id) {
          throw new ConflictError(`Claim ${claimId} is owned by another actor`);
        }
        if (claim.status !== 'active') {
          throw new ConflictError(`Claim ${claimId} is no longer active`);
        }
        const now = nowSeconds();
        db.prepare(
          `UPDATE work_claims_current
           SET status = 'released', released_at = ?, release_reason = ?, version = version + 1
           WHERE id = ?`,
        ).run(now, reason ?? null, claimId);
        const after = mapWorkClaim(
          db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(claimId) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor.actor_id,
          actor_kind: after.actor.actor_kind,
          actor_system_id: after.actor.system_id,
          actor_display_name: after.actor.display_name,
          actor_metadata: after.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(after.id),
          event_type: 'work_claim.released',
          payload: { before: cloneValue(claim), after: cloneValue(after) },
          created_at: now,
        });
        return after;
      })();
    },

    getWorkClaimById(claimId): WorkClaim | null {
      const row = db
        .prepare('SELECT * FROM work_claims_current WHERE id = ?')
        .get(claimId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return mapWorkClaim(row);
    },

    getActiveWorkClaim(workItemId): WorkClaim | null {
      const row = db
        .prepare(
          `SELECT * FROM work_claims_current
           WHERE work_item_id = ? AND status = 'active'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(workItemId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const claim = mapWorkClaim(row);
      if (claim.expires_at > nowSeconds()) return claim;
      const expiredAt = nowSeconds();
      db.prepare(
        `UPDATE work_claims_current
         SET status = 'expired', released_at = ?, release_reason = 'expired', version = version + 1
         WHERE id = ?`,
      ).run(expiredAt, claim.id);
      const expired = mapWorkClaim(
        db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(claim.id) as Record<string, unknown>,
      );
      insertMemoryEventInternal({
        ...normalizeScope(expired),
        session_id: expired.session_id,
        actor_id: expired.actor.actor_id,
        actor_kind: expired.actor.actor_kind,
        actor_system_id: expired.actor.system_id,
        actor_display_name: expired.actor.display_name,
        actor_metadata: expired.actor.metadata,
        entity_kind: 'work_claim',
        entity_id: String(expired.id),
        event_type: 'work_claim.expired',
        payload: { before: cloneValue(claim), after: cloneValue(expired) },
        created_at: expiredAt,
      });
      return null;
    },

    listWorkClaims(scope, options?: WorkClaimQuery): WorkClaim[] {
      const now = nowSeconds();
      const expiredRows = db
        .prepare(
          `SELECT * FROM work_claims_current
           WHERE ${SCOPE_WHERE} AND status = 'active' AND expires_at <= ?`,
        )
        .all(...scopeValues(scope), now) as Array<Record<string, unknown>>;
      for (const row of expiredRows) {
        const before = mapWorkClaim(row);
        db.prepare(
          `UPDATE work_claims_current
           SET status = 'expired', released_at = ?, release_reason = 'expired', version = version + 1
           WHERE id = ?`,
        ).run(now, before.id);
        const after = mapWorkClaim(
          db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(before.id) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor.actor_id,
          actor_kind: after.actor.actor_kind,
          actor_system_id: after.actor.system_id,
          actor_display_name: after.actor.display_name,
          actor_metadata: after.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(after.id),
          event_type: 'work_claim.expired',
          payload: { before: cloneValue(before), after: cloneValue(after) },
          created_at: now,
        });
      }
      const rows = db
        .prepare(`SELECT * FROM work_claims_current WHERE ${SCOPE_WHERE} ORDER BY claimed_at DESC`)
        .all(...scopeValues(scope)) as Array<Record<string, unknown>>;
      return rows
        .map(mapWorkClaim)
        .filter((claim) => {
          if (!options?.includeExpired && claim.status === 'expired') return false;
          if (!options?.includeReleased && claim.status === 'released') return false;
          if (options?.sessionId && claim.session_id !== options.sessionId) return false;
          if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
          if (options?.actor) {
            return (
              claim.actor.actor_kind === options.actor.actor_kind &&
              claim.actor.actor_id === options.actor.actor_id
            );
          }
          return true;
        });
    },

    listWorkClaimsCrossScope(scope, level, options?: WorkClaimQuery): WorkClaim[] {
      const now = nowSeconds();
      const expiredRows = db
        .prepare(
          `SELECT * FROM work_claims_current
           WHERE ${scopeWhereForLevel(scope, level)} AND status = 'active' AND expires_at <= ?`,
        )
        .all(...scopeParamsForLevel(scope, level), now) as Array<Record<string, unknown>>;
      for (const row of expiredRows) {
        const before = mapWorkClaim(row);
        db.prepare(
          `UPDATE work_claims_current
           SET status = 'expired', released_at = ?, release_reason = 'expired', version = version + 1
           WHERE id = ?`,
        ).run(now, before.id);
        const after = mapWorkClaim(
          db.prepare('SELECT * FROM work_claims_current WHERE id = ?').get(before.id) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor.actor_id,
          actor_kind: after.actor.actor_kind,
          actor_system_id: after.actor.system_id,
          actor_display_name: after.actor.display_name,
          actor_metadata: after.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(after.id),
          event_type: 'work_claim.expired',
          payload: { before: cloneValue(before), after: cloneValue(after) },
          created_at: now,
        });
      }
      const rows = db
        .prepare(`SELECT * FROM work_claims_current WHERE ${scopeWhereForLevel(scope, level)} ORDER BY claimed_at DESC`)
        .all(...scopeParamsForLevel(scope, level)) as Array<Record<string, unknown>>;
      return rows
        .map(mapWorkClaim)
        .filter((claim) => {
          if (!options?.includeExpired && claim.status === 'expired') return false;
          if (!options?.includeReleased && claim.status === 'released') return false;
          if (options?.sessionId && claim.session_id !== options.sessionId) return false;
          if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
          if (options?.actor) {
            return (
              claim.actor.actor_kind === options.actor.actor_kind &&
              claim.actor.actor_id === options.actor.actor_id
            );
          }
          return true;
        });
    },

    createHandoff(input: NewHandoffInput): HandoffRecord {
      assertActorRef(input.from_actor, 'from_actor');
      assertActorRef(input.to_actor, 'to_actor');
      const normalized = normalizeScope(input);
      const createdAt = input.created_at ?? nowSeconds();
      const fromParts = serializeActorMetadata(input.from_actor);
      const toParts = serializeActorMetadata(input.to_actor);
      const result = db.prepare(
        `INSERT INTO handoff_records
          (tenant_id, system_id, workspace_id, collaboration_id, scope_id, work_item_id, session_id,
           from_actor_kind, from_actor_id, from_actor_system_id, from_actor_display_name, from_actor_metadata,
           to_actor_kind, to_actor_id, to_actor_system_id, to_actor_display_name, to_actor_metadata,
           summary, context_bundle_ref, status, created_at, expires_at, visibility_class, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)`,
      ).run(
        normalized.tenant_id,
        normalized.system_id,
        normalized.workspace_id,
        normalized.collaboration_id,
        normalized.scope_id,
        input.work_item_id,
        input.session_id ?? null,
        ...fromParts,
        ...toParts,
        input.summary,
        input.context_bundle_ref ?? null,
        createdAt,
        input.expires_at ?? null,
        input.visibility_class,
      );
      const handoff = mapHandoff(
        db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(Number(result.lastInsertRowid)) as Record<string, unknown>,
      );
      insertMemoryEventInternal({
        ...normalized,
        session_id: handoff.session_id,
        actor_id: handoff.from_actor.actor_id,
        actor_kind: handoff.from_actor.actor_kind,
        actor_system_id: handoff.from_actor.system_id,
        actor_display_name: handoff.from_actor.display_name,
        actor_metadata: handoff.from_actor.metadata,
        entity_kind: 'handoff',
        entity_id: String(handoff.id),
        event_type: 'handoff.created',
        payload: { after: cloneValue(handoff) },
        created_at: createdAt,
      });
      return handoff;
    },

    getHandoffById(handoffId): HandoffRecord | null {
      const row = db
        .prepare('SELECT * FROM handoff_records WHERE id = ?')
        .get(handoffId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return mapHandoff(row);
    },

    acceptHandoff(handoffId, actor, reason): HandoffRecord | null {
      return db.transaction(() => {
        assertActorRef(actor);
        const before = db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown> | undefined;
        if (!before) return null;
        const handoff = mapHandoff(before);
        if (handoff.to_actor.actor_kind !== actor.actor_kind || handoff.to_actor.actor_id !== actor.actor_id) {
          throw new ConflictError(`Handoff ${handoffId} is assigned to another actor`);
        }
        const now = nowSeconds();
        if (handoff.status !== 'pending') {
          throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
        }
        if (handoff.expires_at != null && handoff.expires_at <= now) {
          db.prepare(
            `UPDATE handoff_records
             SET status = 'expired', decision_reason = 'expired', version = version + 1
             WHERE id = ?`,
          ).run(handoffId);
          const expired = mapHandoff(
            db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown>,
          );
          insertMemoryEventInternal({
            ...normalizeScope(expired),
            session_id: expired.session_id,
            actor_id: expired.to_actor.actor_id,
            actor_kind: expired.to_actor.actor_kind,
            actor_system_id: expired.to_actor.system_id,
            actor_display_name: expired.to_actor.display_name,
            actor_metadata: expired.to_actor.metadata,
            entity_kind: 'handoff',
            entity_id: String(expired.id),
            event_type: 'handoff.expired',
            payload: { before: cloneValue(handoff), after: cloneValue(expired) },
            created_at: now,
          });
          return null;
        }
        const activeClaim = this.getActiveWorkClaim(handoff.work_item_id);
        if (activeClaim &&
          !(activeClaim.actor.actor_kind === handoff.from_actor.actor_kind && activeClaim.actor.actor_id === handoff.from_actor.actor_id)
        ) {
          throw new ConflictError(`Work item ${handoff.work_item_id} has another active owner`);
        }
        if (activeClaim) {
          this.releaseWorkClaim(activeClaim.id, handoff.from_actor, 'handoff_accepted');
        }
        this.claimWorkItem({
          ...normalizeScope(handoff),
          work_item_id: handoff.work_item_id,
          actor,
          session_id: handoff.session_id,
          visibility_class: handoff.visibility_class,
        });
        db.prepare(
          `UPDATE handoff_records
           SET status = 'accepted', accepted_at = ?, decision_reason = ?, version = version + 1
           WHERE id = ?`,
        ).run(now, reason ?? null, handoffId);
        const after = mapHandoff(
          db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: actor.actor_id,
          actor_kind: actor.actor_kind,
          actor_system_id: actor.system_id,
          actor_display_name: actor.display_name,
          actor_metadata: actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.accepted',
          payload: { before: cloneValue(handoff), after: cloneValue(after) },
          created_at: now,
        });
        return after;
      })();
    },

    rejectHandoff(handoffId, actor, reason): HandoffRecord | null {
      return db.transaction(() => {
        assertActorRef(actor);
        const before = db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown> | undefined;
        if (!before) return null;
        const handoff = mapHandoff(before);
        if (handoff.to_actor.actor_kind !== actor.actor_kind || handoff.to_actor.actor_id !== actor.actor_id) {
          throw new ConflictError(`Handoff ${handoffId} is assigned to another actor`);
        }
        const now = nowSeconds();
        if (handoff.status !== 'pending') {
          throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
        }
        if (handoff.expires_at != null && handoff.expires_at <= now) {
          db.prepare(
            `UPDATE handoff_records
             SET status = 'expired', decision_reason = 'expired', version = version + 1
             WHERE id = ?`,
          ).run(handoffId);
          const expired = mapHandoff(
            db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown>,
          );
          insertMemoryEventInternal({
            ...normalizeScope(expired),
            session_id: expired.session_id,
            actor_id: expired.to_actor.actor_id,
            actor_kind: expired.to_actor.actor_kind,
            actor_system_id: expired.to_actor.system_id,
            actor_display_name: expired.to_actor.display_name,
            actor_metadata: expired.to_actor.metadata,
            entity_kind: 'handoff',
            entity_id: String(expired.id),
            event_type: 'handoff.expired',
            payload: { before: cloneValue(handoff), after: cloneValue(expired) },
            created_at: now,
          });
          return null;
        }
        db.prepare(
          `UPDATE handoff_records
           SET status = 'rejected', rejected_at = ?, decision_reason = ?, version = version + 1
           WHERE id = ?`,
        ).run(now, reason ?? null, handoffId);
        const after = mapHandoff(
          db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: actor.actor_id,
          actor_kind: actor.actor_kind,
          actor_system_id: actor.system_id,
          actor_display_name: actor.display_name,
          actor_metadata: actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.rejected',
          payload: { before: cloneValue(handoff), after: cloneValue(after) },
          created_at: now,
        });
        return after;
      })();
    },

    cancelHandoff(handoffId, actor, reason): HandoffRecord | null {
      return db.transaction(() => {
        assertActorRef(actor);
        const before = db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown> | undefined;
        if (!before) return null;
        const handoff = mapHandoff(before);
        if (handoff.from_actor.actor_kind !== actor.actor_kind || handoff.from_actor.actor_id !== actor.actor_id) {
          throw new ConflictError(`Handoff ${handoffId} was created by another actor`);
        }
        const now = nowSeconds();
        if (handoff.status !== 'pending') {
          throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
        }
        if (handoff.expires_at != null && handoff.expires_at <= now) {
          db.prepare(
            `UPDATE handoff_records
             SET status = 'expired', decision_reason = 'expired', version = version + 1
             WHERE id = ?`,
          ).run(handoffId);
          const expired = mapHandoff(
            db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown>,
          );
          insertMemoryEventInternal({
            ...normalizeScope(expired),
            session_id: expired.session_id,
            actor_id: expired.from_actor.actor_id,
            actor_kind: expired.from_actor.actor_kind,
            actor_system_id: expired.from_actor.system_id,
            actor_display_name: expired.from_actor.display_name,
            actor_metadata: expired.from_actor.metadata,
            entity_kind: 'handoff',
            entity_id: String(expired.id),
            event_type: 'handoff.expired',
            payload: { before: cloneValue(handoff), after: cloneValue(expired) },
            created_at: now,
          });
          return null;
        }
        db.prepare(
          `UPDATE handoff_records
           SET status = 'canceled', canceled_at = ?, decision_reason = ?, version = version + 1
           WHERE id = ?`,
        ).run(now, reason ?? null, handoffId);
        const after = mapHandoff(
          db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(handoffId) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: actor.actor_id,
          actor_kind: actor.actor_kind,
          actor_system_id: actor.system_id,
          actor_display_name: actor.display_name,
          actor_metadata: actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.canceled',
          payload: { before: cloneValue(handoff), after: cloneValue(after) },
          created_at: now,
        });
        return after;
      })();
    },

    listHandoffs(scope, options?: HandoffQuery): HandoffRecord[] {
      const now = nowSeconds();
      const expiredRows = db
        .prepare(
          `SELECT * FROM handoff_records
           WHERE ${SCOPE_WHERE} AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(...scopeValues(scope), now) as Array<Record<string, unknown>>;
      for (const row of expiredRows) {
        const before = mapHandoff(row);
        db.prepare(
          `UPDATE handoff_records
           SET status = 'expired', decision_reason = 'expired', version = version + 1
           WHERE id = ?`,
        ).run(before.id);
        const after = mapHandoff(
          db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(before.id) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.to_actor.actor_id,
          actor_kind: after.to_actor.actor_kind,
          actor_system_id: after.to_actor.system_id,
          actor_display_name: after.to_actor.display_name,
          actor_metadata: after.to_actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.expired',
          payload: { before: cloneValue(before), after: cloneValue(after) },
          created_at: now,
        });
      }
      const rows = db
        .prepare(`SELECT * FROM handoff_records WHERE ${SCOPE_WHERE} ORDER BY created_at DESC`)
        .all(...scopeValues(scope)) as Array<Record<string, unknown>>;
      return rows.map(mapHandoff).filter((handoff) => {
        if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
        if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
        if (!options?.actor) return true;
        const inbound =
          handoff.to_actor.actor_kind === options.actor.actor_kind &&
          handoff.to_actor.actor_id === options.actor.actor_id;
        const outbound =
          handoff.from_actor.actor_kind === options.actor.actor_kind &&
          handoff.from_actor.actor_id === options.actor.actor_id;
        if (options.direction === 'inbound') return inbound;
        if (options.direction === 'outbound') return outbound;
        return inbound || outbound;
      });
    },

    listHandoffsCrossScope(scope, level, options?: HandoffQuery): HandoffRecord[] {
      const now = nowSeconds();
      const expiredRows = db
        .prepare(
          `SELECT * FROM handoff_records
           WHERE ${scopeWhereForLevel(scope, level)} AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(...scopeParamsForLevel(scope, level), now) as Array<Record<string, unknown>>;
      for (const row of expiredRows) {
        const before = mapHandoff(row);
        db.prepare(
          `UPDATE handoff_records
           SET status = 'expired', decision_reason = 'expired', version = version + 1
           WHERE id = ?`,
        ).run(before.id);
        const after = mapHandoff(
          db.prepare('SELECT * FROM handoff_records WHERE id = ?').get(before.id) as Record<string, unknown>,
        );
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.to_actor.actor_id,
          actor_kind: after.to_actor.actor_kind,
          actor_system_id: after.to_actor.system_id,
          actor_display_name: after.to_actor.display_name,
          actor_metadata: after.to_actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.expired',
          payload: { before: cloneValue(before), after: cloneValue(after) },
          created_at: now,
        });
      }
      const rows = db
        .prepare(`SELECT * FROM handoff_records WHERE ${scopeWhereForLevel(scope, level)} ORDER BY created_at DESC`)
        .all(...scopeParamsForLevel(scope, level)) as Array<Record<string, unknown>>;
      return rows.map(mapHandoff).filter((handoff) => {
        if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
        if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
        if (!options?.actor) return true;
        const inbound =
          handoff.to_actor.actor_kind === options.actor.actor_kind &&
          handoff.to_actor.actor_id === options.actor.actor_id;
        const outbound =
          handoff.from_actor.actor_kind === options.actor.actor_kind &&
          handoff.from_actor.actor_id === options.actor.actor_id;
        if (options.direction === 'inbound') return inbound;
        if (options.direction === 'outbound') return outbound;
        return inbound || outbound;
      });
    },

    touchKnowledgeMemory(id: number): void {
      const before = getKnowledgeMemoryById(id);
      const touchedAt = nowSeconds();
      db.prepare(
        `UPDATE knowledge_memory
         SET last_accessed_at = ?, access_count = access_count + 1
         WHERE id = ?`,
      ).run(touchedAt, id);
      const after = getKnowledgeMemoryById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          entity_kind: 'knowledge_memory',
          entity_id: String(after.id),
          event_type: 'knowledge.touched',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            patch: {
              last_accessed_at: touchedAt,
              access_count: after.access_count,
            },
          },
          created_at: touchedAt,
        });
      }
    },

    touchKnowledgeMemories(ids: number[]): void {
      const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
      if (uniqueIds.length === 0) return;
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const beforeRows = db
        .prepare(`SELECT * FROM knowledge_memory WHERE id IN (${placeholders})`)
        .all(...uniqueIds) as KnowledgeMemoryRow[];
      if (beforeRows.length === 0) return;
      const touchedAt = nowSeconds();
      db.prepare(
        `UPDATE knowledge_memory
         SET last_accessed_at = ?, access_count = access_count + 1
         WHERE id IN (${placeholders})`,
      ).run(touchedAt, ...uniqueIds);
      const afterRows = db
        .prepare(`SELECT * FROM knowledge_memory WHERE id IN (${placeholders})`)
        .all(...uniqueIds) as KnowledgeMemoryRow[];
      const afterById = new Map(afterRows.map((row) => [Number(row.id), rowToKnowledgeMemory(row)]));
      insertMemoryEventsBatchInternal(
        beforeRows.flatMap((row) => {
          const before = rowToKnowledgeMemory(row);
          const after = afterById.get(before.id);
          if (!after) return [];
          return [{
            ...normalizeScope(after),
            entity_kind: 'knowledge_memory' as const,
            entity_id: String(after.id),
            event_type: 'knowledge.touched' as const,
            payload: {
              before: cloneValue(before),
              after: cloneValue(after),
              patch: {
                last_accessed_at: touchedAt,
                access_count: after.access_count,
              },
            },
            created_at: touchedAt,
          }];
        }),
      );
    },

    retireKnowledgeMemory(id: number, retiredAt = nowSeconds()): void {
      const before = getKnowledgeMemoryById(id);
      db.prepare('UPDATE knowledge_memory SET retired_at = ? WHERE id = ?').run(retiredAt, id);
      const after = getKnowledgeMemoryById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          entity_kind: 'knowledge_memory',
          entity_id: String(after.id),
          event_type: 'knowledge.retired',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            patch: {
              retired_at: retiredAt,
            },
          },
          created_at: retiredAt,
        });
      }
    },

    supersedeKnowledgeMemory(oldId: number, newId: number): void {
      const before = getKnowledgeMemoryById(oldId);
      const supersededAt = nowSeconds();
      db.prepare(
        `UPDATE knowledge_memory
         SET superseded_by_id = ?, superseded_at = ?, knowledge_state = 'superseded'
         WHERE id = ?`,
      ).run(newId, supersededAt, oldId);
      const after = getKnowledgeMemoryById(oldId);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          entity_kind: 'knowledge_memory',
          entity_id: String(after.id),
          event_type: 'knowledge.superseded',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            refs: {
              new_id: newId,
            },
          },
          created_at: supersededAt,
        });
      }
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

    insertPlaybook(input: NewPlaybook): Playbook {
      const scope = normalizeScope(input);
      const now = nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO playbooks
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, title, description, instructions,
             references_json, templates, scripts, assets, tags, rationale, status, source_session_id, source_working_memory_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenant_id, scope.system_id, scope.workspace_id, scope.collaboration_id, scope.scope_id,
          input.title, input.description, input.instructions,
          serializeStringArray(input.references ?? []), serializeStringArray(input.templates ?? []),
          serializeStringArray(input.scripts ?? []), serializeStringArray(input.assets ?? []),
          serializeStringArray(input.tags ?? []), input.rationale ?? null, input.status ?? 'draft',
          input.source_session_id ?? null, input.source_working_memory_id ?? null,
          input.created_at ?? now, now,
        );
      const playbook = this.getPlaybookById(Number(result.lastInsertRowid))!;
      insertMemoryEventInternal({
        ...scope,
        session_id: playbook.source_session_id,
        entity_kind: 'playbook',
        entity_id: String(playbook.id),
        event_type: 'playbook.created',
        payload: {
          after: cloneValue(playbook),
        },
        created_at: playbook.created_at,
      });
      return playbook;
    },
    getPlaybookById(id: number): Playbook | null {
      const row = db.prepare('SELECT * FROM playbooks WHERE id = ?').get(id) as PlaybookRow | undefined;
      return row ? rowToPlaybook(row) : null;
    },
    getExistingPlaybookIds(ids: number[]): number[] {
      return getExistingIds('playbooks', ids);
    },
    getActivePlaybooks(scope): Playbook[] {
      const rows = db
        .prepare(`SELECT * FROM playbooks WHERE ${SCOPE_WHERE} AND status IN ('draft', 'active') ORDER BY id DESC`)
        .all(...scopeValues(scope)) as PlaybookRow[];
      return rows.map(rowToPlaybook);
    },
    getActivePlaybooksCrossScope(scope, level): Playbook[] {
      const rows = db
        .prepare(
          `SELECT * FROM playbooks
           WHERE ${scopeWhereForLevel(scope, level)} AND status IN ('draft', 'active')
           ORDER BY id DESC`,
        )
        .all(...scopeParamsForLevel(scope, level)) as PlaybookRow[];
      return rows.map(rowToPlaybook);
    },
    searchPlaybooks(scope, query, options): SearchResult<Playbook>[] {
      const limit = options?.limit ?? 20;
      const activeOnly = options?.activeOnly ?? true;
      const safeQuery = toSafeFtsQuery(query);
      if (!safeQuery) return [];
      const statusFilter = activeOnly
        ? `AND p.status NOT IN ('archived', 'deprecated')`
        : '';
      try {
        const rows = db
          .prepare(
            `SELECT p.* FROM playbooks p
             INNER JOIN playbooks_fts f ON f.rowid = p.id
             WHERE p.${SCOPE_WHERE} ${statusFilter}
             AND playbooks_fts MATCH ?
             ORDER BY rank LIMIT ?`,
          )
          .all(...scopeValues(scope), safeQuery, limit) as PlaybookRow[];
        return rows.map((row, index) => ({ item: rowToPlaybook(row), rank: index }));
      } catch {
        return [];
      }
    },
    searchPlaybooksCrossScope(scope, level, query, options): SearchResult<Playbook>[] {
      const limit = options?.limit ?? 20;
      const activeOnly = options?.activeOnly ?? true;
      const safeQuery = toSafeFtsQuery(query);
      if (!safeQuery) return [];
      const statusFilter = activeOnly
        ? `AND p.status NOT IN ('archived', 'deprecated')`
        : '';
      try {
        const rows = db
          .prepare(
            `SELECT p.* FROM playbooks p
             INNER JOIN playbooks_fts f ON f.rowid = p.id
             WHERE ${scopeWhereForLevelWithPrefix(scope, level, 'p')} ${statusFilter}
             AND playbooks_fts MATCH ?
             ORDER BY rank LIMIT ?`,
          )
          .all(...scopeParamsForLevel(scope, level), safeQuery, limit) as PlaybookRow[];
        return rows.map((row, index) => ({ item: rowToPlaybook(row), rank: index }));
      } catch {
        return [];
      }
    },
    updatePlaybook(id, patch): Playbook | null {
      const before = this.getPlaybookById(id);
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.title != null) { sets.push('title = ?'); values.push(patch.title); }
      if (patch.description != null) { sets.push('description = ?'); values.push(patch.description); }
      if (patch.instructions != null) { sets.push('instructions = ?'); values.push(patch.instructions); }
      if (patch.references != null) { sets.push('references_json = ?'); values.push(serializeStringArray(patch.references)); }
      if (patch.templates != null) { sets.push('templates = ?'); values.push(serializeStringArray(patch.templates)); }
      if (patch.scripts != null) { sets.push('scripts = ?'); values.push(serializeStringArray(patch.scripts)); }
      if (patch.assets != null) { sets.push('assets = ?'); values.push(serializeStringArray(patch.assets)); }
      if (patch.tags != null) { sets.push('tags = ?'); values.push(serializeStringArray(patch.tags)); }
      if (patch.rationale !== undefined) { sets.push('rationale = ?'); values.push(patch.rationale); }
      if (patch.status != null) { sets.push('status = ?'); values.push(patch.status); }
      if (sets.length === 0) return this.getPlaybookById(id);
      sets.push('updated_at = ?');
      values.push(nowSeconds());
      values.push(id);
      db.prepare(`UPDATE playbooks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      const after = this.getPlaybookById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(after.id),
          event_type: 'playbook.updated',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            patch: cloneValue(patch as Record<string, unknown>),
          },
          created_at: after.updated_at,
        });
      }
      return after;
    },
    recordPlaybookUse(id: number): void {
      const before = this.getPlaybookById(id);
      const usedAt = nowSeconds();
      db.prepare('UPDATE playbooks SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(usedAt, id);
      const after = this.getPlaybookById(id);
      if (before && after) {
        insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(after.id),
          event_type: 'playbook.used',
          payload: {
            before: cloneValue(before),
            after: cloneValue(after),
            refs: {
              use_count: after.use_count,
            },
          },
          created_at: usedAt,
        });
      }
    },
    insertPlaybookRevision(input: NewPlaybookRevision): PlaybookRevision {
      const playbook = this.getPlaybookById(input.playbook_id);
      if (!playbook) {
        throw new Error(`Playbook ${input.playbook_id} not found`);
      }
      const now = nowSeconds();
      const result = db
        .prepare(
          `INSERT INTO playbook_revisions
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, playbook_id, instructions, revision_reason, source_session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          playbook.tenant_id, playbook.system_id, playbook.workspace_id, playbook.collaboration_id, playbook.scope_id,
          input.playbook_id, input.instructions, input.revision_reason,
          input.source_session_id ?? null, input.created_at ?? now,
        );
      db.prepare('UPDATE playbooks SET revision_count = revision_count + 1 WHERE id = ?').run(input.playbook_id);
      const row = db.prepare('SELECT * FROM playbook_revisions WHERE id = ?').get(Number(result.lastInsertRowid)) as PlaybookRevision;
      const revision = rowToPlaybookRevision(row);
      insertMemoryEventInternal({
        ...normalizeScope(revision),
        session_id: revision.source_session_id,
        entity_kind: 'playbook_revision',
        entity_id: String(revision.id),
        event_type: 'playbook.revised',
        payload: {
          after: cloneValue(revision),
          refs: {
            playbook_id: revision.playbook_id,
          },
        },
        created_at: revision.created_at,
      });
      return revision;
    },
    getPlaybookRevisions(playbookId: number): PlaybookRevision[] {
      const rows = db
        .prepare('SELECT * FROM playbook_revisions WHERE playbook_id = ? ORDER BY created_at DESC')
        .all(playbookId) as PlaybookRevision[];
      return rows.map(rowToPlaybookRevision);
    },

    insertAssociation(input: NewAssociation): Association {
      const scope = normalizeScope(input);
      const now = nowSeconds();
      let result: Database.RunResult;
      try {
        result = db
          .prepare(
            `INSERT INTO associations
              (tenant_id, system_id, workspace_id, collaboration_id, scope_id,
               source_kind, source_id, target_kind, target_id, association_type, provenance, confidence, auto_generated, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope.tenant_id, scope.system_id, scope.workspace_id, scope.collaboration_id, scope.scope_id,
            input.source_kind, input.source_id, input.target_kind, input.target_id,
            input.association_type, input.provenance ?? 'inferred', input.confidence ?? 0.8,
            input.auto_generated ? 1 : 0, input.created_at ?? now,
          );
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
        ) {
          throw new UniqueConstraintError(
            `Association already exists: ${input.source_kind}:${input.source_id} -> ${input.target_kind}:${input.target_id} (${input.association_type})`,
            err,
          );
        }
        throw err;
      }
      const row = db.prepare('SELECT * FROM associations WHERE id = ?').get(Number(result.lastInsertRowid)) as any;
      const association = {
        ...row,
        collaboration_id: row.collaboration_id ?? row.workspace_id,
        visibility_class: row.visibility_class ?? 'private',
        provenance: row.provenance ?? 'inferred',
        auto_generated: row.auto_generated === 1,
      };
      insertMemoryEventInternal({
        ...scope,
        entity_kind: 'association',
        entity_id: String(association.id),
        event_type: 'association.created',
        payload: {
          after: cloneValue(association),
        },
        created_at: association.created_at,
      });
      return association;
    },
    getAssociationById(id: number): Association | null {
      const row = db.prepare('SELECT * FROM associations WHERE id = ?').get(id) as any;
      if (!row) return null;
      return {
        ...row,
        collaboration_id: row.collaboration_id ?? row.workspace_id,
        auto_generated: row.auto_generated === 1,
      };
    },
    getAssociationsFrom(kind: AssociationTargetKind, id: number, scope) {
      const rows = db
        .prepare(`SELECT * FROM associations WHERE source_kind = ? AND source_id = ? AND ${SCOPE_WHERE} ORDER BY id DESC`)
        .all(kind, id, ...scopeValues(scope)) as any[];
      return rows.map((row) => ({
        ...row,
        collaboration_id: row.collaboration_id ?? row.workspace_id,
        auto_generated: row.auto_generated === 1,
      }));
    },
    getAssociationsTo(kind: AssociationTargetKind, id: number, scope) {
      const rows = db
        .prepare(`SELECT * FROM associations WHERE target_kind = ? AND target_id = ? AND ${SCOPE_WHERE} ORDER BY id DESC`)
        .all(kind, id, ...scopeValues(scope)) as any[];
      return rows.map((row) => ({
        ...row,
        collaboration_id: row.collaboration_id ?? row.workspace_id,
        auto_generated: row.auto_generated === 1,
      }));
    },
    listAssociations(scope) {
      const rows = db
        .prepare(`SELECT * FROM associations WHERE ${SCOPE_WHERE} ORDER BY id DESC`)
        .all(...scopeValues(scope)) as any[];
      return rows.map((row) => ({
        ...row,
        collaboration_id: row.collaboration_id ?? row.workspace_id,
        auto_generated: row.auto_generated === 1,
      }));
    },
    deleteAssociation(id: number): void {
      const before = this.getAssociationById(id);
      db.prepare('DELETE FROM associations WHERE id = ?').run(id);
      if (before) {
        insertMemoryEventInternal({
          ...normalizeScope(before),
          entity_kind: 'association',
          entity_id: String(before.id),
          event_type: 'association.deleted',
          payload: {
            before: cloneValue(before),
          },
          created_at: nowSeconds(),
        });
      }
    },

    insertMemoryEvent(input): MemoryEventRecord {
      return insertMemoryEventInternal(input);
    },

    listMemoryEvents(scope, query): TimelineResult {
      return listScopedMemoryEvents(scope, query);
    },

    listMemoryEventsCrossScope(scope, level, query): TimelineResult {
      return listScopedMemoryEventsCrossScope(scope, level, query);
    },

    getMemoryEventsByEntity(scope, entityKind, entityId, query): TimelineResult {
      return listScopedMemoryEvents(scope, {
        ...query,
        entityKind,
        entityId,
      });
    },

    getMemoryEventsBySession(scope, sessionId, query): TimelineResult {
      return listScopedMemoryEvents(scope, {
        ...query,
        sessionId,
      });
    },

    getSessionState: readSessionStateProjection,

    upsertSessionState(input): SessionStateProjection {
      const projection = writeSessionStateProjection(input);
      insertMemoryEventInternal({
        ...normalizeScope(projection),
        session_id: projection.session_id,
        entity_kind: 'session_state',
        entity_id: projection.session_id,
        event_type: 'session_state.updated',
        payload: {
          after: cloneValue(projection),
        },
        created_at: projection.updatedAt,
      });
      return projection;
    },

    getTemporalWatermark: readTemporalWatermark,

    upsertTemporalWatermark: writeTemporalWatermark,

    insertSourceDocument(input: NewSourceDocument): SourceDocument {
      const n = normalizeScope(input);
      const createdAt = nowSeconds();
      const row = db
        .prepare(
          `INSERT INTO source_documents
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, title, content_hash,
             mime_type, url, metadata, status, fact_count, token_estimate, created_at, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
           RETURNING *`,
        )
        .get(
          ...scopeValues(n),
          input.title,
          input.content_hash,
          input.mime_type ?? 'text/plain',
          input.url ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.status ?? 'pending',
          input.token_estimate ?? 0,
          createdAt,
        ) as Record<string, unknown>;
      return mapSourceDocumentRow(row);
    },

    getSourceDocumentById(id: number): SourceDocument | null {
      const row = db
        .prepare('SELECT * FROM source_documents WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      return row ? mapSourceDocumentRow(row) : null;
    },

    getSourceDocumentByHash(contentHash: string, scope): SourceDocument | null {
      const row = db
        .prepare(`SELECT * FROM source_documents WHERE content_hash = ? AND ${SCOPE_WHERE} LIMIT 1`)
        .get(contentHash, ...scopeValues(normalizeScope(scope))) as Record<string, unknown> | undefined;
      return row ? mapSourceDocumentRow(row) : null;
    },

    listSourceDocuments(scope, options?: PaginationOptions): PaginatedResult<SourceDocument> {
      const n = normalizeScope(scope);
      const limit = options?.limit ?? 50;
      const cursor = typeof options?.cursor === 'number' ? options.cursor : undefined;
      const params: unknown[] = [...scopeValues(n)];
      let where = SCOPE_WHERE;
      if (cursor != null) {
        where += ' AND id < ?';
        params.push(cursor);
      }
      params.push(limit + 1);
      const rows = db
        .prepare(`SELECT * FROM source_documents WHERE ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params) as Array<Record<string, unknown>>;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapSourceDocumentRow);
      return { items, hasMore, nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null };
    },

    updateSourceDocument(id: number, patch: { status?: SourceDocumentStatus; fact_count?: number; processed_at?: number | null }): SourceDocument | null {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) { setClauses.push('status = ?'); values.push(patch.status); }
      if (patch.fact_count !== undefined) { setClauses.push('fact_count = ?'); values.push(patch.fact_count); }
      if (patch.processed_at !== undefined) { setClauses.push('processed_at = ?'); values.push(patch.processed_at); }
      if (setClauses.length === 0) return this.getSourceDocumentById(id);
      values.push(id);
      const row = db
        .prepare(`UPDATE source_documents SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`)
        .get(...values) as Record<string, unknown> | undefined;
      return row ? mapSourceDocumentRow(row) : null;
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    close(): void {
      db.close();
    },
  };
}
