import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { MemoryScope, ScopeLevel } from '../../contracts/identity.js';
import { normalizeScope, widenScope } from '../../contracts/identity.js';
import type { EventHook, Logger } from '../../contracts/observability.js';
import type {
  CompactionLog,
  ContextMonitor,
  ContextMonitorUpsert,
  KnowledgeCandidate,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewCompactionLog,
  NewKnowledgeCandidate,
  NewKnowledgeEvidence,
  NewKnowledgeMemory,
  NewKnowledgeMemoryAudit,
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
import { matchesKnowledgeSearchOptions } from '../../core/retrieval.js';
import { estimateTokens } from '../../core/tokens.js';

export interface PostgresAdapterOptions {
  logger?: Logger;
  onEvent?: EventHook;
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

function scopeParams(scope: MemoryScope): unknown[] {
  const n = normalizeScope(scope);
  return [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id];
}

function scopeWhere(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return `${p}tenant_id = $1 AND ${p}system_id = $2 AND ${p}workspace_id = $3 AND ${p}collaboration_id = $4 AND ${p}scope_id = $5`;
}

function wideScopeWhere(scope: MemoryScope, level: ScopeLevel, prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  const normalized = normalizeScope(scope);
  switch (level) {
    case 'tenant':
      return `${p}tenant_id = $1`;
    case 'system':
      return `${p}tenant_id = $1 AND ${p}system_id = $2`;
    case 'workspace':
      return normalized.collaboration_id.length > 0
        ? `${p}tenant_id = $1 AND ${p}collaboration_id = $2`
        : `${p}tenant_id = $1 AND ${p}system_id = $2 AND ${p}workspace_id = $3`;
    default:
      return scopeWhere(prefix);
  }
}

function wideScopeParams(scope: MemoryScope, level: ScopeLevel): unknown[] {
  const n = normalizeScope(scope);
  switch (level) {
    case 'tenant':
      return [n.tenant_id];
    case 'system':
      return [n.tenant_id, n.system_id];
    case 'workspace':
      return [n.tenant_id, n.collaboration_id];
    default:
      return scopeParams(scope);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function resolvePaginationOptions(options?: PaginationOptions): Required<PaginationOptions> {
  return {
    limit: options?.limit ?? 25,
    offset: options?.offset ?? 0,
    cursor: options?.cursor ?? 0,
  };
}

function mapTurn(row: Record<string, unknown>): Turn {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    actor: String(row.actor),
    role: row.role as Turn['role'],
    content: String(row.content),
    priority: Number(row.priority ?? 1),
    token_estimate: Number(row.token_estimate),
    archived_at: row.archived_at != null ? Number(row.archived_at) : null,
    compaction_log_id: row.compaction_log_id != null ? Number(row.compaction_log_id) : null,
    created_at: Number(row.created_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapWorkingMemory(row: Record<string, unknown>): WorkingMemory {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    summary: String(row.summary),
    key_entities: Array.isArray(row.key_entities) ? row.key_entities : JSON.parse(String(row.key_entities ?? '[]')),
    topic_tags: Array.isArray(row.topic_tags) ? row.topic_tags : JSON.parse(String(row.topic_tags ?? '[]')),
    turn_id_start: Number(row.turn_id_start),
    turn_id_end: Number(row.turn_id_end),
    turn_count: Number(row.turn_count),
    compaction_trigger: row.compaction_trigger as WorkingMemory['compaction_trigger'],
    expires_at: row.expires_at != null ? Number(row.expires_at) : null,
    promoted_to_knowledge_id: row.promoted_to_knowledge_id != null ? Number(row.promoted_to_knowledge_id) : null,
    created_at: Number(row.created_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapKnowledgeMemory(row: Record<string, unknown>): KnowledgeMemory {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeMemory['fact_type'],
    knowledge_state: (row.knowledge_state as KnowledgeMemory['knowledge_state']) ?? 'trusted',
    knowledge_class: (row.knowledge_class as KnowledgeMemory['knowledge_class']) ?? 'project_fact',
    fact_subject: row.fact_subject != null ? String(row.fact_subject) : null,
    fact_attribute: row.fact_attribute != null ? String(row.fact_attribute) : null,
    fact_value: row.fact_value != null ? String(row.fact_value) : null,
    normalized_fact: row.normalized_fact != null ? String(row.normalized_fact) : null,
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    is_negated: Boolean(row.is_negated),
    source: row.source as KnowledgeMemory['source'],
    confidence: row.confidence as KnowledgeMemory['confidence'],
    confidence_score: Number(row.confidence_score ?? 0.5),
    grounding_strength:
      (row.grounding_strength as KnowledgeMemory['grounding_strength']) ?? 'moderate',
    evidence_count: Number(row.evidence_count ?? 0),
    trust_score: Number(row.trust_score ?? 0.5),
    verification_status: (row.verification_status as KnowledgeMemory['verification_status']) ?? 'unverified',
    verification_notes: row.verification_notes != null ? String(row.verification_notes) : null,
    last_verified_at: row.last_verified_at != null ? Number(row.last_verified_at) : null,
    next_reverification_at:
      row.next_reverification_at != null ? Number(row.next_reverification_at) : null,
    last_confirmed_at: row.last_confirmed_at != null ? Number(row.last_confirmed_at) : null,
    confirmation_count: Number(row.confirmation_count ?? 0),
    source_system_id: row.source_system_id != null ? String(row.source_system_id) : null,
    source_scope_id: row.source_scope_id != null ? String(row.source_scope_id) : null,
    source_collaboration_id:
      row.source_collaboration_id != null ? String(row.source_collaboration_id) : null,
    source_working_memory_id: row.source_working_memory_id != null ? Number(row.source_working_memory_id) : null,
    source_turn_ids: Array.isArray(row.source_turn_ids)
      ? row.source_turn_ids.map((value) => Number(value))
      : [],
    successful_use_count: Number(row.successful_use_count ?? 0),
    failed_use_count: Number(row.failed_use_count ?? 0),
    disputed_at: row.disputed_at != null ? Number(row.disputed_at) : null,
    dispute_reason: row.dispute_reason != null ? String(row.dispute_reason) : null,
    contradiction_score: Number(row.contradiction_score ?? 0),
    superseded_at: row.superseded_at != null ? Number(row.superseded_at) : null,
    superseded_by_id: row.superseded_by_id != null ? Number(row.superseded_by_id) : null,
    retired_at: row.retired_at != null ? Number(row.retired_at) : null,
    access_count: Number(row.access_count ?? 0),
    last_accessed_at: Number(row.last_accessed_at ?? 0),
    created_at: Number(row.created_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: row.session_id != null ? String(row.session_id) : null,
    title: String(row.title),
    kind: row.kind as WorkItem['kind'],
    status: row.status as WorkItem['status'],
    detail: row.detail != null ? String(row.detail) : null,
    source_working_memory_id: row.source_working_memory_id != null ? Number(row.source_working_memory_id) : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function mapContextMonitor(row: Record<string, unknown>): ContextMonitor {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    compaction_state: row.compaction_state as ContextMonitor['compaction_state'],
    active_turn_count: Number(row.active_turn_count),
    active_token_estimate: Number(row.active_token_estimate),
    compaction_score: Number(row.compaction_score),
    last_compaction_at: row.last_compaction_at != null ? Number(row.last_compaction_at) : null,
    updated_at: Number(row.updated_at),
  };
}

function mapCompactionLog(row: Record<string, unknown>): CompactionLog {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    trigger_type: row.trigger_type as CompactionLog['trigger_type'],
    turn_id_start: Number(row.turn_id_start),
    turn_id_end: Number(row.turn_id_end),
    turns_compacted: Number(row.turns_compacted),
    tokens_compacted_estimate: Number(row.tokens_compacted_estimate),
    working_memory_id: Number(row.working_memory_id),
    active_turn_count_before: Number(row.active_turn_count_before),
    active_turn_count_after: Number(row.active_turn_count_after),
    duration_ms: Number(row.duration_ms),
    model_call_made: Boolean(row.model_call_made),
    created_at: Number(row.created_at),
  };
}

function mapKnowledgeMemoryAudit(row: Record<string, unknown>): KnowledgeMemoryAudit {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    working_memory_id: Number(row.working_memory_id),
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeMemoryAudit['fact_type'],
    fact_subject: row.fact_subject != null ? String(row.fact_subject) : null,
    fact_attribute: row.fact_attribute != null ? String(row.fact_attribute) : null,
    fact_value: row.fact_value != null ? String(row.fact_value) : null,
    normalized_fact: row.normalized_fact != null ? String(row.normalized_fact) : null,
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    is_negated: Boolean(row.is_negated),
    confidence: row.confidence as KnowledgeMemoryAudit['confidence'],
    confidence_score: Number(row.confidence_score ?? 0.5),
    verification_status:
      (row.verification_status as KnowledgeMemoryAudit['verification_status']) ?? 'unverified',
    source_text: String(row.source_text),
    decision: row.decision as KnowledgeMemoryAudit['decision'],
    detail: row.detail != null ? String(row.detail) : null,
    related_knowledge_id: row.related_knowledge_id != null ? Number(row.related_knowledge_id) : null,
    created_knowledge_id: row.created_knowledge_id != null ? Number(row.created_knowledge_id) : null,
    created_at: Number(row.created_at),
  };
}

function mapKnowledgeCandidate(row: Record<string, unknown>): KnowledgeCandidate {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    working_memory_id: Number(row.working_memory_id),
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeCandidate['fact_type'],
    knowledge_class: row.knowledge_class as KnowledgeCandidate['knowledge_class'],
    normalized_fact: String(row.normalized_fact),
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    confidence: row.confidence as KnowledgeCandidate['confidence'],
    source_summary: Boolean(row.source_summary),
    source_turns: Boolean(row.source_turns),
    grounding_strength: row.grounding_strength as KnowledgeCandidate['grounding_strength'],
    evidence_count: Number(row.evidence_count ?? 0),
    trust_score: Number(row.trust_score ?? 0),
    state: row.state as KnowledgeCandidate['state'],
    created_at: Number(row.created_at),
    promoted_knowledge_id:
      row.promoted_knowledge_id != null ? Number(row.promoted_knowledge_id) : null,
  };
}

function mapKnowledgeEvidenceRow(row: Record<string, unknown>): KnowledgeEvidence {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    knowledge_memory_id: row.knowledge_memory_id != null ? Number(row.knowledge_memory_id) : null,
    knowledge_candidate_id:
      row.knowledge_candidate_id != null ? Number(row.knowledge_candidate_id) : null,
    working_memory_id: row.working_memory_id != null ? Number(row.working_memory_id) : null,
    turn_id: row.turn_id != null ? Number(row.turn_id) : null,
    source_type: row.source_type as KnowledgeEvidence['source_type'],
    support_polarity: row.support_polarity as KnowledgeEvidence['support_polarity'],
    speaker_role:
      row.speaker_role != null ? (row.speaker_role as KnowledgeEvidence['speaker_role']) : null,
    actor: row.actor != null ? String(row.actor) : null,
    excerpt: String(row.excerpt),
    start_offset: row.start_offset != null ? Number(row.start_offset) : null,
    end_offset: row.end_offset != null ? Number(row.end_offset) : null,
    is_explicit: Boolean(row.is_explicit),
    explicitness_score: Number(row.explicitness_score ?? 0),
    outcome: row.outcome != null ? (row.outcome as KnowledgeEvidence['outcome']) : null,
    created_at: Number(row.created_at),
  };
}

/**
 * Creates a PostgreSQL-backed AsyncStorageAdapter.
 *
 * Requires the `pg` package as an optional peer dependency.
 *
 * ```typescript
 * import { createPostgresAdapter } from 'memory-layer/adapters/postgres';
 * import pg from 'pg';
 *
 * const pool = new pg.Pool({ connectionString: 'postgresql://...' });
 * const adapter = createPostgresAdapter(pool);
 * ```
 */
export function createPostgresAdapter(
  pool: PgPool,
  options?: PostgresAdapterOptions,
): AsyncStorageAdapter {
  const now = nowSeconds;

  return {
    async insertTurn(input: NewTurn): Promise<Turn> {
      const n = normalizeScope(input);
      const tokenEst = input.token_estimate ?? estimateTokens(input.content);
      const { rows } = await pool.query(
        `INSERT INTO turns (tenant_id, system_id, workspace_id, scope_id, session_id, actor, role, content, priority, token_estimate, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.session_id, input.actor, input.role, input.content, input.priority ?? (input.role === 'system' ? 1.5 : 1), tokenEst, now()],
      );
      return mapTurn(rows[0]);
    },

    async insertTurns(inputs) {
      return this.transaction(async () => {
        const inserted: Turn[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertTurn(input));
        }
        return inserted;
      });
    },

    async getTurnById(id) {
      const { rows } = await pool.query('SELECT * FROM turns WHERE id = $1', [id]);
      return rows[0] ? mapTurn(rows[0]) : null;
    },

    async getActiveTurns(scope) {
      const params = scopeParams(scope);
      const { rows } = await pool.query(
        `SELECT * FROM turns WHERE ${scopeWhere()} AND status = 'active' ORDER BY id ASC`,
        params,
      );
      return rows.map(mapTurn);
    },

    async getActiveTurnsPaginated(scope, options): Promise<PaginatedResult<Turn>> {
      const resolved = resolvePaginationOptions(options);
      const params = [...scopeParams(scope)];
      let query = `SELECT * FROM turns WHERE ${scopeWhere()} AND status = 'active'`;
      if (resolved.cursor > 0) {
        params.push(resolved.cursor);
        query += ` AND id > $${params.length}`;
      }
      query += ' ORDER BY id ASC';
      params.push(resolved.limit + 1);
      query += ` LIMIT $${params.length}`;
      if (resolved.cursor === 0) {
        params.push(resolved.offset);
        query += ` OFFSET $${params.length}`;
      }
      const { rows } = await pool.query(query, params);
      const items = rows.slice(0, resolved.limit).map(mapTurn);
      return {
        items,
        hasMore: rows.length > resolved.limit,
        nextCursor: rows.length > resolved.limit ? items[items.length - 1]?.id ?? null : null,
      };
    },

    async getTurnsByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM turns WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id ASC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapTurn);
    },

    async searchTurns(scope, queryText, searchOptions) {
      const params = scopeParams(scope);
      const limit = searchOptions?.limit ?? 10;
      params.push(queryText, limit);
      const activeClause = searchOptions?.activeOnly ? ` AND status = 'active'` : '';
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $5)) AS rank
         FROM turns
         WHERE ${scopeWhere()} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $5)
         ORDER BY rank DESC
         LIMIT $6`,
        params,
      );
      return rows.map((row) => ({
        item: mapTurn(row),
        rank: Number(row.rank),
      }));
    },

    async archiveTurn(id, archivedAt, compactionLogId) {
      await pool.query(
        `UPDATE turns SET status = 'archived', archived_at = $2, compaction_log_id = $3 WHERE id = $1`,
        [id, archivedAt, compactionLogId],
      );
    },

    async getArchivedTurnRange(sessionId, startId, endId, scope) {
      const params: unknown[] = [sessionId, startId, endId];
      let query = `SELECT * FROM turns WHERE session_id = $1 AND id >= $2 AND id <= $3 AND status = 'archived'`;
      if (scope) {
        const n = normalizeScope(scope);
        params.push(n.tenant_id, n.system_id, n.workspace_id, n.scope_id);
        query += ` AND tenant_id = $4 AND system_id = $5 AND workspace_id = $6 AND scope_id = $7`;
      }
      query += ' ORDER BY id ASC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapTurn);
    },

    async insertWorkingMemory(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO working_memory (tenant_id, system_id, workspace_id, scope_id, session_id, summary, key_entities, topic_tags, turn_id_start, turn_id_end, turn_count, compaction_trigger, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.session_id, input.summary,
         JSON.stringify(input.key_entities), JSON.stringify(input.topic_tags),
         input.turn_id_start, input.turn_id_end, input.turn_count, input.compaction_trigger, now()],
      );
      return mapWorkingMemory(rows[0]);
    },

    async getWorkingMemoryById(id) {
      const { rows } = await pool.query('SELECT * FROM working_memory WHERE id = $1', [id]);
      return rows[0] ? mapWorkingMemory(rows[0]) : null;
    },

    async getWorkingMemoryBySession(sessionId, scope) {
      if (scope) {
        const params = [...scopeParams(scope), sessionId];
        const { rows } = await pool.query(
          `SELECT * FROM working_memory WHERE ${scopeWhere()} AND session_id = $5 ORDER BY id DESC`,
          params,
        );
        return rows.map(mapWorkingMemory);
      }
      const { rows } = await pool.query(
        'SELECT * FROM working_memory WHERE session_id = $1 ORDER BY id DESC',
        [sessionId],
      );
      return rows.map(mapWorkingMemory);
    },

    async getActiveWorkingMemory(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM working_memory WHERE ${scopeWhere()} AND status = 'active' ORDER BY id DESC`,
        scopeParams(scope),
      );
      return rows.map(mapWorkingMemory);
    },

    async getLatestWorkingMemory(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM working_memory WHERE ${scopeWhere()} AND status = 'active' ORDER BY id DESC LIMIT 1`,
        scopeParams(scope),
      );
      return rows[0] ? mapWorkingMemory(rows[0]) : null;
    },

    async getWorkingMemoryByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM working_memory WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapWorkingMemory);
    },

    async expireWorkingMemory(id) {
      await pool.query(`UPDATE working_memory SET status = 'expired', expires_at = $2 WHERE id = $1`, [id, now()]);
    },

    async markWorkingMemoryPromoted(id, knowledgeMemoryId) {
      await pool.query(`UPDATE working_memory SET promoted_to_knowledge_id = $2 WHERE id = $1`, [id, knowledgeMemoryId]);
    },

    async insertKnowledgeMemory(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_memory (tenant_id, system_id, workspace_id, scope_id, fact, fact_type, knowledge_state, knowledge_class, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated, source, confidence, confidence_score, grounding_strength, evidence_count, trust_score, verification_status, verification_notes, last_verified_at, next_reverification_at, last_confirmed_at, confirmation_count, source_working_memory_id, source_turn_ids, successful_use_count, failed_use_count, disputed_at, dispute_reason, contradiction_score, superseded_at, created_at, last_accessed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $36)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.fact, input.fact_type,
         input.knowledge_state ?? 'trusted', input.knowledge_class ?? 'project_fact',
         input.fact_subject ?? null, input.fact_attribute ?? null, input.fact_value ?? null,
         input.normalized_fact ?? null, input.slot_key ?? null, input.is_negated ?? false,
         input.source, input.confidence ?? 'medium', input.confidence_score ?? 0.5,
         input.grounding_strength ?? 'moderate',
         input.evidence_count ?? Math.max(1, (input.source_turn_ids ?? []).length),
         input.trust_score ?? (input.confidence_score ?? 0.5),
         input.verification_status ?? 'unverified', input.verification_notes ?? null,
         input.last_verified_at ?? null, input.next_reverification_at ?? null,
         input.last_confirmed_at ?? null, input.confirmation_count ?? 0,
         input.source_working_memory_id ?? null, input.source_turn_ids ?? [],
         input.successful_use_count ?? 0, input.failed_use_count ?? 0,
         input.disputed_at ?? null, input.dispute_reason ?? null, input.contradiction_score ?? 0,
         input.superseded_at ?? null, now()],
      );
      return mapKnowledgeMemory(rows[0]);
    },

    async insertKnowledgeMemories(inputs) {
      return this.transaction(async () => {
        const inserted: KnowledgeMemory[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertKnowledgeMemory(input));
        }
        return inserted;
      });
    },

    async insertKnowledgeCandidate(input: NewKnowledgeCandidate): Promise<KnowledgeCandidate> {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_candidate
          (tenant_id, system_id, workspace_id, scope_id, working_memory_id, fact, fact_type,
           knowledge_class, normalized_fact, slot_key, confidence, source_summary, source_turns,
           grounding_strength, evidence_count, trust_score, state, promoted_knowledge_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          n.tenant_id,
          n.system_id,
          n.workspace_id,
          n.scope_id,
          input.working_memory_id,
          input.fact,
          input.fact_type,
          input.knowledge_class,
          input.normalized_fact,
          input.slot_key ?? null,
          input.confidence,
          input.source_summary ?? false,
          input.source_turns ?? true,
          input.grounding_strength ?? 'weak',
          input.evidence_count ?? 0,
          input.trust_score ?? 0,
          input.state ?? 'candidate',
          input.promoted_knowledge_id ?? null,
          input.created_at ?? now(),
        ],
      );
      return mapKnowledgeCandidate(rows[0]);
    },

    async insertKnowledgeCandidates(inputs): Promise<KnowledgeCandidate[]> {
      return this.transaction(async () => {
        const inserted: KnowledgeCandidate[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertKnowledgeCandidate(input));
        }
        return inserted;
      });
    },

    async getKnowledgeCandidateById(id): Promise<KnowledgeCandidate | null> {
      const { rows } = await pool.query('SELECT * FROM knowledge_candidate WHERE id = $1', [id]);
      if (!rows[0]) return null;
      return mapKnowledgeCandidate(rows[0]);
    },

    async listKnowledgeCandidates(scope, options): Promise<KnowledgeCandidate[]> {
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_candidate WHERE ${scopeWhere()} ORDER BY created_at DESC, id DESC`,
        scopeParams(scope),
      );
      return rows
        .map(mapKnowledgeCandidate)
        .filter((item) => !options?.state || options.state.includes(item.state));
    },

    async insertKnowledgeEvidence(input: NewKnowledgeEvidence): Promise<KnowledgeEvidence> {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_evidence
          (tenant_id, system_id, workspace_id, scope_id, knowledge_memory_id, knowledge_candidate_id,
           working_memory_id, turn_id, source_type, support_polarity, speaker_role, actor, excerpt,
           start_offset, end_offset, is_explicit, explicitness_score, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          n.tenant_id, n.system_id, n.workspace_id, n.scope_id,
          input.knowledge_memory_id ?? null, input.knowledge_candidate_id ?? null,
          input.working_memory_id ?? null, input.turn_id ?? null, input.source_type, input.support_polarity,
          input.speaker_role ?? null, input.actor ?? null, input.excerpt, input.start_offset ?? null,
          input.end_offset ?? null, input.is_explicit ?? false, input.explicitness_score ?? 0,
          input.outcome ?? null, input.created_at ?? now(),
        ],
      );
      return mapKnowledgeEvidenceRow(rows[0]);
    },

    async insertKnowledgeEvidenceBatch(inputs): Promise<KnowledgeEvidence[]> {
      return this.transaction(async () => {
        const inserted: KnowledgeEvidence[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertKnowledgeEvidence(input));
        }
        return inserted;
      });
    },

    async listKnowledgeEvidenceForKnowledge(knowledgeId): Promise<KnowledgeEvidence[]> {
      const { rows } = await pool.query(
        'SELECT * FROM knowledge_evidence WHERE knowledge_memory_id = $1 ORDER BY created_at DESC, id DESC',
        [knowledgeId],
      );
      return rows.map(mapKnowledgeEvidenceRow);
    },

    async listKnowledgeEvidenceForCandidate(candidateId): Promise<KnowledgeEvidence[]> {
      const { rows } = await pool.query(
        'SELECT * FROM knowledge_evidence WHERE knowledge_candidate_id = $1 ORDER BY created_at DESC, id DESC',
        [candidateId],
      );
      return rows.map(mapKnowledgeEvidenceRow);
    },

    async promoteKnowledgeCandidate(candidateId, input): Promise<KnowledgeMemory> {
      const knowledge = await this.insertKnowledgeMemory(input);
      await pool.query(
        'UPDATE knowledge_candidate SET promoted_knowledge_id = $1, state = $2 WHERE id = $3',
        [knowledge.id, 'provisional', candidateId],
      );
      return knowledge;
    },

    async getKnowledgeMemoryById(id) {
      const { rows } = await pool.query('SELECT * FROM knowledge_memory WHERE id = $1', [id]);
      return rows[0] ? mapKnowledgeMemory(rows[0]) : null;
    },

    async getActiveKnowledgeMemory(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory WHERE ${scopeWhere()} AND superseded_by_id IS NULL AND retired_at IS NULL ORDER BY last_accessed_at DESC`,
        scopeParams(scope),
      );
      return rows.map(mapKnowledgeMemory);
    },

    async getActiveKnowledgeMemoryPaginated(
      scope,
      options,
    ): Promise<PaginatedResult<KnowledgeMemory>> {
      const resolved = resolvePaginationOptions(options);
      const params = [...scopeParams(scope)];
      let query =
        `SELECT * FROM knowledge_memory WHERE ${scopeWhere()} AND superseded_by_id IS NULL AND retired_at IS NULL`;
      if (resolved.cursor > 0) {
        params.push(resolved.cursor);
        query += ` AND id > $${params.length}`;
      }
      query += ' ORDER BY id ASC';
      params.push(resolved.limit + 1);
      query += ` LIMIT $${params.length}`;
      if (resolved.cursor === 0) {
        params.push(resolved.offset);
        query += ` OFFSET $${params.length}`;
      }
      const { rows } = await pool.query(query, params);
      const items = rows.slice(0, resolved.limit).map(mapKnowledgeMemory);
      return {
        items,
        hasMore: rows.length > resolved.limit,
        nextCursor: rows.length > resolved.limit ? items[items.length - 1]?.id ?? null : null,
      };
    },

    async getActiveKnowledgeCrossScope(scope, level) {
      const params = wideScopeParams(scope, level);
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory WHERE ${wideScopeWhere(scope, level)} AND superseded_by_id IS NULL AND retired_at IS NULL ORDER BY last_accessed_at DESC`,
        params,
      );
      return rows.map(mapKnowledgeMemory);
    },

    async getKnowledgeSince(scope, level, since) {
      const params = [...wideScopeParams(scope, level), since];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory
         WHERE ${wideScopeWhere(scope, level)}
           AND created_at >= $${params.length}
           AND superseded_by_id IS NULL
           AND retired_at IS NULL
         ORDER BY created_at ASC, id ASC`,
        params,
      );
      return rows.map(mapKnowledgeMemory);
    },

    async getKnowledgeByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM knowledge_memory WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapKnowledgeMemory);
    },

    async searchKnowledge(scope, queryText, searchOptions) {
      const params = scopeParams(scope);
      const limit = searchOptions?.limit ?? 10;
      const activeClause = searchOptions?.activeOnly ? ' AND superseded_by_id IS NULL AND retired_at IS NULL' : '';
      params.push(queryText, limit);
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $5)) AS rank
         FROM knowledge_memory
         WHERE ${scopeWhere()} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $5)
         ORDER BY rank DESC
         LIMIT $6`,
        params,
      );
      return rows
        .map((row) => ({
          item: mapKnowledgeMemory(row),
          rank: Number(row.rank),
        }))
        .filter((result) => matchesKnowledgeSearchOptions(result.item, searchOptions))
        .slice(0, limit);
    },

    async searchKnowledgeCrossScope(scope, level, queryText, searchOptions) {
      const params = wideScopeParams(scope, level);
      const limit = searchOptions?.limit ?? 10;
      const activeClause = searchOptions?.activeOnly ? ' AND superseded_by_id IS NULL AND retired_at IS NULL' : '';
      const paramOffset = params.length;
      params.push(queryText, limit);
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $${paramOffset + 1})) AS rank
         FROM knowledge_memory
         WHERE ${wideScopeWhere(scope, level)} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $${paramOffset + 1})
         ORDER BY rank DESC
         LIMIT $${paramOffset + 2}`,
        params,
      );
      return rows
        .map((row) => ({
          item: mapKnowledgeMemory(row),
          rank: Number(row.rank),
        }))
        .filter((result) => matchesKnowledgeSearchOptions(result.item, searchOptions))
        .slice(0, limit);
    },

    async insertKnowledgeMemoryAudit(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_memory_audit (tenant_id, system_id, workspace_id, collaboration_id, scope_id, working_memory_id, fact, fact_type, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated, confidence, confidence_score, verification_status, source_text, decision, detail, related_knowledge_id, created_knowledge_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.working_memory_id,
         input.fact, input.fact_type, input.fact_subject ?? null, input.fact_attribute ?? null,
         input.fact_value ?? null, input.normalized_fact ?? null, input.slot_key ?? null,
         input.is_negated ?? false, input.confidence, input.confidence_score ?? 0.5,
         input.verification_status ?? 'unverified', input.source_text, input.decision,
         input.detail ?? null, input.related_knowledge_id ?? null, input.created_knowledge_id ?? null, now()],
      );
      return mapKnowledgeMemoryAudit(rows[0]);
    },

    async getRecentKnowledgeMemoryAudits(scope, limit = 20) {
      const params = [...scopeParams(scope), limit];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory_audit WHERE ${scopeWhere()} ORDER BY id DESC LIMIT $6`,
        params,
      );
      return rows.map(mapKnowledgeMemoryAudit);
    },

    async getKnowledgeMemoryAuditsForKnowledge(scope, knowledgeId, limit = 20) {
      const params = [...scopeParams(scope), knowledgeId, knowledgeId, limit];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory_audit
         WHERE ${scopeWhere()}
           AND (created_knowledge_id = $6 OR related_knowledge_id = $7)
         ORDER BY id DESC
         LIMIT $8`,
        params,
      );
      return rows.map(mapKnowledgeMemoryAudit);
    },

    async updateKnowledgeMemory(id, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
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
        return this.getKnowledgeMemoryById(id);
      }
      values.push(id);
      const { rows } = await pool.query(
        `UPDATE knowledge_memory SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values,
      );
      return rows[0] ? mapKnowledgeMemory(rows[0]) : null;
    },

    async touchKnowledgeMemory(id) {
      await pool.query(
        `UPDATE knowledge_memory SET access_count = access_count + 1, last_accessed_at = $2 WHERE id = $1`,
        [id, now()],
      );
    },

    async retireKnowledgeMemory(id, retiredAt) {
      await pool.query(
        `UPDATE knowledge_memory SET retired_at = $2 WHERE id = $1`,
        [id, retiredAt ?? now()],
      );
    },

    async supersedeKnowledgeMemory(oldId, newId) {
      await pool.query(
        `UPDATE knowledge_memory
         SET superseded_by_id = $2, superseded_at = $3, knowledge_state = 'superseded', retired_at = $3
         WHERE id = $1`,
        [oldId, newId, now()],
      );
    },

    async insertWorkItem(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO work_items (tenant_id, system_id, workspace_id, scope_id, session_id, title, kind, status, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.session_id,
         input.title, input.kind ?? 'objective', input.status ?? 'open', input.detail ?? null, now()],
      );
      return mapWorkItem(rows[0]);
    },

    async getActiveWorkItems(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM work_items WHERE ${scopeWhere()} AND status != 'done' ORDER BY id DESC`,
        scopeParams(scope),
      );
      return rows.map(mapWorkItem);
    },

    async getWorkItemsByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM work_items WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapWorkItem);
    },

    async updateWorkItemStatus(id, status) {
      await pool.query(`UPDATE work_items SET status = $2, updated_at = $3 WHERE id = $1`, [id, status, now()]);
    },

    async deleteWorkItem(id) {
      await pool.query('DELETE FROM work_items WHERE id = $1', [id]);
    },

    async upsertContextMonitor(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO context_monitor (tenant_id, system_id, workspace_id, collaboration_id, scope_id, compaction_state, active_turn_count, active_token_estimate, compaction_score, last_compaction_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, system_id, workspace_id, collaboration_id, scope_id)
         DO UPDATE SET compaction_state = $6, active_turn_count = $7, active_token_estimate = $8, compaction_score = $9, last_compaction_at = COALESCE($10, context_monitor.last_compaction_at), updated_at = $11
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id,
         input.compaction_state, input.active_turn_count, input.active_token_estimate,
         input.compaction_score, input.last_compaction_at ?? null, now()],
      );
      return mapContextMonitor(rows[0]);
    },

    async getContextMonitor(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM context_monitor WHERE ${scopeWhere()}`,
        scopeParams(scope),
      );
      return rows[0] ? mapContextMonitor(rows[0]) : null;
    },

    async insertCompactionLog(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO compaction_log (tenant_id, system_id, workspace_id, scope_id, session_id, trigger_type, turn_id_start, turn_id_end, turns_compacted, tokens_compacted_estimate, working_memory_id, active_turn_count_before, active_turn_count_after, duration_ms, model_call_made, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.session_id,
         input.trigger_type, input.turn_id_start, input.turn_id_end,
         input.turns_compacted, input.tokens_compacted_estimate, input.working_memory_id,
         input.active_turn_count_before, input.active_turn_count_after,
         input.duration_ms, input.model_call_made, now()],
      );
      return mapCompactionLog(rows[0]);
    },

    async getCompactionLogById(id) {
      const { rows } = await pool.query('SELECT * FROM compaction_log WHERE id = $1', [id]);
      return rows[0] ? mapCompactionLog(rows[0]) : null;
    },

    async getRecentCompactionLogs(scope, limit = 10) {
      const params = [...scopeParams(scope), limit];
      const { rows } = await pool.query(
        `SELECT * FROM compaction_log WHERE ${scopeWhere()} ORDER BY id DESC LIMIT $5`,
        params,
      );
      return rows.map(mapCompactionLog);
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      await pool.query('BEGIN');
      try {
        const result = await fn();
        await pool.query('COMMIT');
        return result;
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    },

    async close() {
      await pool.end();
    },
  };
}
