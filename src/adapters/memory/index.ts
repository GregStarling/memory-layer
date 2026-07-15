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
  NewSourceDocument,
  NewWorkItem,
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
  validateNewKnowledgeMemory,
  validateNewKnowledgeMemoryAudit,
  validateNewTurn,
  validateNewWorkItem,
  validateNewWorkingMemory,
  validateTimeRange,
} from '../../core/validation.js';
import type {
  ContextContract,
  ContextInvariant,
  ContextEscalationPolicy,
  PersistedGovernanceState,
} from '../../contracts/context-contract.js';
import { createInMemoryEmbeddingAdapter } from './embeddings.js';
import {
  resolvePaginationOptions,
  resolveSearchOptions,
  scoreLexical,
} from '../shared/search.js';
import { isBaseVisible, eventVisibilityClass } from '../shared/visibility.js';
import { byCreatedAtThenId } from '../shared/ordering.js';

const SCHEMA_VERSION = 1;

/**
 * In-memory governance overlay (Phase 2.2/3.8 reference). Mirrors the SQLite
 * v18 soft-delete shape so `getGovernanceState` returns the same
 * `PersistedGovernanceState` structure. Keyed by normalized scope string.
 */
interface GovernanceEntry {
  defaultContract: PersistedGovernanceState['defaultContract'];
  namedContracts: Map<string, ContextContract>;
  deletedContractNames: Set<string>;
  invariants: Map<string, ContextInvariant>;
  deletedInvariantIds: Set<string>;
  escalationPolicy: ContextEscalationPolicy | null;
}

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
  sourceDocuments: SourceDocument[];
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

/**
 * Weighted lexical relevance for playbook search, normalized to (0,1], higher =
 * better (Phase 3.2 P2). Replaces the previous rank = array-index bug (which
 * violated both "higher = better" and the (0,1] scale). Title matches dominate,
 * then description, then instructions; a small combined-text term guarantees a
 * strictly-positive rank for any playbook the caller's token filter admitted.
 *
 * The admission filter (searchPlaybooks) is SUBSTRING-based
 * (`text.includes(token)`), while scoreLexical scores on EXACT tokens. A
 * playbook admitted only by a substring hit (query "deploy" ⊂ "deployment")
 * would otherwise score exactly 0 from scoreLexical, violating the (0,1] rank
 * contract for an admitted row. Floor the weighted score above 0 so every
 * admitted playbook carries a strictly-positive rank; the floor is far below any
 * real exact-token score, so it never reorders genuine matches.
 */
const PLAYBOOK_MATCH_FLOOR = 1e-9;
function rankPlaybook(
  query: string,
  playbook: { title: string; description: string; instructions: string },
): number {
  const combined = scoreLexical(
    query,
    `${playbook.title} ${playbook.description} ${playbook.instructions}`,
  );
  const weighted =
    scoreLexical(query, playbook.title) * 0.5 +
    scoreLexical(query, playbook.description) * 0.2 +
    scoreLexical(query, playbook.instructions) * 0.15 +
    combined * 0.15;
  return Math.max(weighted, PLAYBOOK_MATCH_FLOOR);
}

function scopeConfigKey(scope: MemoryScope, key: string): string {
  const normalized = normalizeScope(scope);
  return [
    normalized.tenant_id,
    normalized.system_id,
    normalized.workspace_id,
    normalized.collaboration_id,
    normalized.scope_id,
    key,
  ].join('::');
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

/**
 * Compute the EFFECTIVE view of a claim at `now` WITHOUT mutating stored state
 * (Phase 2.5). A read that observes an active-but-expired claim returns a copy
 * whose status is `expired`; the underlying store is left untouched — durable
 * expiry happens only in claim/renew/release and `expireStaleClaims`.
 */
function effectiveClaim(claim: WorkClaim, now: number): WorkClaim {
  if (!isClaimExpired(claim, now)) return claim;
  return {
    ...claim,
    status: 'expired',
    released_at: claim.released_at ?? now,
    release_reason: claim.release_reason ?? 'expired',
  };
}

function isHandoffExpired(handoff: HandoffRecord, now = nowSeconds()): boolean {
  return handoff.status === 'pending' && handoff.expires_at != null && handoff.expires_at <= now;
}

/**
 * Compute the EFFECTIVE view of a handoff at `now` WITHOUT mutating stored state
 * (Phase 2.5, D5 — handoff analogue of {@link effectiveClaim}). A read that
 * observes a pending-but-expired handoff returns a copy whose status is
 * `expired`; the underlying store is left untouched — durable expiry happens
 * only in accept/reject/cancel and `expireStaleHandoffs`.
 */
function effectiveHandoff(handoff: HandoffRecord, now: number): HandoffRecord {
  if (!isHandoffExpired(handoff, now)) return handoff;
  return {
    ...handoff,
    status: 'expired',
    decision_reason: handoff.decision_reason ?? 'expired',
  };
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
  // Ordering contract (Phase 2.3): event_id ASC alone. event_id is the
  // append-only monotonic id; created_at is display metadata only and may be
  // backdated, so it is never an ORDER BY key for pagination. Cursors are
  // event_id > ? (enforced in matchesEventQuery).
  const ordered = [...items].sort((a, b) => compareTemporalIds(a.event_id, b.event_id));
  const page = ordered.slice(0, resolved.limit + 1);
  const hasMore = page.length > resolved.limit;
  const events = hasMore ? page.slice(0, resolved.limit) : page;
  return {
    events,
    nextCursor: hasMore ? events[events.length - 1]?.event_id ?? null : null,
  };
}

function cloneGovernance(source: Map<string, GovernanceEntry>): Map<string, GovernanceEntry> {
  const copy = new Map<string, GovernanceEntry>();
  for (const [key, entry] of source) {
    copy.set(key, {
      defaultContract: structuredClone(entry.defaultContract),
      namedContracts: new Map(
        [...entry.namedContracts.entries()].map(([n, c]) => [n, structuredClone(c)]),
      ),
      deletedContractNames: new Set(entry.deletedContractNames),
      invariants: new Map(
        [...entry.invariants.entries()].map(([n, inv]) => [n, structuredClone(inv)]),
      ),
      deletedInvariantIds: new Set(entry.deletedInvariantIds),
      escalationPolicy: structuredClone(entry.escalationPolicy),
    });
  }
  return copy;
}

function governanceScopeKey(scope: MemoryScope): string {
  const n = normalizeScope(scope);
  return [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id].join('::');
}

export function createInMemoryAdapter(telemetry?: TelemetryOptions): StorageAdapter {
  const scopedConfig = new Map<string, { value: string; createdAt: number; updatedAt: number }>();
  const governance = new Map<string, GovernanceEntry>();

  function getGovernanceEntry(scope: MemoryScope): GovernanceEntry {
    const key = governanceScopeKey(scope);
    let entry = governance.get(key);
    if (!entry) {
      entry = {
        defaultContract: null,
        namedContracts: new Map(),
        deletedContractNames: new Set(),
        invariants: new Map(),
        deletedInvariantIds: new Set(),
        escalationPolicy: null,
      };
      governance.set(key, entry);
    }
    return entry;
  }
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
    sourceDocuments: [],
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
    sourceDocument: 1,
  };

  // Reentrancy guard for runInTransaction (declared below the returned object).
  let txnDepth = 0;

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
      // Atomicity (Phase 2.1): a mid-batch throw (e.g. an invalid input) must
      // leave NO rows or events from earlier items in the batch, matching the
      // relational adapters' transactional batch inserts.
      return runInTransaction(() => inputs.map((input) => this.insertTurn(input)));
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
      // Ordering contract (P3): created_at ASC, then id ASC.
      return state.turns
        .filter((turn) => matchesScope(turn, scope) && inRange(turn.created_at, range))
        .sort(byCreatedAtThenId);
    },

    searchTurns(scope, query, options) {
      const startedAt = Date.now();
      const resolved = resolveSearchOptions(options);
      const results = state.turns
        .filter((turn) => matchesScope(turn, scope) && (!resolved.activeOnly || turn.archived_at === null))
        .map((turn) => ({
          item: turn,
          rank: scoreLexical(query, turn.content),
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
      // Ordering contract (P3): created_at ASC, then id ASC.
      return state.workingMemory
        .filter((item) => item.session_id === sessionId && matchesScope(item, scope))
        .sort(byCreatedAtThenId);
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
      // Ordering contract (P3): created_at ASC, then id ASC.
      return state.workingMemory
        .filter((item) => matchesScope(item, scope) && inRange(item.created_at, range))
        .sort(byCreatedAtThenId);
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
      // P5: honor caller-supplied created_at (imports / time-travel); default to
      // now. last_accessed_at follows created_at on insert.
      const createdAt = input.created_at ?? nowSeconds();
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
        valid_from: input.valid_from ?? null,
        valid_until: input.valid_until ?? null,
        rationale: input.rationale ?? null,
        tags: input.tags ? [...input.tags] : [],
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
      // Atomicity (Phase 2.1): a mid-batch throw must leave NO rows or events
      // from earlier items, matching the relational adapters.
      return runInTransaction(() => inputs.map((input) => this.insertKnowledgeMemory(input)));
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
      this.insertMemoryEvent({
        ...scope,
        entity_kind: 'knowledge_candidate',
        entity_id: String(record.id),
        event_type: 'knowledge_candidate.created',
        payload: {
          after: cloneValue(record),
        },
        created_at: record.created_at,
      });
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
      // Atomic (Phase 2.2): candidate flip + knowledge insert + both events are
      // all-or-nothing. A throw from insertKnowledgeMemory (e.g. validation)
      // rolls back the candidate flip and any emitted events.
      return runInTransaction(() => {
        const candidate = state.knowledgeCandidates.find((item) => item.id === candidateId);
        const knowledge = this.insertKnowledgeMemory(input);
        if (candidate) {
          const before = cloneValue(candidate);
          candidate.promoted_knowledge_id = knowledge.id;
          candidate.state = 'provisional';
          this.insertMemoryEvent({
            ...normalizeScope(candidate),
            entity_kind: 'knowledge_candidate',
            entity_id: String(candidate.id),
            event_type: 'knowledge_candidate.promoted',
            payload: {
              before,
              after: cloneValue(candidate),
              refs: {
                knowledge_memory_id: knowledge.id,
              },
            },
            created_at: nowSeconds(),
          });
        }
        return knowledge;
      });
    },

    deleteExpiredKnowledgeCandidates(scope, olderThan) {
      const n = normalizeScope(scope);
      return runInTransaction(() => {
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
        const expiredIds = expired.map((c) => c.id);
        const expiredSet = new Set(expiredIds);
        state.knowledgeCandidates = state.knowledgeCandidates.filter(
          (c) => !expiredSet.has(c.id),
        );
        for (const candidate of expired) {
          this.insertMemoryEvent({
            ...normalizeScope(candidate),
            entity_kind: 'knowledge_candidate',
            entity_id: String(candidate.id),
            event_type: 'knowledge_candidate.expired',
            payload: {
              before: cloneValue(candidate),
            },
            created_at: nowSeconds(),
          });
        }
        return expiredIds;
      });
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
      // P6: cross-scope reads apply the base visibility gate so a private fact in
      // another scope never surfaces here, independent of any context view.
      // F6(d): pinned ordering created_at ASC, then id ASC (was insertion order).
      return state.knowledgeMemory
        .filter(
          (item) =>
            matchesScopeLevel(item, scope, level) &&
            isBaseVisible(item.visibility_class, item, scope) &&
            item.superseded_by_id === null &&
            item.retired_at === null,
        )
        .sort(byCreatedAtThenId);
    },

    getKnowledgeSince(scope, level, since) {
      // P6: base visibility gate on the cross-scope temporal read path.
      // F6(d): pinned ordering created_at ASC, then id ASC (was insertion order).
      return state.knowledgeMemory
        .filter(
          (item) =>
            matchesScopeLevel(item, scope, level) &&
            isBaseVisible(item.visibility_class, item, scope) &&
            item.created_at >= since &&
            item.superseded_by_id === null &&
            item.retired_at === null,
        )
        .sort(byCreatedAtThenId);
    },

    getKnowledgeByTimeRange(scope, range) {
      // Ordering contract (P3): created_at ASC, then id ASC.
      return state.knowledgeMemory
        .filter((item) => matchesScope(item, scope) && inRange(item.created_at, range))
        .sort(byCreatedAtThenId);
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
          rank: scoreLexical(query, item.fact),
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
            // P6: base visibility gate on the cross-scope lexical search path.
            isBaseVisible(item.visibility_class, item, scope) &&
            (!resolved.activeOnly ||
              (item.superseded_by_id === null && item.retired_at === null)),
        )
        .filter((item) => matchesKnowledgeSearchOptions(item, resolved))
        .map((item) => ({
          item,
          rank: scoreLexical(query, item.fact),
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
      // Ordering contract (P3): created_at ASC, then id ASC.
      return state.workItems
        .filter((item) => matchesScope(item, scope) && item.status !== 'done')
        .sort(byCreatedAtThenId);
    },

    getActiveWorkItemsCrossScope(scope, level) {
      // Ordering contract (P3) + P6 base visibility gate.
      return state.workItems
        .filter(
          (item) =>
            matchesScopeLevel(item, scope, level) &&
            isBaseVisible(item.visibility_class, item, scope) &&
            item.status !== 'done',
        )
        .sort(byCreatedAtThenId);
    },

    getWorkItemsByTimeRange(scope, range) {
      // Ordering contract (P3): created_at ASC, then id ASC.
      return state.workItems
        .filter((item) => matchesScope(item, scope) && inRange(item.created_at, range))
        .sort(byCreatedAtThenId);
    },

    getWorkItemsByTimeRangeCrossScope(scope, level, range) {
      // Ordering contract (P3) + P6 base visibility gate.
      return state.workItems
        .filter(
          (item) =>
            matchesScopeLevel(item, scope, level) &&
            isBaseVisible(item.visibility_class, item, scope) &&
            inRange(item.created_at, range),
        )
        .sort(byCreatedAtThenId);
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
      // Read path (D6): apply the SAME effective-status computation as the list
      // paths so an active-but-expired claim reads as `expired` here too, with
      // ZERO writes. Durable expiry happens only in claim/renew/release and
      // expireStaleClaims.
      const now = nowSeconds();
      const claim = state.workClaims.find((entry) => entry.id === claimId);
      if (!claim) return null;
      return cloneValue(effectiveClaim(claim, now));
    },

    getActiveWorkClaim(workItemId) {
      // Read path: compute effective status without writing (Phase 2.5).
      const now = nowSeconds();
      const claim = state.workClaims.find(
        (entry) => entry.work_item_id === workItemId && entry.status === 'active',
      );
      if (!claim) return null;
      if (isClaimExpired(claim, now)) return null;
      return cloneValue(claim);
    },

    listWorkClaims(scope, options?: WorkClaimQuery) {
      // Read path: compute effective status without writing (Phase 2.5).
      const now = nowSeconds();
      return state.workClaims
        .filter((claim) => matchesScope(claim, scope))
        .map((claim) => effectiveClaim(claim, now))
        .filter((claim) => {
          if (!options?.includeExpired && claim.status === 'expired') return false;
          if (!options?.includeReleased && claim.status === 'released') return false;
          if (options?.sessionId && claim.session_id !== options.sessionId) return false;
          if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
          if (options?.actor && !matchesActor(options.actor, claim.actor)) return false;
          return true;
        })
        .map(cloneValue);
    },

    listWorkClaimsCrossScope(scope, level: ScopeLevel, options?: WorkClaimQuery) {
      // Read path: compute effective status without writing (Phase 2.5).
      const now = nowSeconds();
      return state.workClaims
        // P6: base visibility gate on the cross-scope claim read path.
        .filter(
          (claim) =>
            matchesScopeLevel(claim, scope, level) &&
            isBaseVisible(claim.visibility_class, claim, scope),
        )
        .map((claim) => effectiveClaim(claim, now))
        .filter((claim) => {
          if (!options?.includeExpired && claim.status === 'expired') return false;
          if (!options?.includeReleased && claim.status === 'released') return false;
          if (options?.sessionId && claim.session_id !== options.sessionId) return false;
          if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
          if (options?.actor && !matchesActor(options.actor, claim.actor)) return false;
          return true;
        })
        .map(cloneValue);
    },

    expireStaleClaims(scope, now) {
      // Durable expiry write path (Phase 2.5 reaper): transactional, emits
      // exactly one work_claim.expired event per newly-expired claim.
      return runInTransaction(() => {
        const expiredIds: number[] = [];
        for (const claim of state.workClaims) {
          if (!matchesScope(claim, scope)) continue;
          if (!isClaimExpired(claim, now)) continue;
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
          expiredIds.push(claim.id);
        }
        return expiredIds;
      });
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
      // Read path (D6): apply the SAME effective-status computation as the list
      // paths so a pending-but-expired handoff reads as `expired` here too, with
      // ZERO writes. Durable expiry happens only in accept/reject/cancel and
      // expireStaleHandoffs.
      const now = nowSeconds();
      const handoff = state.handoffs.find((entry) => entry.id === handoffId);
      if (!handoff) return null;
      return cloneValue(effectiveHandoff(handoff, now));
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
      // Read path (D5): compute effective status without writing. Durable expiry
      // happens only in accept/reject/cancel and expireStaleHandoffs (the
      // maintenance reaper), so repeated list calls emit ZERO events.
      const now = nowSeconds();
      return state.handoffs
        .filter((handoff) => matchesScope(handoff, scope))
        .map((handoff) => effectiveHandoff(handoff, now))
        .filter((handoff) => {
          if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
          if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
          if (!options?.actor) return true;
          if (options.direction === 'inbound') return matchesActor(options.actor, handoff.to_actor);
          if (options.direction === 'outbound') return matchesActor(options.actor, handoff.from_actor);
          return (
            matchesActor(options.actor, handoff.to_actor) ||
            matchesActor(options.actor, handoff.from_actor)
          );
        })
        .map(cloneValue);
    },

    listHandoffsCrossScope(scope, level: ScopeLevel, options?: HandoffQuery) {
      // Read path (D5): compute effective status without writing (see listHandoffs).
      const now = nowSeconds();
      return state.handoffs
        // P6: base visibility gate on the cross-scope handoff read path.
        .filter(
          (handoff) =>
            matchesScopeLevel(handoff, scope, level) &&
            isBaseVisible(handoff.visibility_class, handoff, scope),
        )
        .map((handoff) => effectiveHandoff(handoff, now))
        .filter((handoff) => {
          if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
          if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
          if (!options?.actor) return true;
          if (options.direction === 'inbound') return matchesActor(options.actor, handoff.to_actor);
          if (options.direction === 'outbound') return matchesActor(options.actor, handoff.from_actor);
          return (
            matchesActor(options.actor, handoff.to_actor) ||
            matchesActor(options.actor, handoff.from_actor)
          );
        })
        .map(cloneValue);
    },

    expireStaleHandoffs(scope, now) {
      // Durable expiry write path (Phase 2.5 reaper, D5): transactional, emits
      // exactly one handoff.expired event per newly-expired pending handoff.
      return runInTransaction(() => {
        const expiredIds: number[] = [];
        for (const handoff of state.handoffs) {
          if (!matchesScope(handoff, scope)) continue;
          if (!isHandoffExpired(handoff, now)) continue;
          handoff.status = 'expired';
          handoff.decision_reason = handoff.decision_reason ?? 'expired';
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
            created_at: now,
          });
          expiredIds.push(handoff.id);
        }
        return expiredIds;
      });
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
        // Parity: undefined defaults to false on every adapter (pg schema says
        // DEFAULT FALSE; sqlite's `? 1 : 0` coercion yields 0) — this was `true`
        // here, a three-way divergence caught by the pg leg's NOT NULL violation.
        model_call_made: input.model_call_made ?? false,
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
        rationale: input.rationale ?? null,
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
      // P6: base visibility gate on the cross-scope playbook read path.
      // F6(d): pinned ordering created_at ASC, then id ASC (was insertion order).
      return state.playbooks
        .filter(
          (p) =>
            matchesScopeLevel(p, scope, level) &&
            isBaseVisible(p.visibility_class, p, scope) &&
            (p.status === 'draft' || p.status === 'active'),
        )
        .sort(byCreatedAtThenId);
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
        .map((item) => ({ item, rank: rankPlaybook(query, item) }))
        // P2: rank is a real (0,1] relevance score (was the array index); order by
        // rank DESC (higher=better), id ASC as the stable tie-break.
        .sort((a, b) => b.rank - a.rank || a.item.id - b.item.id)
        .slice(0, limit);
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
          // P6: base visibility gate on the cross-scope playbook search path.
          if (!matchesScopeLevel(p, scope, level)) return false;
          if (!isBaseVisible(p.visibility_class, p, scope)) return false;
          if (activeOnly && (p.status === 'archived' || p.status === 'deprecated')) return false;
          const text = `${p.title} ${p.description} ${p.instructions}`.toLowerCase();
          return tokens.every((token) => text.includes(token));
        })
        .map((item) => ({ item, rank: rankPlaybook(query, item) }))
        .sort((a, b) => b.rank - a.rank || a.item.id - b.item.id)
        .slice(0, limit);
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
      if (patch.rationale !== undefined) playbook.rationale = patch.rationale ?? null;
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
      // D1: a revision mutates the parent playbook (revision_count, updated_at).
      // Emit BOTH the revision audit event (playbook.revised) AND a playbook
      // after-snapshot (playbook.updated) so temporal replay reconstructs the
      // bumped revision_count/updated_at — foldTemporalState only folds the
      // `playbook` entity kind, not `playbook_revision`. All-or-nothing.
      return runInTransaction(() => {
        state.playbookRevisions.push(record);
        playbook.revision_count += 1;
        playbook.updated_at = record.created_at;
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
        this.insertMemoryEvent({
          ...normalizeScope(playbook),
          session_id: playbook.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(playbook.id),
          event_type: 'playbook.updated',
          payload: {
            after: cloneValue(playbook),
            refs: {
              revision_id: record.id,
              revision_count: playbook.revision_count,
            },
          },
          created_at: playbook.updated_at,
        });
        return record;
      });
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
        provenance: input.provenance ?? 'inferred',
        confidence: input.confidence ?? 0.8,
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
          (item) =>
            matchesScopeLevel(item, scope, level) &&
            // F4/P6: events embed the full entity snapshot (incl. fact text) in
            // payload.after, so a cross-scope event read MUST apply the base
            // visibility gate or a private fact from another scope leaks its
            // contents. Visibility is derived from the snapshot's
            // visibility_class (default 'private' when absent).
            isBaseVisible(eventVisibilityClass(item.payload), item, scope) &&
            matchesEventQuery(item, query),
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

    insertSourceDocument(input: NewSourceDocument): SourceDocument {
      const n = normalizeScope(input);
      const doc: SourceDocument = {
        ...n,
        id: ids.sourceDocument++,
        title: input.title,
        content_hash: input.content_hash,
        mime_type: input.mime_type ?? 'text/plain',
        url: input.url ?? null,
        metadata: input.metadata ?? {},
        status: input.status ?? 'pending',
        fact_count: 0,
        token_estimate: input.token_estimate ?? 0,
        created_at: nowSeconds(),
        processed_at: null,
      };
      state.sourceDocuments.push(doc);
      this.insertMemoryEvent({
        ...n,
        entity_kind: 'source_document',
        entity_id: String(doc.id),
        event_type: 'source_document.created',
        payload: {
          after: cloneValue(doc),
        },
        created_at: doc.created_at,
      });
      return cloneValue(doc);
    },

    getSourceDocumentById(id: number): SourceDocument | null {
      const doc = state.sourceDocuments.find((d) => d.id === id);
      return doc ? cloneValue(doc) : null;
    },

    getSourceDocumentByHash(contentHash: string, scope: MemoryScope): SourceDocument | null {
      const n = normalizeScope(scope);
      const doc = state.sourceDocuments.find(
        (d) =>
          d.content_hash === contentHash &&
          d.tenant_id === n.tenant_id &&
          d.system_id === n.system_id &&
          d.workspace_id === n.workspace_id &&
          d.collaboration_id === n.collaboration_id &&
          d.scope_id === n.scope_id,
      );
      return doc ? cloneValue(doc) : null;
    },

    listSourceDocuments(scope: MemoryScope, options?: PaginationOptions): PaginatedResult<SourceDocument> {
      const n = normalizeScope(scope);
      const limit = options?.limit ?? 50;
      const cursor = typeof options?.cursor === 'number' ? options.cursor : undefined;
      let filtered = state.sourceDocuments.filter(
        (d) =>
          d.tenant_id === n.tenant_id &&
          d.system_id === n.system_id &&
          d.workspace_id === n.workspace_id &&
          d.collaboration_id === n.collaboration_id &&
          d.scope_id === n.scope_id,
      );
      filtered.sort((a, b) => b.id - a.id);
      if (cursor != null) {
        filtered = filtered.filter((d) => d.id < cursor);
      }
      const hasMore = filtered.length > limit;
      const items = filtered.slice(0, limit).map(cloneValue);
      return { items, hasMore, nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null };
    },

    updateSourceDocument(id: number, patch: { status?: SourceDocumentStatus; fact_count?: number; processed_at?: number | null }): SourceDocument | null {
      const doc = state.sourceDocuments.find((d) => d.id === id);
      if (!doc) return null;
      const before = cloneValue(doc);
      if (patch.status !== undefined) doc.status = patch.status;
      if (patch.fact_count !== undefined) doc.fact_count = patch.fact_count;
      if (patch.processed_at !== undefined) doc.processed_at = patch.processed_at;
      this.insertMemoryEvent({
        ...normalizeScope(doc),
        entity_kind: 'source_document',
        entity_id: String(doc.id),
        event_type: 'source_document.updated',
        payload: {
          before,
          after: cloneValue(doc),
          patch: cloneValue(patch as Record<string, unknown>),
        },
        created_at: nowSeconds(),
      });
      return cloneValue(doc);
    },

    getScopeConfig(scope, key): string | null {
      return scopedConfig.get(scopeConfigKey(scope, key))?.value ?? null;
    },

    setScopeConfig(scope, key, value): void {
      const compositeKey = scopeConfigKey(scope, key);
      const now = nowSeconds();
      const existing = scopedConfig.get(compositeKey);
      scopedConfig.set(compositeKey, {
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    getGovernanceState(scope): PersistedGovernanceState | null {
      const key = governanceScopeKey(scope);
      const entry = governance.get(key);
      if (!entry) return null;
      const hasAny =
        entry.defaultContract != null ||
        entry.namedContracts.size > 0 ||
        entry.deletedContractNames.size > 0 ||
        entry.invariants.size > 0 ||
        entry.deletedInvariantIds.size > 0 ||
        entry.escalationPolicy != null;
      if (!hasAny) return null;
      return {
        defaultContract: structuredClone(entry.defaultContract),
        namedContracts: Object.fromEntries(
          [...entry.namedContracts.entries()].map(([n, c]) => [n, structuredClone(c)]),
        ),
        deletedContractNames: [...entry.deletedContractNames],
        invariants: [...entry.invariants.values()].map((inv) => structuredClone(inv)),
        deletedInvariantIds: [...entry.deletedInvariantIds],
        escalationPolicy: structuredClone(entry.escalationPolicy),
      };
    },

    upsertDefaultContextContract(scope, contract) {
      runInTransaction(() => {
        const entry = getGovernanceEntry(scope);
        entry.defaultContract =
          contract == null ? { state: 'cleared' } : { state: 'set', contract: cloneValue(contract) };
        this.insertMemoryEvent({
          ...normalizeScope(scope),
          entity_kind: 'context_contract',
          entity_id: '__default__',
          event_type: contract == null ? 'context_contract.deleted' : 'context_contract.set',
          payload: {
            after: cloneValue(entry.defaultContract),
            refs: { name: null, isDefault: true },
          },
          created_at: nowSeconds(),
        });
      });
    },

    upsertNamedContextContract(scope, name, contract) {
      runInTransaction(() => {
        const entry = getGovernanceEntry(scope);
        entry.namedContracts.set(name, cloneValue(contract));
        entry.deletedContractNames.delete(name);
        this.insertMemoryEvent({
          ...normalizeScope(scope),
          entity_kind: 'context_contract',
          entity_id: name,
          event_type: 'context_contract.set',
          payload: {
            after: cloneValue(contract),
            refs: { name, isDefault: false },
          },
          created_at: nowSeconds(),
        });
      });
    },

    deleteNamedContextContract(scope, name): boolean {
      return runInTransaction(() => {
        const entry = getGovernanceEntry(scope);
        const existed = entry.namedContracts.delete(name);
        entry.deletedContractNames.add(name);
        this.insertMemoryEvent({
          ...normalizeScope(scope),
          entity_kind: 'context_contract',
          entity_id: name,
          event_type: 'context_contract.deleted',
          payload: {
            refs: { name, isDefault: false, existed },
          },
          created_at: nowSeconds(),
        });
        return existed;
      });
    },

    upsertContextInvariant(scope, invariant) {
      runInTransaction(() => {
        const entry = getGovernanceEntry(scope);
        entry.invariants.set(invariant.id, cloneValue(invariant));
        entry.deletedInvariantIds.delete(invariant.id);
        this.insertMemoryEvent({
          ...normalizeScope(scope),
          entity_kind: 'context_invariant',
          entity_id: invariant.id,
          event_type: 'context_invariant.set',
          payload: {
            after: cloneValue(invariant),
          },
          created_at: nowSeconds(),
        });
      });
    },

    deleteContextInvariant(scope, invariantId): boolean {
      return runInTransaction(() => {
        const entry = getGovernanceEntry(scope);
        const existed = entry.invariants.delete(invariantId);
        entry.deletedInvariantIds.add(invariantId);
        this.insertMemoryEvent({
          ...normalizeScope(scope),
          entity_kind: 'context_invariant',
          entity_id: invariantId,
          event_type: 'context_invariant.deleted',
          payload: {
            refs: { invariantId, existed },
          },
          created_at: nowSeconds(),
        });
        return existed;
      });
    },

    upsertContextEscalationPolicy(scope, policy) {
      runInTransaction(() => {
        const entry = getGovernanceEntry(scope);
        entry.escalationPolicy = cloneValue(policy);
        this.insertMemoryEvent({
          ...normalizeScope(scope),
          entity_kind: 'context_escalation_policy',
          entity_id: '__policy__',
          event_type: 'context_escalation_policy.set',
          payload: {
            after: cloneValue(policy),
          },
          created_at: nowSeconds(),
        });
      });
    },

    transaction(fn) {
      return runInTransaction(fn);
    },

    close() {},
  };

  /**
   * Genuine synchronous transaction (Phase 2.1/3.7 partial): snapshot every
   * mutable store before running `fn`; on throw, restore the snapshot so no
   * partial state (rows or events) survives. Nested calls reuse the outermost
   * snapshot so an inner rollback is subsumed by the outer one.
   *
   * `structuredClone` is used for a deep, reference-independent copy; ids and
   * scopedConfig are captured too so a rolled-back write does not leak an
   * advanced id counter or a config mutation.
   */
  function runInTransaction<T>(fn: () => T): T {
    if (txnDepth > 0) {
      // Already inside a transaction; the outer frame owns rollback.
      txnDepth += 1;
      try {
        return fn();
      } finally {
        txnDepth -= 1;
      }
    }
    const stateSnapshot = structuredClone(state);
    const idsSnapshot = { ...ids };
    const configSnapshot = new Map(
      [...scopedConfig.entries()].map(([key, value]) => [key, { ...value }]),
    );
    const governanceSnapshot = cloneGovernance(governance);
    txnDepth = 1;
    try {
      const result = fn();
      txnDepth = 0;
      return result;
    } catch (error) {
      // Restore each field in place so closures capturing `state` see the
      // rolled-back values (we mutate the existing object, not reassign it).
      Object.assign(state, stateSnapshot);
      Object.assign(ids, idsSnapshot);
      scopedConfig.clear();
      for (const [key, value] of configSnapshot) scopedConfig.set(key, value);
      governance.clear();
      for (const [key, value] of governanceSnapshot) governance.set(key, value);
      txnDepth = 0;
      throw error;
    }
  }
}

export function createInMemoryAdapterWithEmbeddings(
  telemetry?: TelemetryOptions,
): StorageAdapter & { embeddings: import('../../contracts/embedding.js').EmbeddingAdapter } {
  const adapter = createInMemoryAdapter(telemetry);
  const embeddings = createInMemoryEmbeddingAdapter(adapter);
  return Object.assign(adapter, { embeddings });
}
