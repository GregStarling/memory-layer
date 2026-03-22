import { normalizeScope, type MemoryScope, type ScopeLevel } from '../../contracts/identity.js';
import type { StorageAdapter } from '../../contracts/storage.js';
import type {
  CompactionLog,
  ContextMonitor,
  ContextMonitorUpsert,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewCompactionLog,
  NewKnowledgeMemory,
  NewKnowledgeMemoryAudit,
  NewTurn,
  NewWorkItem,
  NewWorkingMemory,
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
  validateNewKnowledgeMemory,
  validateNewKnowledgeMemoryAudit,
  validateNewTurn,
  validateNewWorkItem,
  validateNewWorkingMemory,
  validateTimeRange,
} from '../../core/validation.js';

const SCHEMA_VERSION = 1;

interface MemoryState {
  turns: Turn[];
  workingMemory: WorkingMemory[];
  knowledgeMemory: KnowledgeMemory[];
  knowledgeAudits: KnowledgeMemoryAudit[];
  workItems: WorkItem[];
  contextMonitors: ContextMonitor[];
  compactionLogs: CompactionLog[];
}

function matchesScope(item: MemoryScope, scope: MemoryScope): boolean {
  const left = normalizeScope(item);
  const right = normalizeScope(scope);
  return (
    left.tenant_id === right.tenant_id &&
    left.system_id === right.system_id &&
    left.workspace_id === right.workspace_id &&
    left.scope_id === right.scope_id
  );
}

function matchesLevel(item: MemoryScope, scope: MemoryScope, level: ScopeLevel): boolean {
  const left = normalizeScope(item);
  const right = normalizeScope(scope);
  if (left.tenant_id !== right.tenant_id) return false;
  if (level === 'tenant') return true;
  if (left.system_id !== right.system_id) return false;
  if (level === 'system') return true;
  if (left.workspace_id !== right.workspace_id) return false;
  if (level === 'workspace') return true;
  return left.scope_id === right.scope_id;
}

function inRange(createdAt: number, range: TimeRange): boolean {
  validateTimeRange(range);
  if (range.start_at !== undefined && createdAt < range.start_at) return false;
  if (range.end_at !== undefined && createdAt > range.end_at) return false;
  return true;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0);
}

function scoreText(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  const textTokens = new Set(tokenize(text));
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) matches += 1;
  }
  if (matches === 0) return 0;
  const containsWhole = text.toLowerCase().includes(query.toLowerCase()) ? 0.25 : 0;
  return matches / queryTokens.size + containsWhole;
}

function resolveSearchOptions(options?: SearchOptions): Required<SearchOptions> {
  return {
    limit: options?.limit ?? 10,
    activeOnly: options?.activeOnly ?? true,
  };
}

export function createInMemoryAdapter(telemetry?: TelemetryOptions): StorageAdapter {
  const state: MemoryState = {
    turns: [],
    workingMemory: [],
    knowledgeMemory: [],
    knowledgeAudits: [],
    workItems: [],
    contextMonitors: [],
    compactionLogs: [],
  };

  const ids = {
    turn: 1,
    workingMemory: 1,
    knowledgeMemory: 1,
    knowledgeAudit: 1,
    workItem: 1,
    contextMonitor: 1,
    compactionLog: 1,
  };

  return {
    insertTurn(input: NewTurn): Turn {
      const scope = validateNewTurn(input);
      const turn: Turn = {
        ...scope,
        id: ids.turn++,
        session_id: input.session_id,
        actor: input.actor,
        role: input.role,
        content: input.content,
        token_estimate: input.token_estimate ?? estimateTokens(input.content),
        created_at: input.created_at ?? nowSeconds(),
        archived_at: null,
        compaction_log_id: null,
        schema_version: SCHEMA_VERSION,
      };
      state.turns.push(turn);
      return turn;
    },

    getTurnById(id) {
      return state.turns.find((turn) => turn.id === id) ?? null;
    },

    getActiveTurns(scope) {
      return state.turns.filter((turn) => matchesScope(turn, scope) && turn.archived_at === null);
    },

    getTurnsByTimeRange(scope, range) {
      return state.turns.filter((turn) => matchesScope(turn, scope) && inRange(turn.created_at, range));
    },

    searchTurns(scope, query, options) {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      const results = state.turns
        .filter((turn) => matchesScope(turn, scope) && (!resolved.activeOnly || turn.archived_at === null))
        .map((turn) => ({
          item: turn,
          rank: scoreText(query, turn.content),
        }))
        .filter((result) => result.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.created_at - a.item.created_at)
        .slice(0, resolved.limit);
      emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
        entity: 'turn',
        query,
        resultCount: results.length,
      });
      return results;
    },

    archiveTurn(id, archivedAt, compactionLogId) {
      assertArchiveInput(id, archivedAt, compactionLogId);
      const turn = state.turns.find((item) => item.id === id);
      if (!turn) return;
      turn.archived_at = archivedAt;
      turn.compaction_log_id = compactionLogId;
    },

    getArchivedTurnRange(sessionId, startId, endId, scope) {
      return state.turns.filter(
        (turn) =>
          turn.session_id === sessionId &&
          turn.id >= startId &&
          turn.id <= endId &&
          turn.archived_at !== null &&
          (!scope || matchesScope(turn, scope)),
      );
    },

    insertWorkingMemory(input: NewWorkingMemory): WorkingMemory {
      const scope = validateNewWorkingMemory(input);
      const createdAt = nowSeconds();
      const record: WorkingMemory = {
        ...scope,
        id: ids.workingMemory++,
        session_id: input.session_id,
        summary: input.summary,
        key_entities: [...input.key_entities],
        topic_tags: [...input.topic_tags],
        turn_id_start: input.turn_id_start,
        turn_id_end: input.turn_id_end,
        turn_count: input.turn_count,
        compaction_trigger: input.compaction_trigger,
        created_at: createdAt,
        expires_at: input.expires_at ?? createdAt + 86400,
        promoted_to_knowledge_id: null,
        schema_version: SCHEMA_VERSION,
      };
      state.workingMemory.push(record);
      return record;
    },

    getWorkingMemoryById(id) {
      return state.workingMemory.find((item) => item.id === id) ?? null;
    },

    getWorkingMemoryBySession(sessionId, scope) {
      return state.workingMemory.filter(
        (item) => item.session_id === sessionId && (!scope || matchesScope(item, scope)),
      );
    },

    getActiveWorkingMemory(scope) {
      const now = nowSeconds();
      return state.workingMemory.filter(
        (item) =>
          matchesScope(item, scope) && (item.expires_at === null || item.expires_at > now),
      );
    },

    getLatestWorkingMemory(scope) {
      return (
        this.getActiveWorkingMemory(scope).sort((a, b) => b.id - a.id)[0] ?? null
      );
    },

    getWorkingMemoryByTimeRange(scope, range) {
      return state.workingMemory.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      );
    },

    expireWorkingMemory(id) {
      const item = state.workingMemory.find((entry) => entry.id === id);
      if (item) item.expires_at = nowSeconds();
    },

    markWorkingMemoryPromoted(id, knowledgeMemoryId) {
      const item = state.workingMemory.find((entry) => entry.id === id);
      if (item) item.promoted_to_knowledge_id = knowledgeMemoryId;
    },

    insertKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory {
      const scope = validateNewKnowledgeMemory(input);
      const createdAt = nowSeconds();
      const record: KnowledgeMemory = {
        ...scope,
        id: ids.knowledgeMemory++,
        fact: input.fact,
        fact_type: input.fact_type,
        fact_subject: input.fact_subject ?? null,
        fact_attribute: input.fact_attribute ?? null,
        fact_value: input.fact_value ?? null,
        normalized_fact: input.normalized_fact ?? null,
        slot_key: input.slot_key ?? null,
        is_negated: input.is_negated ?? false,
        source: input.source,
        confidence: input.confidence,
        source_working_memory_id: input.source_working_memory_id ?? null,
        superseded_by_id: null,
        retired_at: input.retired_at ?? null,
        created_at: createdAt,
        last_accessed_at: createdAt,
        access_count: 1,
        schema_version: SCHEMA_VERSION,
      };
      state.knowledgeMemory.push(record);
      return record;
    },

    getKnowledgeMemoryById(id) {
      return state.knowledgeMemory.find((item) => item.id === id) ?? null;
    },

    getActiveKnowledgeMemory(scope) {
      return state.knowledgeMemory.filter(
        (item) =>
          matchesScope(item, scope) && item.superseded_by_id === null && item.retired_at === null,
      );
    },

    getActiveKnowledgeCrossScope(scope, level) {
      return state.knowledgeMemory.filter(
        (item) =>
          matchesLevel(item, scope, level) &&
          item.superseded_by_id === null &&
          item.retired_at === null,
      );
    },

    getKnowledgeByTimeRange(scope, range) {
      return state.knowledgeMemory.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      );
    },

    searchKnowledge(scope, query, options) {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      const results = state.knowledgeMemory
        .filter(
          (item) =>
            matchesScope(item, scope) &&
            (!resolved.activeOnly ||
              (item.superseded_by_id === null && item.retired_at === null)),
        )
        .map((item) => ({
          item,
          rank: scoreText(query, item.fact),
        }))
        .filter((result) => result.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
        .slice(0, resolved.limit);
      emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
        entity: 'knowledge',
        query,
        resultCount: results.length,
      });
      return results;
    },

    searchKnowledgeCrossScope(scope, level, query, options) {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      const results = state.knowledgeMemory
        .filter(
          (item) =>
            matchesLevel(item, scope, level) &&
            (!resolved.activeOnly ||
              (item.superseded_by_id === null && item.retired_at === null)),
        )
        .map((item) => ({
          item,
          rank: scoreText(query, item.fact),
        }))
        .filter((result) => result.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
        .slice(0, resolved.limit);
      emitMemoryEvent('search', scope, telemetry, Date.now() - startedAt, {
        entity: 'knowledge',
        query,
        resultCount: results.length,
        scopeLevel: level,
      });
      return results;
    },

    insertKnowledgeMemoryAudit(input: NewKnowledgeMemoryAudit): KnowledgeMemoryAudit {
      const scope = validateNewKnowledgeMemoryAudit(input);
      const record: KnowledgeMemoryAudit = {
        ...scope,
        id: ids.knowledgeAudit++,
        working_memory_id: input.working_memory_id ?? null,
        fact: input.fact,
        fact_type: input.fact_type,
        fact_subject: input.fact_subject ?? null,
        fact_attribute: input.fact_attribute ?? null,
        fact_value: input.fact_value ?? null,
        normalized_fact: input.normalized_fact ?? null,
        slot_key: input.slot_key ?? null,
        is_negated: input.is_negated ?? false,
        confidence: input.confidence,
        source_text: input.source_text ?? null,
        decision: input.decision,
        created_knowledge_id: input.created_knowledge_id ?? null,
        related_knowledge_id: input.related_knowledge_id ?? null,
        detail: input.detail ?? null,
        created_at: input.created_at ?? nowSeconds(),
      };
      state.knowledgeAudits.push(record);
      return record;
    },

    getRecentKnowledgeMemoryAudits(scope, limit = 10) {
      return state.knowledgeAudits
        .filter((item) => matchesScope(item, scope))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    },

    touchKnowledgeMemory(id) {
      const item = state.knowledgeMemory.find((entry) => entry.id === id);
      if (!item) return;
      item.last_accessed_at = nowSeconds();
      item.access_count += 1;
    },

    retireKnowledgeMemory(id, retiredAt = nowSeconds()) {
      const item = state.knowledgeMemory.find((entry) => entry.id === id);
      if (item) item.retired_at = retiredAt;
    },

    supersedeKnowledgeMemory(oldId, newId) {
      const item = state.knowledgeMemory.find((entry) => entry.id === oldId);
      if (item) item.superseded_by_id = newId;
    },

    insertWorkItem(input: NewWorkItem): WorkItem {
      const scope = validateNewWorkItem(input);
      const createdAt = input.created_at ?? nowSeconds();
      const item: WorkItem = {
        ...scope,
        id: ids.workItem++,
        session_id: input.session_id ?? null,
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? null,
        status: input.status ?? 'open',
        source_working_memory_id: input.source_working_memory_id ?? null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      state.workItems.push(item);
      return item;
    },

    getActiveWorkItems(scope) {
      return state.workItems.filter(
        (item) => matchesScope(item, scope) && item.status !== 'done',
      );
    },

    getWorkItemsByTimeRange(scope, range) {
      return state.workItems.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      );
    },

    updateWorkItemStatus(id, status) {
      const item = state.workItems.find((entry) => entry.id === id);
      if (!item) return;
      item.status = status;
      item.updated_at = nowSeconds();
    },

    deleteWorkItem(id) {
      const index = state.workItems.findIndex((item) => item.id === id);
      if (index >= 0) state.workItems.splice(index, 1);
    },

    upsertContextMonitor(input: ContextMonitorUpsert): ContextMonitor {
      const scope = validateContextMonitorUpsert(input);
      const existing = state.contextMonitors.find((item) => matchesScope(item, scope));
      if (existing) {
        existing.compaction_state = input.compaction_state;
        existing.last_compaction_at = input.last_compaction_at ?? null;
        existing.active_turn_count = input.active_turn_count;
        existing.active_token_estimate = input.active_token_estimate;
        existing.compaction_score = input.compaction_score;
        existing.updated_at = nowSeconds();
        return existing;
      }

      const monitor: ContextMonitor = {
        ...scope,
        id: ids.contextMonitor++,
        compaction_state: input.compaction_state,
        last_compaction_at: input.last_compaction_at ?? null,
        active_turn_count: input.active_turn_count,
        active_token_estimate: input.active_token_estimate,
        compaction_score: input.compaction_score,
        updated_at: nowSeconds(),
      };
      state.contextMonitors.push(monitor);
      return monitor;
    },

    getContextMonitor(scope) {
      return state.contextMonitors.find((item) => matchesScope(item, scope)) ?? null;
    },

    insertCompactionLog(input: NewCompactionLog): CompactionLog {
      const scope = validateNewCompactionLog(input);
      const item: CompactionLog = {
        ...scope,
        id: ids.compactionLog++,
        session_id: input.session_id,
        trigger_type: input.trigger_type,
        turn_id_start: input.turn_id_start,
        turn_id_end: input.turn_id_end,
        turns_compacted: input.turns_compacted,
        tokens_compacted_estimate: input.tokens_compacted_estimate,
        working_memory_id: input.working_memory_id,
        active_turn_count_before: input.active_turn_count_before,
        active_turn_count_after: input.active_turn_count_after,
        duration_ms: input.duration_ms,
        model_call_made: input.model_call_made ?? true,
        error: input.error ?? null,
        created_at: input.created_at ?? nowSeconds(),
      };
      state.compactionLogs.push(item);
      return item;
    },

    getCompactionLogById(id) {
      return state.compactionLogs.find((item) => item.id === id) ?? null;
    },

    getRecentCompactionLogs(scope, limit = 10) {
      return state.compactionLogs
        .filter((item) => matchesScope(item, scope))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    },

    transaction(fn) {
      return fn();
    },

    close() {},
  };
}
