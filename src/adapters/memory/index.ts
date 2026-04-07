import {
  matchesScope,
  matchesScopeLevel,
  normalizeScope,
  type MemoryScope,
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
import type { SessionState } from '../../contracts/session-state.js';
import {
  compareTemporalIds,
  normalizeTemporalId,
} from '../../contracts/temporal.js';
import type {
  TemporalId,
  MemoryEventEntityKind,
  MemoryEventQuery,
  MemoryEventRecord,
  MemoryEventType,
  NewSessionStateProjection,
  SessionStateProjection,
  TemporalProjectionWatermark,
  TimelineResult,
} from '../../contracts/temporal.js';
import type {
  Association,
  CompactionLog,
  ContextMonitor,
  ContextMonitorUpsert,
  KnowledgeCandidate,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewAssociation,
  NewCompactionLog,
  NewKnowledgeCandidate,
  NewKnowledgeEvidence,
  NewKnowledgeMemory,
  NewKnowledgeMemoryAudit,
  NewPlaybook,
  NewPlaybookRevision,
  NewTurn,
  NewWorkItem,
  NewWorkingMemory,
  Playbook,
  PlaybookRevision,
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
  assertActorRef,
  assertArchiveInput,
  assertMemoryVisibilityClass,
  nowSeconds,
  validateContextMonitorUpsert,
  validateNewCompactionLog,
  validateNewKnowledgeCandidate,
  validateNewKnowledgeEvidence,
  validateNewKnowledgeMemory,
  validateNewKnowledgeMemoryAudit,
  validateNewTurn,
  validateNewWorkItem,
  validateNewWorkingMemory,
  validateTimeRange,
} from '../../core/validation.js';
import { createInMemoryEmbeddingAdapter } from './embeddings.js';

const SCHEMA_VERSION = 1;

interface MemoryState {
  turns: Turn[];
  workingMemory: WorkingMemory[];
  knowledgeMemory: KnowledgeMemory[];
  knowledgeCandidates: KnowledgeCandidate[];
  knowledgeEvidence: KnowledgeEvidence[];
  knowledgeAudits: KnowledgeMemoryAudit[];
  workItems: WorkItem[];
  workClaims: WorkClaim[];
  handoffs: HandoffRecord[];
  contextMonitors: ContextMonitor[];
  compactionLogs: CompactionLog[];
  playbooks: Playbook[];
  playbookRevisions: PlaybookRevision[];
  associations: Association[];
  memoryEvents: MemoryEventRecord[];
  sessionStates: SessionStateProjection[];
  projectionWatermarks: TemporalProjectionWatermark[];
}

function matchesScopedSession(
  item: MemoryScope & { session_id?: string | null },
  scope: MemoryScope,
  sessionId?: string,
): boolean {
  return matchesScope(item, scope) && (sessionId == null || item.session_id === sessionId);
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

function paginateItems<T extends { id: number }>(
  items: T[],
  options?: PaginationOptions,
): PaginatedResult<T> {
  const resolved = resolvePaginationOptions(options);
  const ordered = [...items].sort((a, b) => a.id - b.id);
  const filtered =
    resolved.cursor > 0 ? ordered.filter((item) => item.id > resolved.cursor) : ordered.slice(resolved.offset);
  const page = filtered.slice(0, resolved.limit + 1);
  const hasMore = page.length > resolved.limit;
  const itemsPage = hasMore ? page.slice(0, resolved.limit) : page;
  return {
    items: itemsPage,
    hasMore,
    nextCursor: hasMore ? itemsPage[itemsPage.length - 1]?.id ?? null : null,
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function filterExistingIds<T extends { id: number }>(items: T[], ids: number[]): number[] {
  const existing = new Set(items.map((item) => item.id));
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.filter((id) => existing.has(id));
}

function normalizeEventQuery(query?: MemoryEventQuery): {
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

function matchesEventScope(item: MemoryEventRecord, scope: MemoryScope): boolean {
  return matchesScope(item, scope);
}

function matchesActor(
  actor: Pick<ActorRef, 'actor_kind' | 'actor_id'>,
  target: ActorRef,
): boolean {
  return actor.actor_kind === target.actor_kind && actor.actor_id === target.actor_id;
}

function makeClaimToken(): string {
  return `claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isClaimExpired(claim: WorkClaim, now = nowSeconds()): boolean {
  return claim.status === 'active' && claim.expires_at <= now;
}

function isHandoffExpired(handoff: HandoffRecord, now = nowSeconds()): boolean {
  return handoff.status === 'pending' && handoff.expires_at != null && handoff.expires_at <= now;
}

function matchesEventQuery(item: MemoryEventRecord, query?: MemoryEventQuery): boolean {
  const resolved = normalizeEventQuery(query);
  if (resolved.cursor != null && compareTemporalIds(item.event_id, resolved.cursor) <= 0) {
    return false;
  }
  if (item.created_at < resolved.startAt || item.created_at > resolved.endAt) return false;
  if (resolved.sessionId && item.session_id !== resolved.sessionId) return false;
  if (resolved.entityKind && item.entity_kind !== resolved.entityKind) return false;
  if (resolved.entityId && item.entity_id !== resolved.entityId) return false;
  return true;
}

function paginateEvents(
  items: MemoryEventRecord[],
  query?: MemoryEventQuery,
): TimelineResult {
  const resolved = normalizeEventQuery(query);
  const ordered = [...items].sort(
    (a, b) => a.created_at - b.created_at || compareTemporalIds(a.event_id, b.event_id),
  );
  const page = ordered.slice(0, resolved.limit + 1);
  const hasMore = page.length > resolved.limit;
  const events = hasMore ? page.slice(0, resolved.limit) : page;
  return {
    events,
    nextCursor: hasMore ? events[events.length - 1]?.event_id ?? null : null,
  };
}

export function createInMemoryAdapter(telemetry?: TelemetryOptions): StorageAdapter {
  const state: MemoryState = {
    turns: [],
    workingMemory: [],
    knowledgeMemory: [],
    knowledgeCandidates: [],
    knowledgeEvidence: [],
    knowledgeAudits: [],
    workItems: [],
    workClaims: [],
    handoffs: [],
    contextMonitors: [],
    compactionLogs: [],
    playbooks: [],
    playbookRevisions: [],
    associations: [],
    memoryEvents: [],
    sessionStates: [],
    projectionWatermarks: [
      {
        projection_name: 'temporal',
        last_event_id: '0',
        updated_at: nowSeconds(),
        cutover_at: nowSeconds(),
        metadata: null,
      },
    ],
  };

  const ids = {
    turn: 1,
    workingMemory: 1,
    knowledgeMemory: 1,
    knowledgeCandidate: 1,
    knowledgeEvidence: 1,
    knowledgeAudit: 1,
    workItem: 1,
    workClaim: 1,
    handoff: 1,
    contextMonitor: 1,
    compactionLog: 1,
    playbook: 1,
    playbookRevision: 1,
    association: 1,
    memoryEvent: 1,
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
        priority: input.priority ?? (input.role === 'system' ? 1.5 : 1),
        token_estimate: input.token_estimate ?? estimateTokens(input.content),
        created_at: input.created_at ?? nowSeconds(),
        archived_at: null,
        compaction_log_id: null,
        schema_version: SCHEMA_VERSION,
      };
      state.turns.push(turn);
      this.insertMemoryEvent({
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
    },

    insertTurns(inputs) {
      return inputs.map((input) => this.insertTurn(input));
    },

    getTurnById(id) {
      return state.turns.find((turn) => turn.id === id) ?? null;
    },

    getActiveTurns(scope, sessionId) {
      return state.turns.filter(
        (turn) => matchesScopedSession(turn, scope, sessionId) && turn.archived_at === null,
      );
    },

    getActiveTurnsPaginated(scope, options) {
      return paginateItems(
        state.turns.filter((turn) => matchesScope(turn, scope) && turn.archived_at === null),
        options,
      );
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
      const before = cloneValue(turn);
      turn.archived_at = archivedAt;
      turn.compaction_log_id = compactionLogId;
      this.insertMemoryEvent({
        ...normalizeScope(turn),
        session_id: turn.session_id,
        actor_id: turn.actor,
        entity_kind: 'turn',
        entity_id: String(turn.id),
        event_type: 'turn.archived',
        payload: {
          before,
          after: cloneValue(turn),
          patch: {
            archived_at: archivedAt,
            compaction_log_id: compactionLogId,
          },
        },
        created_at: archivedAt,
      });
    },

    getArchivedTurnRange(sessionId, startId, endId, scope) {
      return state.turns.filter(
        (turn) =>
          turn.session_id === sessionId &&
          turn.id >= startId &&
          turn.id <= endId &&
          turn.archived_at !== null &&
          matchesScope(turn, scope),
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
        episode_recap: input.episode_recap ?? null,
        schema_version: SCHEMA_VERSION,
      };
      state.workingMemory.push(record);
      this.insertMemoryEvent({
        ...scope,
        session_id: record.session_id,
        entity_kind: 'working_memory',
        entity_id: String(record.id),
        event_type: 'working_memory.created',
        payload: {
          after: cloneValue(record),
        },
        created_at: record.created_at,
      });
      return record;
    },

    getWorkingMemoryById(id) {
      return state.workingMemory.find((item) => item.id === id) ?? null;
    },

    getExistingWorkingMemoryIds(ids) {
      return filterExistingIds(state.workingMemory, ids);
    },

    getWorkingMemoryBySession(sessionId, scope) {
      return state.workingMemory.filter((item) => item.session_id === sessionId && matchesScope(item, scope));
    },

    getActiveWorkingMemory(scope, sessionId) {
      const now = nowSeconds();
      return state.workingMemory.filter(
        (item) =>
          matchesScopedSession(item, scope, sessionId) &&
          (item.expires_at === null || item.expires_at > now),
      );
    },

    getLatestWorkingMemory(scope, sessionId) {
      return (
        this.getActiveWorkingMemory(scope, sessionId).sort((a, b) => b.id - a.id)[0] ?? null
      );
    },

    getWorkingMemoryByTimeRange(scope, range) {
      return state.workingMemory.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      );
    },

    expireWorkingMemory(id) {
      const item = state.workingMemory.find((entry) => entry.id === id);
      if (!item) return;
      const before = cloneValue(item);
      const expiredAt = nowSeconds();
      item.expires_at = expiredAt;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        session_id: item.session_id,
        entity_kind: 'working_memory',
        entity_id: String(item.id),
        event_type: 'working_memory.expired',
        payload: {
          before,
          after: cloneValue(item),
          patch: {
            expires_at: expiredAt,
          },
        },
        created_at: expiredAt,
      });
    },

    markWorkingMemoryPromoted(id, knowledgeMemoryId) {
      const item = state.workingMemory.find((entry) => entry.id === id);
      if (!item) return;
      const before = cloneValue(item);
      item.promoted_to_knowledge_id = knowledgeMemoryId;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        session_id: item.session_id,
        entity_kind: 'working_memory',
        entity_id: String(item.id),
        event_type: 'working_memory.promoted',
        payload: {
          before,
          after: cloneValue(item),
          refs: {
            knowledge_memory_id: knowledgeMemoryId,
          },
        },
        created_at: nowSeconds(),
      });
    },

    insertKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory {
      const scope = validateNewKnowledgeMemory(input);
      const createdAt = nowSeconds();
      const record: KnowledgeMemory = {
        ...scope,
        id: ids.knowledgeMemory++,
        visibility_class: input.visibility_class ?? 'private',
        fact: input.fact,
        fact_type: input.fact_type,
        knowledge_state: input.knowledge_state ?? 'trusted',
        knowledge_class: input.knowledge_class ?? 'project_fact',
        fact_subject: input.fact_subject ?? null,
        fact_attribute: input.fact_attribute ?? null,
        fact_value: input.fact_value ?? null,
        normalized_fact: input.normalized_fact ?? null,
        slot_key: input.slot_key ?? null,
        is_negated: input.is_negated ?? false,
        source: input.source,
        confidence: input.confidence,
        confidence_score: input.confidence_score ?? 0.5,
        grounding_strength: input.grounding_strength ?? 'moderate',
        evidence_count: input.evidence_count ?? Math.max(1, (input.source_turn_ids ?? []).length),
        trust_score: input.trust_score ?? (input.confidence_score ?? 0.5),
        verification_status: input.verification_status ?? 'unverified',
        verification_notes: input.verification_notes ?? null,
        last_verified_at: input.last_verified_at ?? null,
        next_reverification_at: input.next_reverification_at ?? null,
        last_confirmed_at: input.last_confirmed_at ?? null,
        confirmation_count: input.confirmation_count ?? 0,
        source_system_id: input.source_system_id ?? scope.system_id,
        source_scope_id: input.source_scope_id ?? scope.scope_id,
        source_collaboration_id: input.source_collaboration_id ?? scope.collaboration_id,
        source_working_memory_id: input.source_working_memory_id ?? null,
        source_turn_ids: input.source_turn_ids ?? [],
        successful_use_count: input.successful_use_count ?? 0,
        failed_use_count: input.failed_use_count ?? 0,
        disputed_at: input.disputed_at ?? null,
        dispute_reason: input.dispute_reason ?? null,
        contradiction_score: input.contradiction_score ?? 0,
        superseded_at: input.superseded_at ?? null,
        superseded_by_id: null,
        retired_at: input.retired_at ?? null,
        created_at: createdAt,
        last_accessed_at: createdAt,
        access_count: 1,
        schema_version: SCHEMA_VERSION,
      };
      state.knowledgeMemory.push(record);
      this.insertMemoryEvent({
        ...scope,
        entity_kind: 'knowledge_memory',
        entity_id: String(record.id),
        event_type: 'knowledge.created',
        payload: {
          after: cloneValue(record),
        },
        created_at: record.created_at,
      });
      return record;
    },

    insertKnowledgeMemories(inputs) {
      return inputs.map((input) => this.insertKnowledgeMemory(input));
    },

    insertKnowledgeCandidate(input) {
      const scope = validateNewKnowledgeCandidate(input);
      const record: KnowledgeCandidate = {
        ...scope,
        id: ids.knowledgeCandidate++,
        working_memory_id: input.working_memory_id,
        fact: input.fact,
        fact_type: input.fact_type,
        knowledge_class: input.knowledge_class,
        normalized_fact: input.normalized_fact,
        slot_key: input.slot_key ?? null,
        confidence: input.confidence,
        source_summary: input.source_summary ?? false,
        source_turns: input.source_turns ?? true,
        grounding_strength: input.grounding_strength ?? 'weak',
        evidence_count: input.evidence_count ?? 0,
        trust_score: input.trust_score ?? 0,
        state: input.state ?? 'candidate',
        created_at: input.created_at ?? nowSeconds(),
        promoted_knowledge_id: input.promoted_knowledge_id ?? null,
      };
      state.knowledgeCandidates.push(record);
      return record;
    },

    insertKnowledgeCandidates(inputs) {
      return inputs.map((input) => this.insertKnowledgeCandidate(input));
    },

    getKnowledgeCandidateById(id) {
      return state.knowledgeCandidates.find((item) => item.id === id) ?? null;
    },

    listKnowledgeCandidates(scope, options) {
      return state.knowledgeCandidates.filter(
        (item) =>
          matchesScope(item, scope) &&
          (!options?.state || options.state.includes(item.state)),
      );
    },

    insertKnowledgeEvidence(input) {
      const scope = validateNewKnowledgeEvidence(input);
      const record: KnowledgeEvidence = {
        ...scope,
        id: ids.knowledgeEvidence++,
        knowledge_memory_id: input.knowledge_memory_id ?? null,
        knowledge_candidate_id: input.knowledge_candidate_id ?? null,
        working_memory_id: input.working_memory_id ?? null,
        turn_id: input.turn_id ?? null,
        source_type: input.source_type,
        support_polarity: input.support_polarity,
        speaker_role: input.speaker_role ?? null,
        actor: input.actor ?? null,
        excerpt: input.excerpt,
        start_offset: input.start_offset ?? null,
        end_offset: input.end_offset ?? null,
        is_explicit: input.is_explicit ?? false,
        explicitness_score: input.explicitness_score ?? 0,
        outcome: input.outcome ?? null,
        created_at: input.created_at ?? nowSeconds(),
      };
      state.knowledgeEvidence.push(record);
      return record;
    },

    insertKnowledgeEvidenceBatch(inputs) {
      return inputs.map((input) => this.insertKnowledgeEvidence(input));
    },

    listKnowledgeEvidenceForKnowledge(knowledgeId) {
      return state.knowledgeEvidence.filter((item) => item.knowledge_memory_id === knowledgeId);
    },

    listKnowledgeEvidenceForCandidate(candidateId) {
      return state.knowledgeEvidence.filter((item) => item.knowledge_candidate_id === candidateId);
    },

    promoteKnowledgeCandidate(candidateId, input) {
      const candidate = state.knowledgeCandidates.find((item) => item.id === candidateId);
      const knowledge = this.insertKnowledgeMemory(input);
      if (candidate) {
        candidate.promoted_knowledge_id = knowledge.id;
        candidate.state = 'provisional';
      }
      return knowledge;
    },

    deleteExpiredKnowledgeCandidates(scope, olderThan) {
      const n = normalizeScope(scope);
      const expired = state.knowledgeCandidates.filter(
        (c) =>
          c.tenant_id === n.tenant_id &&
          c.system_id === n.system_id &&
          c.workspace_id === n.workspace_id &&
          c.collaboration_id === n.collaboration_id &&
          c.scope_id === n.scope_id &&
          c.promoted_knowledge_id === null &&
          c.created_at < olderThan,
      );
      const ids = expired.map((c) => c.id);
      state.knowledgeCandidates = state.knowledgeCandidates.filter((c) => !ids.includes(c.id));
      return ids;
    },

    getKnowledgeMemoryById(id) {
      return state.knowledgeMemory.find((item) => item.id === id) ?? null;
    },

    getExistingKnowledgeMemoryIds(ids) {
      return filterExistingIds(state.knowledgeMemory, ids);
    },

    getActiveKnowledgeMemory(scope) {
      return state.knowledgeMemory.filter(
        (item) =>
          matchesScope(item, scope) && item.superseded_by_id === null && item.retired_at === null,
      );
    },

    getActiveKnowledgeMemoryPaginated(scope, options) {
      return paginateItems(
        state.knowledgeMemory.filter(
          (item) =>
            matchesScope(item, scope) &&
            item.superseded_by_id === null &&
            item.retired_at === null,
        ),
        options,
      );
    },

    getActiveKnowledgeCrossScope(scope, level) {
      return state.knowledgeMemory.filter(
        (item) =>
          matchesScopeLevel(item, scope, level) &&
          item.superseded_by_id === null &&
          item.retired_at === null,
      );
    },

    getKnowledgeSince(scope, level, since) {
      return state.knowledgeMemory.filter(
        (item) =>
          matchesScopeLevel(item, scope, level) &&
          item.created_at >= since &&
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
        .filter((item) => matchesKnowledgeSearchOptions(item, resolved))
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
            matchesScopeLevel(item, scope, level) &&
            (!resolved.activeOnly ||
              (item.superseded_by_id === null && item.retired_at === null)),
        )
        .filter((item) => matchesKnowledgeSearchOptions(item, resolved))
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
        confidence_score: input.confidence_score ?? 0.5,
        verification_status: input.verification_status ?? 'unverified',
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

    getKnowledgeMemoryAuditsForKnowledge(scope, knowledgeId, limit = 10) {
      return state.knowledgeAudits
        .filter(
          (item) =>
            matchesScope(item, scope) &&
            (item.created_knowledge_id === knowledgeId || item.related_knowledge_id === knowledgeId),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    },

    updateKnowledgeMemory(id, patch) {
      const item = state.knowledgeMemory.find((entry) => entry.id === id);
      if (!item) return null;
      const before = cloneValue(item);
      if (patch.knowledge_state !== undefined) item.knowledge_state = patch.knowledge_state;
      if (patch.knowledge_class !== undefined) item.knowledge_class = patch.knowledge_class;
      if (patch.trust_score !== undefined) item.trust_score = patch.trust_score;
      if (patch.verification_status !== undefined) item.verification_status = patch.verification_status;
      if (patch.verification_notes !== undefined) item.verification_notes = patch.verification_notes;
      if (patch.last_verified_at !== undefined) item.last_verified_at = patch.last_verified_at;
      if (patch.next_reverification_at !== undefined) {
        item.next_reverification_at = patch.next_reverification_at;
      }
      if (patch.last_confirmed_at !== undefined) item.last_confirmed_at = patch.last_confirmed_at;
      if (patch.confirmation_count !== undefined) item.confirmation_count = patch.confirmation_count;
      if (patch.disputed_at !== undefined) item.disputed_at = patch.disputed_at;
      if (patch.dispute_reason !== undefined) item.dispute_reason = patch.dispute_reason;
      if (patch.contradiction_score !== undefined) item.contradiction_score = patch.contradiction_score;
      if (patch.superseded_at !== undefined) item.superseded_at = patch.superseded_at;
      if (patch.successful_use_count !== undefined) item.successful_use_count = patch.successful_use_count;
      if (patch.failed_use_count !== undefined) item.failed_use_count = patch.failed_use_count;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        entity_kind: 'knowledge_memory',
        entity_id: String(item.id),
        event_type: 'knowledge.updated',
        payload: {
          before,
          after: cloneValue(item),
          patch: cloneValue(patch as Record<string, unknown>),
        },
        created_at: nowSeconds(),
      });
      return item;
    },

    touchKnowledgeMemory(id) {
      const item = state.knowledgeMemory.find((entry) => entry.id === id);
      if (!item) return;
      const before = cloneValue(item);
      item.last_accessed_at = nowSeconds();
      item.access_count += 1;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        entity_kind: 'knowledge_memory',
        entity_id: String(item.id),
        event_type: 'knowledge.touched',
        payload: {
          before,
          after: cloneValue(item),
          patch: {
            last_accessed_at: item.last_accessed_at,
            access_count: item.access_count,
          },
        },
        created_at: item.last_accessed_at,
      });
    },

    touchKnowledgeMemories(ids) {
      const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
      for (const id of uniqueIds) {
        this.touchKnowledgeMemory(id);
      }
    },

    retireKnowledgeMemory(id, retiredAt = nowSeconds()) {
      const item = state.knowledgeMemory.find((entry) => entry.id === id);
      if (!item) return;
      const before = cloneValue(item);
      item.retired_at = retiredAt;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        entity_kind: 'knowledge_memory',
        entity_id: String(item.id),
        event_type: 'knowledge.retired',
        payload: {
          before,
          after: cloneValue(item),
          patch: {
            retired_at: retiredAt,
          },
        },
        created_at: retiredAt,
      });
    },

    supersedeKnowledgeMemory(oldId, newId) {
      const item = state.knowledgeMemory.find((entry) => entry.id === oldId);
      if (item) {
        const before = cloneValue(item);
        item.superseded_by_id = newId;
        item.superseded_at = nowSeconds();
        item.knowledge_state = 'superseded';
        this.insertMemoryEvent({
          ...normalizeScope(item),
          entity_kind: 'knowledge_memory',
          entity_id: String(item.id),
          event_type: 'knowledge.superseded',
          payload: {
            before,
            after: cloneValue(item),
            refs: {
              new_id: newId,
            },
          },
          created_at: item.superseded_at,
        });
      }
    },

    insertWorkItem(input: NewWorkItem): WorkItem {
      const scope = validateNewWorkItem(input);
      const createdAt = input.created_at ?? nowSeconds();
      const item: WorkItem = {
        ...scope,
        id: ids.workItem++,
        session_id: input.session_id ?? null,
        visibility_class: input.visibility_class ?? 'private',
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? null,
        status: input.status ?? 'open',
        source_working_memory_id: input.source_working_memory_id ?? null,
        version: 1,
        created_at: createdAt,
        updated_at: createdAt,
      };
      state.workItems.push(item);
      this.insertMemoryEvent({
        ...scope,
        session_id: item.session_id,
        entity_kind: 'work_item',
        entity_id: String(item.id),
        event_type: 'work_item.created',
        payload: {
          after: cloneValue(item),
        },
        created_at: item.created_at,
      });
      return item;
    },

    getWorkItemById(id) {
      const item = state.workItems.find((entry) => entry.id === id);
      return item ? cloneValue(item) : null;
    },

    getExistingWorkItemIds(ids) {
      return filterExistingIds(state.workItems, ids);
    },

    getActiveWorkItems(scope) {
      return state.workItems.filter(
        (item) => matchesScope(item, scope) && item.status !== 'done',
      );
    },

    getActiveWorkItemsCrossScope(scope, level) {
      return state.workItems.filter(
        (item) => matchesScopeLevel(item, scope, level) && item.status !== 'done',
      );
    },

    getWorkItemsByTimeRange(scope, range) {
      return state.workItems.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      );
    },

    getWorkItemsByTimeRangeCrossScope(scope, level, range) {
      return state.workItems.filter(
        (item) => matchesScopeLevel(item, scope, level) && inRange(item.created_at, range),
      );
    },

    updateWorkItemStatus(id, status) {
      const item = state.workItems.find((entry) => entry.id === id);
      if (!item) return;
      const before = cloneValue(item);
      item.status = status;
      item.updated_at = nowSeconds();
      item.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        session_id: item.session_id,
        entity_kind: 'work_item',
        entity_id: String(item.id),
        event_type: 'work_item.status_changed',
        payload: {
          before,
          after: cloneValue(item),
          patch: {
            status,
            updated_at: item.updated_at,
          },
        },
        created_at: item.updated_at,
      });
    },

    updateWorkItem(id, patch: WorkItemPatch, options?: { expectedVersion?: number }) {
      const item = state.workItems.find((entry) => entry.id === id);
      if (!item) return null;
      if (options?.expectedVersion != null && item.version !== options.expectedVersion) {
        throw new ConflictError(`Work item ${id} version mismatch`);
      }
      const before = cloneValue(item);
      if (patch.title !== undefined) item.title = patch.title;
      if (patch.detail !== undefined) item.detail = patch.detail ?? null;
      if (patch.status !== undefined) item.status = patch.status;
      if (patch.visibility_class !== undefined) {
        assertMemoryVisibilityClass(patch.visibility_class);
        item.visibility_class = patch.visibility_class;
      }
      item.updated_at = nowSeconds();
      item.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(item),
        session_id: item.session_id,
        entity_kind: 'work_item',
        entity_id: String(item.id),
        event_type:
          patch.visibility_class !== undefined &&
          patch.title === undefined &&
          patch.detail === undefined &&
          patch.status === undefined
            ? 'work_item.visibility_changed'
            : 'work_item.updated',
        payload: {
          before,
          after: cloneValue(item),
          patch: cloneValue(patch as Record<string, unknown>),
        },
        created_at: item.updated_at,
      });
      return cloneValue(item);
    },

    deleteWorkItem(id) {
      const index = state.workItems.findIndex((item) => item.id === id);
      if (index < 0) return;
      const [item] = state.workItems.splice(index, 1);
      this.insertMemoryEvent({
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
    },

    claimWorkItem(input: NewWorkClaimInput): WorkClaim {
      assertActorRef(input.actor);
      const workItem = state.workItems.find((item) => item.id === input.work_item_id);
      if (!workItem) {
        throw new ConflictError(`Work item ${input.work_item_id} does not exist`);
      }
      if (workItem.status === 'done') {
        throw new ConflictError(`Work item ${input.work_item_id} is already done`);
      }
      const now = input.claimed_at ?? nowSeconds();
      const existing = state.workClaims.find((claim) => claim.work_item_id === input.work_item_id);
      if (existing && isClaimExpired(existing, now)) {
        const before = cloneValue(existing);
        existing.status = 'expired';
        existing.released_at = now;
        existing.release_reason = 'expired';
        existing.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(existing),
          session_id: existing.session_id,
          actor_id: existing.actor.actor_id,
          actor_kind: existing.actor.actor_kind,
          actor_system_id: existing.actor.system_id,
          actor_display_name: existing.actor.display_name,
          actor_metadata: existing.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(existing.id),
          event_type: 'work_claim.expired',
          payload: { before, after: cloneValue(existing) },
          created_at: now,
        });
      }
      const active = state.workClaims.find(
        (claim) => claim.work_item_id === input.work_item_id && claim.status === 'active',
      );
      if (active) {
        if (!matchesActor(input.actor, active.actor)) {
          throw new ConflictError(`Work item ${input.work_item_id} is already claimed`);
        }
        active.expires_at = Math.max(active.expires_at, now) + (input.lease_seconds ?? 300);
        active.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(active),
          session_id: active.session_id,
          actor_id: active.actor.actor_id,
          actor_kind: active.actor.actor_kind,
          actor_system_id: active.actor.system_id,
          actor_display_name: active.actor.display_name,
          actor_metadata: active.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(active.id),
          event_type: 'work_claim.renewed',
          payload: { after: cloneValue(active) },
          created_at: now,
        });
        return cloneValue(active);
      }
      const normalized = normalizeScope(input);
      const claim: WorkClaim = {
        ...normalized,
        id: ids.workClaim++,
        work_item_id: input.work_item_id,
        actor: cloneValue(input.actor),
        session_id: input.session_id ?? null,
        claim_token: makeClaimToken(),
        status: 'active',
        claimed_at: now,
        expires_at: now + (input.lease_seconds ?? 300),
        released_at: null,
        release_reason: null,
        source_event_id: null,
        visibility_class: input.visibility_class,
        version: 1,
      };
      state.workClaims = state.workClaims.filter(
        (entry) => !(entry.work_item_id === claim.work_item_id && entry.status === 'active'),
      );
      state.workClaims.push(claim);
      this.insertMemoryEvent({
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
      return cloneValue(claim);
    },

    renewWorkClaim(claimId, actor, leaseSeconds = 300) {
      assertActorRef(actor);
      const claim = state.workClaims.find((entry) => entry.id === claimId);
      if (!claim) return null;
      if (!matchesActor(actor, claim.actor)) {
        throw new ConflictError(`Claim ${claimId} is owned by another actor`);
      }
      const now = nowSeconds();
      if (isClaimExpired(claim, now)) {
        claim.status = 'expired';
        claim.released_at = now;
        claim.release_reason = 'expired';
        claim.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(claim),
          session_id: claim.session_id,
          actor_id: claim.actor.actor_id,
          actor_kind: claim.actor.actor_kind,
          actor_system_id: claim.actor.system_id,
          actor_display_name: claim.actor.display_name,
          actor_metadata: claim.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(claim.id),
          event_type: 'work_claim.expired',
          payload: { after: cloneValue(claim) },
          created_at: now,
        });
        return null;
      }
      if (claim.status !== 'active') {
        throw new ConflictError(`Claim ${claimId} is no longer active`);
      }
      claim.expires_at = Math.max(claim.expires_at, now) + leaseSeconds;
      claim.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(claim),
        session_id: claim.session_id,
        actor_id: claim.actor.actor_id,
        actor_kind: claim.actor.actor_kind,
        actor_system_id: claim.actor.system_id,
        actor_display_name: claim.actor.display_name,
        actor_metadata: claim.actor.metadata,
        entity_kind: 'work_claim',
        entity_id: String(claim.id),
        event_type: 'work_claim.renewed',
        payload: { after: cloneValue(claim) },
        created_at: now,
      });
      return cloneValue(claim);
    },

    releaseWorkClaim(claimId, actor, reason) {
      assertActorRef(actor);
      const claim = state.workClaims.find((entry) => entry.id === claimId);
      if (!claim) return null;
      if (!matchesActor(actor, claim.actor)) {
        throw new ConflictError(`Claim ${claimId} is owned by another actor`);
      }
      if (claim.status !== 'active') {
        throw new ConflictError(`Claim ${claimId} is no longer active`);
      }
      const now = nowSeconds();
      claim.status = 'released';
      claim.released_at = now;
      claim.release_reason = reason ?? null;
      claim.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(claim),
        session_id: claim.session_id,
        actor_id: claim.actor.actor_id,
        actor_kind: claim.actor.actor_kind,
        actor_system_id: claim.actor.system_id,
        actor_display_name: claim.actor.display_name,
        actor_metadata: claim.actor.metadata,
        entity_kind: 'work_claim',
        entity_id: String(claim.id),
        event_type: 'work_claim.released',
        payload: { after: cloneValue(claim) },
        created_at: now,
      });
      return cloneValue(claim);
    },

    getWorkClaimById(claimId) {
      const claim = state.workClaims.find((entry) => entry.id === claimId);
      if (!claim) return null;
      return cloneValue(claim);
    },

    getActiveWorkClaim(workItemId) {
      const claim = state.workClaims.find(
        (entry) => entry.work_item_id === workItemId && entry.status === 'active',
      );
      if (claim && isClaimExpired(claim)) {
        claim.status = 'expired';
        claim.released_at = nowSeconds();
        claim.release_reason = 'expired';
        claim.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(claim),
          session_id: claim.session_id,
          actor_id: claim.actor.actor_id,
          actor_kind: claim.actor.actor_kind,
          actor_system_id: claim.actor.system_id,
          actor_display_name: claim.actor.display_name,
          actor_metadata: claim.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(claim.id),
          event_type: 'work_claim.expired',
          payload: { after: cloneValue(claim) },
          created_at: claim.released_at,
        });
        return null;
      }
      return claim ? cloneValue(claim) : null;
    },

    listWorkClaims(scope, options?: WorkClaimQuery) {
      const currentNow = nowSeconds();
      for (const claim of state.workClaims) {
        if (matchesScope(claim, scope) && isClaimExpired(claim, currentNow)) {
          claim.status = 'expired';
          claim.released_at = currentNow;
          claim.release_reason = 'expired';
          claim.version += 1;
          this.insertMemoryEvent({
            ...normalizeScope(claim),
            session_id: claim.session_id,
            actor_id: claim.actor.actor_id,
            actor_kind: claim.actor.actor_kind,
            actor_system_id: claim.actor.system_id,
            actor_display_name: claim.actor.display_name,
            actor_metadata: claim.actor.metadata,
            entity_kind: 'work_claim',
            entity_id: String(claim.id),
            event_type: 'work_claim.expired',
            payload: { after: cloneValue(claim) },
            created_at: currentNow,
          });
        }
      }
      return state.workClaims.filter((claim) => {
        if (!matchesScope(claim, scope)) return false;
        if (!options?.includeExpired && claim.status === 'expired') return false;
        if (!options?.includeReleased && claim.status === 'released') return false;
        if (options?.sessionId && claim.session_id !== options.sessionId) return false;
        if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
        if (options?.actor && !matchesActor(options.actor, claim.actor)) return false;
        return true;
      }).map(cloneValue);
    },

    listWorkClaimsCrossScope(scope, level: ScopeLevel, options?: WorkClaimQuery) {
      const currentNow = nowSeconds();
      for (const claim of state.workClaims) {
        if (matchesScopeLevel(claim, scope, level) && isClaimExpired(claim, currentNow)) {
          claim.status = 'expired';
          claim.released_at = currentNow;
          claim.release_reason = 'expired';
          claim.version += 1;
          this.insertMemoryEvent({
            ...normalizeScope(claim),
            session_id: claim.session_id,
            actor_id: claim.actor.actor_id,
            actor_kind: claim.actor.actor_kind,
            actor_system_id: claim.actor.system_id,
            actor_display_name: claim.actor.display_name,
            actor_metadata: claim.actor.metadata,
            entity_kind: 'work_claim',
            entity_id: String(claim.id),
            event_type: 'work_claim.expired',
            payload: { after: cloneValue(claim) },
            created_at: currentNow,
          });
        }
      }
      return state.workClaims.filter((claim) => {
        if (!matchesScopeLevel(claim, scope, level)) return false;
        if (!options?.includeExpired && claim.status === 'expired') return false;
        if (!options?.includeReleased && claim.status === 'released') return false;
        if (options?.sessionId && claim.session_id !== options.sessionId) return false;
        if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
        if (options?.actor && !matchesActor(options.actor, claim.actor)) return false;
        return true;
      }).map(cloneValue);
    },

    createHandoff(input: NewHandoffInput) {
      assertActorRef(input.from_actor, 'from_actor');
      assertActorRef(input.to_actor, 'to_actor');
      const normalized = normalizeScope(input);
      const handoff: HandoffRecord = {
        ...normalized,
        id: ids.handoff++,
        work_item_id: input.work_item_id,
        from_actor: cloneValue(input.from_actor),
        to_actor: cloneValue(input.to_actor),
        session_id: input.session_id ?? null,
        summary: input.summary,
        context_bundle_ref: input.context_bundle_ref ?? null,
        status: 'pending',
        created_at: input.created_at ?? nowSeconds(),
        accepted_at: null,
        rejected_at: null,
        canceled_at: null,
        expires_at: input.expires_at ?? null,
        decision_reason: null,
        source_event_id: null,
        visibility_class: input.visibility_class,
        version: 1,
      };
      state.handoffs.push(handoff);
      this.insertMemoryEvent({
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
        created_at: handoff.created_at,
      });
      return cloneValue(handoff);
    },

    getHandoffById(handoffId) {
      const handoff = state.handoffs.find((entry) => entry.id === handoffId);
      if (!handoff) return null;
      return cloneValue(handoff);
    },

    acceptHandoff(handoffId, actor, reason) {
      assertActorRef(actor);
      const handoff = state.handoffs.find((entry) => entry.id === handoffId);
      if (!handoff) return null;
      if (!matchesActor(actor, handoff.to_actor)) {
        throw new ConflictError(`Handoff ${handoffId} is assigned to another actor`);
      }
      if (isHandoffExpired(handoff)) {
        handoff.status = 'expired';
        handoff.decision_reason = 'expired';
        handoff.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(handoff),
          session_id: handoff.session_id,
          actor_id: handoff.to_actor.actor_id,
          actor_kind: handoff.to_actor.actor_kind,
          actor_system_id: handoff.to_actor.system_id,
          actor_display_name: handoff.to_actor.display_name,
          actor_metadata: handoff.to_actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(handoff.id),
          event_type: 'handoff.expired',
          payload: { after: cloneValue(handoff) },
          created_at: nowSeconds(),
        });
        return null;
      }
      if (handoff.status !== 'pending') {
        throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
      }
      const activeClaim = state.workClaims.find(
        (claim) => claim.work_item_id === handoff.work_item_id && claim.status === 'active' && !isClaimExpired(claim),
      );
      if (activeClaim && !matchesActor(handoff.from_actor, activeClaim.actor)) {
        throw new ConflictError(`Work item ${handoff.work_item_id} has another active owner`);
      }
      const now = nowSeconds();
      if (activeClaim && matchesActor(handoff.from_actor, activeClaim.actor)) {
        this.releaseWorkClaim(activeClaim.id, handoff.from_actor, 'handoff_accepted');
      }
      this.claimWorkItem({
        ...normalizeScope(handoff),
        work_item_id: handoff.work_item_id,
        actor,
        session_id: handoff.session_id,
        visibility_class: handoff.visibility_class,
      });
      handoff.status = 'accepted';
      handoff.accepted_at = now;
      handoff.decision_reason = reason ?? null;
      handoff.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(handoff),
        session_id: handoff.session_id,
        actor_id: actor.actor_id,
        actor_kind: actor.actor_kind,
        actor_system_id: actor.system_id,
        actor_display_name: actor.display_name,
        actor_metadata: actor.metadata,
        entity_kind: 'handoff',
        entity_id: String(handoff.id),
        event_type: 'handoff.accepted',
        payload: { after: cloneValue(handoff) },
        created_at: now,
      });
      return cloneValue(handoff);
    },

    rejectHandoff(handoffId, actor, reason) {
      assertActorRef(actor);
      const handoff = state.handoffs.find((entry) => entry.id === handoffId);
      if (!handoff) return null;
      if (!matchesActor(actor, handoff.to_actor)) {
        throw new ConflictError(`Handoff ${handoffId} is assigned to another actor`);
      }
      if (isHandoffExpired(handoff)) {
        handoff.status = 'expired';
        handoff.decision_reason = 'expired';
        handoff.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(handoff),
          session_id: handoff.session_id,
          actor_id: handoff.to_actor.actor_id,
          actor_kind: handoff.to_actor.actor_kind,
          actor_system_id: handoff.to_actor.system_id,
          actor_display_name: handoff.to_actor.display_name,
          actor_metadata: handoff.to_actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(handoff.id),
          event_type: 'handoff.expired',
          payload: { after: cloneValue(handoff) },
          created_at: nowSeconds(),
        });
        return null;
      }
      if (handoff.status !== 'pending') {
        throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
      }
      handoff.status = 'rejected';
      handoff.rejected_at = nowSeconds();
      handoff.decision_reason = reason ?? null;
      handoff.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(handoff),
        session_id: handoff.session_id,
        actor_id: actor.actor_id,
        actor_kind: actor.actor_kind,
        actor_system_id: actor.system_id,
        actor_display_name: actor.display_name,
        actor_metadata: actor.metadata,
        entity_kind: 'handoff',
        entity_id: String(handoff.id),
        event_type: 'handoff.rejected',
        payload: { after: cloneValue(handoff) },
        created_at: handoff.rejected_at,
      });
      return cloneValue(handoff);
    },

    cancelHandoff(handoffId, actor, reason) {
      assertActorRef(actor);
      const handoff = state.handoffs.find((entry) => entry.id === handoffId);
      if (!handoff) return null;
      if (!matchesActor(actor, handoff.from_actor)) {
        throw new ConflictError(`Handoff ${handoffId} was created by another actor`);
      }
      if (isHandoffExpired(handoff)) {
        handoff.status = 'expired';
        handoff.decision_reason = 'expired';
        handoff.version += 1;
        this.insertMemoryEvent({
          ...normalizeScope(handoff),
          session_id: handoff.session_id,
          actor_id: handoff.from_actor.actor_id,
          actor_kind: handoff.from_actor.actor_kind,
          actor_system_id: handoff.from_actor.system_id,
          actor_display_name: handoff.from_actor.display_name,
          actor_metadata: handoff.from_actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(handoff.id),
          event_type: 'handoff.expired',
          payload: { after: cloneValue(handoff) },
          created_at: nowSeconds(),
        });
        return null;
      }
      if (handoff.status !== 'pending') {
        throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
      }
      handoff.status = 'canceled';
      handoff.canceled_at = nowSeconds();
      handoff.decision_reason = reason ?? null;
      handoff.version += 1;
      this.insertMemoryEvent({
        ...normalizeScope(handoff),
        session_id: handoff.session_id,
        actor_id: actor.actor_id,
        actor_kind: actor.actor_kind,
        actor_system_id: actor.system_id,
        actor_display_name: actor.display_name,
        actor_metadata: actor.metadata,
        entity_kind: 'handoff',
        entity_id: String(handoff.id),
        event_type: 'handoff.canceled',
        payload: { after: cloneValue(handoff) },
        created_at: handoff.canceled_at,
      });
      return cloneValue(handoff);
    },

    listHandoffs(scope, options?: HandoffQuery) {
      const currentNow = nowSeconds();
      for (const handoff of state.handoffs) {
        if (matchesScope(handoff, scope) && isHandoffExpired(handoff, currentNow)) {
          handoff.status = 'expired';
          handoff.decision_reason = 'expired';
          handoff.version += 1;
          this.insertMemoryEvent({
            ...normalizeScope(handoff),
            session_id: handoff.session_id,
            actor_id: handoff.to_actor.actor_id,
            actor_kind: handoff.to_actor.actor_kind,
            actor_system_id: handoff.to_actor.system_id,
            actor_display_name: handoff.to_actor.display_name,
            actor_metadata: handoff.to_actor.metadata,
            entity_kind: 'handoff',
            entity_id: String(handoff.id),
            event_type: 'handoff.expired',
            payload: { after: cloneValue(handoff) },
            created_at: currentNow,
          });
        }
      }
      return state.handoffs.filter((handoff) => {
        if (!matchesScope(handoff, scope)) return false;
        if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
        if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
        if (!options?.actor) return true;
        if (options.direction === 'inbound') return matchesActor(options.actor, handoff.to_actor);
        if (options.direction === 'outbound') return matchesActor(options.actor, handoff.from_actor);
        return (
          matchesActor(options.actor, handoff.to_actor) ||
          matchesActor(options.actor, handoff.from_actor)
        );
      }).map(cloneValue);
    },

    listHandoffsCrossScope(scope, level: ScopeLevel, options?: HandoffQuery) {
      const currentNow = nowSeconds();
      for (const handoff of state.handoffs) {
        if (matchesScopeLevel(handoff, scope, level) && isHandoffExpired(handoff, currentNow)) {
          handoff.status = 'expired';
          handoff.decision_reason = 'expired';
          handoff.version += 1;
          this.insertMemoryEvent({
            ...normalizeScope(handoff),
            session_id: handoff.session_id,
            actor_id: handoff.to_actor.actor_id,
            actor_kind: handoff.to_actor.actor_kind,
            actor_system_id: handoff.to_actor.system_id,
            actor_display_name: handoff.to_actor.display_name,
            actor_metadata: handoff.to_actor.metadata,
            entity_kind: 'handoff',
            entity_id: String(handoff.id),
            event_type: 'handoff.expired',
            payload: { after: cloneValue(handoff) },
            created_at: currentNow,
          });
        }
      }
      return state.handoffs.filter((handoff) => {
        if (!matchesScopeLevel(handoff, scope, level)) return false;
        if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
        if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
        if (!options?.actor) return true;
        if (options.direction === 'inbound') return matchesActor(options.actor, handoff.to_actor);
        if (options.direction === 'outbound') return matchesActor(options.actor, handoff.from_actor);
        return (
          matchesActor(options.actor, handoff.to_actor) ||
          matchesActor(options.actor, handoff.from_actor)
        );
      }).map(cloneValue);
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

    insertPlaybook(input: NewPlaybook): Playbook {
      const scope = normalizeScope(input);
      const now = nowSeconds();
      const record: Playbook = {
        ...scope,
        id: ids.playbook++,
        visibility_class: input.visibility_class ?? 'private',
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        references: input.references ? [...input.references] : [],
        templates: input.templates ? [...input.templates] : [],
        scripts: input.scripts ? [...input.scripts] : [],
        assets: input.assets ? [...input.assets] : [],
        tags: input.tags ? [...input.tags] : [],
        status: input.status ?? 'draft',
        source_session_id: input.source_session_id ?? null,
        source_working_memory_id: input.source_working_memory_id ?? null,
        revision_count: 0,
        last_used_at: null,
        use_count: 0,
        created_at: input.created_at ?? now,
        updated_at: now,
        schema_version: SCHEMA_VERSION,
      };
      state.playbooks.push(record);
      this.insertMemoryEvent({
        ...scope,
        session_id: record.source_session_id,
        entity_kind: 'playbook',
        entity_id: String(record.id),
        event_type: 'playbook.created',
        payload: {
          after: cloneValue(record),
        },
        created_at: record.created_at,
      });
      return record;
    },
    getPlaybookById(id: number): Playbook | null {
      return state.playbooks.find((p) => p.id === id) ?? null;
    },
    getExistingPlaybookIds(ids: number[]): number[] {
      return filterExistingIds(state.playbooks, ids);
    },
    getActivePlaybooks(scope: MemoryScope): Playbook[] {
      return state.playbooks.filter(
        (p) => matchesScope(p, scope) && (p.status === 'draft' || p.status === 'active'),
      );
    },
    getActivePlaybooksCrossScope(scope: MemoryScope, level: ScopeLevel): Playbook[] {
      return state.playbooks.filter(
        (p) => matchesScopeLevel(p, scope, level) && (p.status === 'draft' || p.status === 'active'),
      );
    },
    searchPlaybooks(scope: MemoryScope, query: string, options?: SearchOptions): SearchResult<Playbook>[] {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const limit = options?.limit ?? 20;
      const activeOnly = options?.activeOnly ?? true;
      return state.playbooks
        .filter((p) => {
          if (!matchesScope(p, scope)) return false;
          if (activeOnly && (p.status === 'archived' || p.status === 'deprecated')) return false;
          const text = `${p.title} ${p.description} ${p.instructions}`.toLowerCase();
          return tokens.every((token) => text.includes(token));
        })
        .slice(0, limit)
        .map((item, index) => ({ item, rank: index }));
    },
    searchPlaybooksCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      query: string,
      options?: SearchOptions,
    ): SearchResult<Playbook>[] {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const limit = options?.limit ?? 20;
      const activeOnly = options?.activeOnly ?? true;
      return state.playbooks
        .filter((p) => {
          if (!matchesScopeLevel(p, scope, level)) return false;
          if (activeOnly && (p.status === 'archived' || p.status === 'deprecated')) return false;
          const text = `${p.title} ${p.description} ${p.instructions}`.toLowerCase();
          return tokens.every((token) => text.includes(token));
        })
        .slice(0, limit)
        .map((item, index) => ({ item, rank: index }));
    },
    updatePlaybook(id, patch): Playbook | null {
      const playbook = state.playbooks.find((p) => p.id === id);
      if (!playbook) return null;
      const before = cloneValue(playbook);
      if (patch.title != null) playbook.title = patch.title;
      if (patch.description != null) playbook.description = patch.description;
      if (patch.instructions != null) playbook.instructions = patch.instructions;
      if (patch.references != null) playbook.references = [...patch.references];
      if (patch.templates != null) playbook.templates = [...patch.templates];
      if (patch.scripts != null) playbook.scripts = [...patch.scripts];
      if (patch.assets != null) playbook.assets = [...patch.assets];
      if (patch.tags != null) playbook.tags = [...patch.tags];
      if (patch.status != null) playbook.status = patch.status;
      playbook.updated_at = nowSeconds();
      this.insertMemoryEvent({
        ...normalizeScope(playbook),
        session_id: playbook.source_session_id,
        entity_kind: 'playbook',
        entity_id: String(playbook.id),
        event_type: 'playbook.updated',
        payload: {
          before,
          after: cloneValue(playbook),
          patch: cloneValue(patch as Record<string, unknown>),
        },
        created_at: playbook.updated_at,
      });
      return playbook;
    },
    recordPlaybookUse(id: number): void {
      const playbook = state.playbooks.find((p) => p.id === id);
      if (playbook) {
        const before = cloneValue(playbook);
        playbook.use_count += 1;
        playbook.last_used_at = nowSeconds();
        this.insertMemoryEvent({
          ...normalizeScope(playbook),
          session_id: playbook.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(playbook.id),
          event_type: 'playbook.used',
          payload: {
            before,
            after: cloneValue(playbook),
            refs: {
              use_count: playbook.use_count,
            },
          },
          created_at: playbook.last_used_at ?? nowSeconds(),
        });
      }
    },
    insertPlaybookRevision(input: NewPlaybookRevision): PlaybookRevision {
      const playbook = state.playbooks.find((p) => p.id === input.playbook_id);
      if (!playbook) {
        throw new Error(`Playbook ${input.playbook_id} not found`);
      }
      const now = nowSeconds();
      const record: PlaybookRevision = {
        tenant_id: playbook.tenant_id,
        system_id: playbook.system_id,
        workspace_id: playbook.workspace_id,
        collaboration_id: playbook.collaboration_id,
        scope_id: playbook.scope_id,
        id: ids.playbookRevision++,
        playbook_id: input.playbook_id,
        instructions: input.instructions,
        revision_reason: input.revision_reason,
        source_session_id: input.source_session_id ?? null,
        created_at: input.created_at ?? now,
      };
      state.playbookRevisions.push(record);
      playbook.revision_count += 1;
      this.insertMemoryEvent({
        ...normalizeScope(record),
        session_id: record.source_session_id,
        entity_kind: 'playbook_revision',
        entity_id: String(record.id),
        event_type: 'playbook.revised',
        payload: {
          after: cloneValue(record),
          refs: {
            playbook_id: record.playbook_id,
          },
        },
        created_at: record.created_at,
      });
      return record;
    },
    getPlaybookRevisions(playbookId: number): PlaybookRevision[] {
      return state.playbookRevisions
        .filter((r) => r.playbook_id === playbookId)
        .sort((a, b) => b.created_at - a.created_at);
    },

    insertAssociation(input: NewAssociation): Association {
      const scope = normalizeScope(input);
      // Enforce unique constraint
      const existing = state.associations.find(
        (a) =>
          a.source_kind === input.source_kind &&
          a.source_id === input.source_id &&
          a.target_kind === input.target_kind &&
          a.target_id === input.target_id &&
          a.association_type === input.association_type,
      );
      if (existing) {
        throw new UniqueConstraintError(
          `Association already exists: ${input.source_kind}:${input.source_id} -> ${input.target_kind}:${input.target_id} (${input.association_type})`,
        );
      }
      const record: Association = {
        ...scope,
        id: ids.association++,
        visibility_class: input.visibility_class ?? 'private',
        source_kind: input.source_kind,
        source_id: input.source_id,
        target_kind: input.target_kind,
        target_id: input.target_id,
        association_type: input.association_type,
        confidence: input.confidence ?? 0.5,
        auto_generated: input.auto_generated ?? false,
        created_at: input.created_at ?? nowSeconds(),
      };
      state.associations.push(record);
      this.insertMemoryEvent({
        ...scope,
        entity_kind: 'association',
        entity_id: String(record.id),
        event_type: 'association.created',
        payload: {
          after: cloneValue(record),
        },
        created_at: record.created_at,
      });
      return record;
    },
    getAssociationById(id: number): Association | null {
      return state.associations.find((a) => a.id === id) ?? null;
    },
    getAssociationsFrom(kind, id, scope): Association[] {
      return state.associations.filter(
        (a) => a.source_kind === kind && a.source_id === id && matchesScope(a, scope),
      );
    },
    getAssociationsTo(kind, id, scope): Association[] {
      return state.associations.filter(
        (a) => a.target_kind === kind && a.target_id === id && matchesScope(a, scope),
      );
    },
    listAssociations(scope): Association[] {
      return state.associations.filter((association) => matchesScope(association, scope));
    },
    deleteAssociation(id: number): void {
      const idx = state.associations.findIndex((a) => a.id === id);
      if (idx === -1) return;
      const [association] = state.associations.splice(idx, 1);
      this.insertMemoryEvent({
        ...normalizeScope(association),
        entity_kind: 'association',
        entity_id: String(association.id),
        event_type: 'association.deleted',
        payload: {
          before: cloneValue(association),
        },
        created_at: nowSeconds(),
      });
    },

    insertMemoryEvent(input) {
      const normalized = normalizeScope(input);
      const event: MemoryEventRecord = {
        ...normalized,
        event_id: String(ids.memoryEvent++),
        session_id: input.session_id ?? null,
        actor_id: input.actor_id ?? null,
        actor_kind: input.actor_kind ?? null,
        actor_system_id: input.actor_system_id ?? null,
        actor_display_name: input.actor_display_name ?? null,
        actor_metadata: input.actor_metadata ? cloneValue(input.actor_metadata) : null,
        entity_kind: input.entity_kind,
        entity_id: input.entity_id,
        event_type: input.event_type,
        payload: cloneValue(input.payload),
        causation_id: input.causation_id ?? null,
        correlation_id: input.correlation_id ?? null,
        created_at: input.created_at ?? nowSeconds(),
      };
      state.memoryEvents.push(event);
      const existing = state.projectionWatermarks.find(
        (item) => item.projection_name === 'temporal',
      );
      if (existing) {
        existing.last_event_id = event.event_id;
        existing.updated_at = event.created_at;
      }
      return cloneValue(event);
    },

    listMemoryEvents(scope, query) {
      return paginateEvents(
        state.memoryEvents.filter(
          (item) => matchesEventScope(item, scope) && matchesEventQuery(item, query),
        ),
        query,
      );
    },

    listMemoryEventsCrossScope(scope, level, query) {
      return paginateEvents(
        state.memoryEvents.filter(
          (item) => matchesScopeLevel(item, scope, level) && matchesEventQuery(item, query),
        ),
        query,
      );
    },

    getMemoryEventsByEntity(scope, entityKind, entityId, query) {
      return paginateEvents(
        state.memoryEvents.filter(
          (item) =>
            matchesEventScope(item, scope) &&
            item.entity_kind === entityKind &&
            item.entity_id === entityId &&
            matchesEventQuery(item, query),
        ),
        query,
      );
    },

    getMemoryEventsBySession(scope, sessionId, query) {
      return paginateEvents(
        state.memoryEvents.filter(
          (item) =>
            matchesEventScope(item, scope) &&
            item.session_id === sessionId &&
            matchesEventQuery(item, query),
        ),
        query,
      );
    },

    getSessionState(scope, sessionId) {
      const item =
        state.sessionStates.find(
          (entry) => matchesScope(entry, scope) && entry.session_id === sessionId,
        ) ?? null;
      return item ? cloneValue(item) : null;
    },

    upsertSessionState(input: NewSessionStateProjection) {
      const normalized = normalizeScope(input);
      const existing = state.sessionStates.find(
        (entry) => matchesScope(entry, normalized) && entry.session_id === input.session_id,
      );
      const next: SessionStateProjection = {
        ...normalized,
        session_id: input.session_id,
        currentObjective: input.currentObjective,
        blockers: [...input.blockers],
        assumptions: [...input.assumptions],
        pendingDecisions: [...input.pendingDecisions],
        activeTools: [...input.activeTools],
        recentOutputs: [...input.recentOutputs],
        updatedAt: input.updatedAt,
        source_event_id:
          input.source_event_id != null ? normalizeTemporalId(input.source_event_id) : null,
      };
      if (existing) {
        Object.assign(existing, next);
      } else {
        state.sessionStates.push(next);
      }
      this.insertMemoryEvent({
        ...normalized,
        session_id: input.session_id,
        entity_kind: 'session_state',
        entity_id: input.session_id,
        event_type: 'session_state.updated',
        payload: {
          after: cloneValue(next),
        },
        created_at: input.updatedAt,
      });
      return cloneValue(next);
    },

    getTemporalWatermark(projectionName = 'temporal') {
      const watermark =
        state.projectionWatermarks.find((item) => item.projection_name === projectionName) ?? null;
      return watermark ? cloneValue(watermark) : null;
    },

    upsertTemporalWatermark(input) {
      const updatedAt = input.updated_at ?? nowSeconds();
      const next: TemporalProjectionWatermark = {
        projection_name: input.projection_name,
        last_event_id: normalizeTemporalId(input.last_event_id),
        updated_at: updatedAt,
        cutover_at: input.cutover_at ?? null,
        metadata: input.metadata ? cloneValue(input.metadata) : null,
      };
      const existing = state.projectionWatermarks.find(
        (item) => item.projection_name === input.projection_name,
      );
      if (existing) {
        Object.assign(existing, next);
      } else {
        state.projectionWatermarks.push(next);
      }
      return cloneValue(next);
    },

    transaction(fn) {
      return fn();
    },

    close() {},
  };
}

export function createInMemoryAdapterWithEmbeddings(
  telemetry?: TelemetryOptions,
): StorageAdapter & { embeddings: import('../../contracts/embedding.js').EmbeddingAdapter } {
  const adapter = createInMemoryAdapter(telemetry);
  const embeddings = createInMemoryEmbeddingAdapter(adapter);
  return Object.assign(adapter, { embeddings });
}
