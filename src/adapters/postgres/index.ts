import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { MemoryScope, ScopeLevel } from '../../contracts/identity.js';
import { normalizeScope, widenScope } from '../../contracts/identity.js';
import type { EventHook, Logger } from '../../contracts/observability.js';
import type {
  CompactionLog,
  ContextMonitor,
  ContextMonitorUpsert,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewCompactionLog,
  NewKnowledgeMemory,
  NewKnowledgeMemoryAudit,
  NewWorkItem,
  NewTurn,
  NewWorkingMemory,
  SearchOptions,
  SearchResult,
  TimeRange,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';
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
  return [n.tenant_id, n.system_id, n.workspace_id, n.scope_id];
}

function scopeWhere(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return `${p}tenant_id = $1 AND ${p}system_id = $2 AND ${p}workspace_id = $3 AND ${p}scope_id = $4`;
}

function wideScopeWhere(level: ScopeLevel, prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  switch (level) {
    case 'tenant':
      return `${p}tenant_id = $1`;
    case 'system':
      return `${p}tenant_id = $1 AND ${p}system_id = $2`;
    case 'workspace':
      return `${p}tenant_id = $1 AND ${p}system_id = $2 AND ${p}workspace_id = $3`;
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
      return [n.tenant_id, n.system_id, n.workspace_id];
    default:
      return scopeParams(scope);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mapTurn(row: Record<string, unknown>): Turn {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    actor: String(row.actor),
    role: row.role as Turn['role'],
    content: String(row.content),
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
    scope_id: String(row.scope_id),
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeMemory['fact_type'],
    fact_subject: row.fact_subject != null ? String(row.fact_subject) : null,
    fact_attribute: row.fact_attribute != null ? String(row.fact_attribute) : null,
    fact_value: row.fact_value != null ? String(row.fact_value) : null,
    normalized_fact: row.normalized_fact != null ? String(row.normalized_fact) : null,
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    is_negated: Boolean(row.is_negated),
    source: row.source as KnowledgeMemory['source'],
    confidence: row.confidence as KnowledgeMemory['confidence'],
    source_working_memory_id: row.source_working_memory_id != null ? Number(row.source_working_memory_id) : null,
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
    source_text: String(row.source_text),
    decision: row.decision as KnowledgeMemoryAudit['decision'],
    detail: row.detail != null ? String(row.detail) : null,
    related_knowledge_id: row.related_knowledge_id != null ? Number(row.related_knowledge_id) : null,
    created_knowledge_id: row.created_knowledge_id != null ? Number(row.created_knowledge_id) : null,
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
      const tokenEst = estimateTokens(input.content);
      const { rows } = await pool.query(
        `INSERT INTO turns (tenant_id, system_id, workspace_id, scope_id, session_id, actor, role, content, token_estimate, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.session_id, input.actor, input.role, input.content, tokenEst, now()],
      );
      return mapTurn(rows[0]);
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
        `INSERT INTO knowledge_memory (tenant_id, system_id, workspace_id, scope_id, fact, fact_type, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated, source, confidence, source_working_memory_id, created_at, last_accessed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.fact, input.fact_type,
         input.fact_subject ?? null, input.fact_attribute ?? null, input.fact_value ?? null,
         input.normalized_fact ?? null, input.slot_key ?? null, input.is_negated ?? false,
         input.source, input.confidence ?? 'medium', input.source_working_memory_id ?? null, now()],
      );
      return mapKnowledgeMemory(rows[0]);
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

    async getActiveKnowledgeCrossScope(scope, level) {
      const params = wideScopeParams(scope, level);
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory WHERE ${wideScopeWhere(level)} AND superseded_by_id IS NULL AND retired_at IS NULL ORDER BY last_accessed_at DESC`,
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
      return rows.map((row) => ({
        item: mapKnowledgeMemory(row),
        rank: Number(row.rank),
      }));
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
         WHERE ${wideScopeWhere(level)} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $${paramOffset + 1})
         ORDER BY rank DESC
         LIMIT $${paramOffset + 2}`,
        params,
      );
      return rows.map((row) => ({
        item: mapKnowledgeMemory(row),
        rank: Number(row.rank),
      }));
    },

    async insertKnowledgeMemoryAudit(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_memory_audit (tenant_id, system_id, workspace_id, scope_id, working_memory_id, fact, fact_type, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated, confidence, source_text, decision, detail, related_knowledge_id, created_knowledge_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id, input.working_memory_id,
         input.fact, input.fact_type, input.fact_subject ?? null, input.fact_attribute ?? null,
         input.fact_value ?? null, input.normalized_fact ?? null, input.slot_key ?? null,
         input.is_negated ?? false, input.confidence, input.source_text, input.decision,
         input.detail ?? null, input.related_knowledge_id ?? null, input.created_knowledge_id ?? null, now()],
      );
      return mapKnowledgeMemoryAudit(rows[0]);
    },

    async getRecentKnowledgeMemoryAudits(scope, limit = 20) {
      const params = [...scopeParams(scope), limit];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory_audit WHERE ${scopeWhere()} ORDER BY id DESC LIMIT $5`,
        params,
      );
      return rows.map(mapKnowledgeMemoryAudit);
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
        `UPDATE knowledge_memory SET superseded_by_id = $2, retired_at = $3 WHERE id = $1`,
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
        `INSERT INTO context_monitor (tenant_id, system_id, workspace_id, scope_id, compaction_state, active_turn_count, active_token_estimate, compaction_score, last_compaction_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, system_id, workspace_id, scope_id)
         DO UPDATE SET compaction_state = $5, active_turn_count = $6, active_token_estimate = $7, compaction_score = $8, last_compaction_at = COALESCE($9, context_monitor.last_compaction_at), updated_at = $10
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.scope_id,
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
