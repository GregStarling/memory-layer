import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type {
  ActorRef,
  HandoffRecord,
  NewHandoffInput,
  NewWorkClaimInput,
  WorkClaim,
  WorkClaimQuery,
  WorkItemPatch,
} from '../contracts/coordination.js';
import {
  matchesScope,
  matchesScopeLevel,
  normalizeScope,
  type MemoryScope,
  type ScopeLevel,
} from '../contracts/identity.js';
import { compareTemporalIds, normalizeTemporalId } from '../contracts/temporal.js';
import type {
  TemporalId,
  MemoryEventQuery,
  MemoryEventRecord,
  SessionStateProjection,
  TemporalProjectionWatermark,
  TimelineResult,
} from '../contracts/temporal.js';
import type { TemporalQueryOptions, FactsAtResult } from '../contracts/temporal-query.js';
import type { MemoryContext } from './context.js';
import type {
  Association,
  AssociationTargetKind,
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
  PaginationOptions,
  PaginatedResult,
  Playbook,
  PlaybookRevision,
  SearchOptions,
  SearchResult,
  TimeRange,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../contracts/types.js';
import { ValidationError } from '../contracts/errors.js';

export interface ReplayedTemporalState {
  turns: Turn[];
  workingMemory: WorkingMemory[];
  knowledge: KnowledgeMemory[];
  workItems: WorkItem[];
  workClaims: WorkClaim[];
  handoffs: HandoffRecord[];
  associations: Association[];
  playbooks: Playbook[];
  sessionStates: SessionStateProjection[];
  watermarkEventId: TemporalId | null;
}

const DEFAULT_MAX_ACCUMULATED_EVENTS = 5000;

export function normalizeWorkClaimAt(claim: WorkClaim, asOf: number): WorkClaim {
  if (claim.status !== 'active' || claim.expires_at > asOf) {
    return claim;
  }
  return {
    ...claim,
    status: 'expired',
    released_at: claim.released_at ?? claim.expires_at,
    release_reason: claim.release_reason ?? 'expired',
  };
}

export function normalizeHandoffAt(handoff: HandoffRecord, asOf: number): HandoffRecord {
  if (handoff.status !== 'pending' || handoff.expires_at == null || handoff.expires_at > asOf) {
    return handoff;
  }
  return {
    ...handoff,
    status: 'expired',
    decision_reason: handoff.decision_reason ?? 'expired',
  };
}

function unsupported(name: string): never {
  throw new Error(`Temporal replay adapter does not support ${name}`);
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
  return matches / queryTokens.size + (text.toLowerCase().includes(query.toLowerCase()) ? 0.25 : 0);
}

function inRange(createdAt: number, range: TimeRange): boolean {
  if (range.start_at !== undefined && createdAt < range.start_at) return false;
  if (range.end_at !== undefined && createdAt > range.end_at) return false;
  return true;
}

async function accumulateMemoryEvents(
  fetchPage: (cursor: MemoryEventQuery['cursor']) => Promise<TimelineResult>,
  initialCursor?: MemoryEventQuery['cursor'],
  maxEvents?: number,
): Promise<MemoryEventRecord[]> {
  const events: MemoryEventRecord[] = [];
  let cursor = initialCursor;
  const absoluteMaxEvents = maxEvents ?? DEFAULT_MAX_ACCUMULATED_EVENTS;
  for (;;) {
    const page = await fetchPage(cursor);
    events.push(...page.events);
    if (events.length > absoluteMaxEvents) {
      throw new ValidationError(
        `Memory validation: event range exceeds maximum of ${absoluteMaxEvents}`,
      );
    }
    if (page.nextCursor == null) break;
    if (cursor != null && compareTemporalIds(page.nextCursor, cursor) <= 0) {
      throw new ValidationError('Memory validation: event pagination cursor did not advance');
    }
    cursor = page.nextCursor;
  }
  return events;
}

function activeSearchKnowledge(items: KnowledgeMemory[], options?: SearchOptions): KnowledgeMemory[] {
  return items.filter((item) => {
    if (options?.activeOnly === false) return true;
    return item.superseded_by_id === null && item.retired_at === null;
  });
}

export async function listAllMemoryEvents(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  query?: MemoryEventQuery,
): Promise<MemoryEventRecord[]> {
  return accumulateMemoryEvents(
    (cursor) =>
      adapter.listMemoryEvents(scope, {
        ...query,
        cursor,
        limit: query?.limit ?? 500,
      }),
    query?.cursor,
  );
}

export async function listAllMemoryEventsBounded(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  maxEvents: number,
  query?: MemoryEventQuery,
): Promise<MemoryEventRecord[]> {
  return accumulateMemoryEvents(
    (cursor) =>
      adapter.listMemoryEvents(scope, {
        ...query,
        cursor,
        limit: query?.limit ?? 500,
      }),
    query?.cursor,
    maxEvents,
  );
}

export async function listAllMemoryEventsCrossScope(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  level: ScopeLevel,
  query?: MemoryEventQuery,
): Promise<MemoryEventRecord[]> {
  return accumulateMemoryEvents(
    (cursor) =>
      adapter.listMemoryEventsCrossScope(scope, level, {
        ...query,
        cursor,
        limit: query?.limit ?? 500,
      }),
    query?.cursor,
  );
}

export async function listAllMemoryEventsCrossScopeBounded(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  level: ScopeLevel,
  maxEvents: number,
  query?: MemoryEventQuery,
): Promise<MemoryEventRecord[]> {
  return accumulateMemoryEvents(
    (cursor) =>
      adapter.listMemoryEventsCrossScope(scope, level, {
        ...query,
        cursor,
        limit: query?.limit ?? 500,
      }),
    query?.cursor,
    maxEvents,
  );
}

export function foldTemporalState(
  events: MemoryEventRecord[],
  options: {
    sessionId?: string;
  } = {},
): ReplayedTemporalState {
  const turns = new Map<string, Turn>();
  const workingMemory = new Map<string, WorkingMemory>();
  const knowledge = new Map<string, KnowledgeMemory>();
  const workItems = new Map<string, WorkItem>();
  const workClaims = new Map<string, WorkClaim>();
  const handoffs = new Map<string, HandoffRecord>();
  const associations = new Map<string, Association>();
  const playbooks = new Map<string, Playbook>();
  const sessionStates = new Map<string, SessionStateProjection>();

  for (const event of [...events].sort(
    (a, b) => a.created_at - b.created_at || compareTemporalIds(a.event_id, b.event_id),
  )) {
    const payload = event.payload ?? {};
    const after = payload.after as Record<string, unknown> | undefined;
    const before = payload.before as Record<string, unknown> | undefined;
    switch (event.entity_kind) {
      case 'turn':
        if (after) turns.set(event.entity_id, after as unknown as Turn);
        break;
      case 'working_memory':
        if (after) workingMemory.set(event.entity_id, after as unknown as WorkingMemory);
        break;
      case 'knowledge_memory':
        if (after) knowledge.set(event.entity_id, after as unknown as KnowledgeMemory);
        break;
      case 'work_item':
        if (event.event_type === 'work_item.deleted') {
          workItems.delete(event.entity_id);
        } else if (after) {
          workItems.set(event.entity_id, after as unknown as WorkItem);
        }
        break;
      case 'association':
        if (event.event_type === 'association.deleted') {
          associations.delete(event.entity_id);
        } else if (after) {
          associations.set(event.entity_id, after as unknown as Association);
        }
        break;
      case 'work_claim':
        if (after) {
          workClaims.set(event.entity_id, after as unknown as WorkClaim);
        }
        break;
      case 'handoff':
        if (after) {
          handoffs.set(event.entity_id, after as unknown as HandoffRecord);
        }
        break;
      case 'playbook':
        if (after) playbooks.set(event.entity_id, after as unknown as Playbook);
        break;
      case 'session_state':
        if (after) sessionStates.set(event.entity_id, after as unknown as SessionStateProjection);
        break;
      default:
        break;
    }
  }

  const filteredTurns = [...turns.values()]
    .filter((turn) => !options.sessionId || turn.session_id === options.sessionId)
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const filteredWorkingMemory = [...workingMemory.values()]
    .filter((item) => !options.sessionId || item.session_id === options.sessionId)
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const filteredWorkItems = [...workItems.values()]
    .filter((item) => !options.sessionId || item.session_id == null || item.session_id === options.sessionId)
    .sort((a, b) => a.updated_at - b.updated_at || a.id - b.id);
  const filteredPlaybooks = [...playbooks.values()].sort(
    (a, b) => a.updated_at - b.updated_at || a.id - b.id,
  );
  const filteredAssociations = [...associations.values()].sort(
    (a, b) => a.created_at - b.created_at || a.id - b.id,
  );
  const filteredSessionStates = [...sessionStates.values()]
    .filter((item) => !options.sessionId || item.session_id === options.sessionId)
    .sort((a, b) => a.updatedAt - b.updatedAt);

  return {
    turns: filteredTurns,
    workingMemory: filteredWorkingMemory,
    knowledge: [...knowledge.values()].sort((a, b) => a.created_at - b.created_at || a.id - b.id),
    workItems: filteredWorkItems,
    workClaims: [...workClaims.values()].sort((a, b) => a.claimed_at - b.claimed_at || a.id - b.id),
    handoffs: [...handoffs.values()].sort((a, b) => a.created_at - b.created_at || a.id - b.id),
    associations: filteredAssociations,
    playbooks: filteredPlaybooks,
    sessionStates: filteredSessionStates,
    watermarkEventId: events.length > 0 ? events[events.length - 1].event_id : null,
  };
}

export function normalizeReplayedTemporalState(
  state: ReplayedTemporalState,
  asOf: number,
): ReplayedTemporalState {
  return {
    ...state,
    workClaims: state.workClaims
      .map((claim) => normalizeWorkClaimAt(claim, asOf))
      .sort((a, b) => a.claimed_at - b.claimed_at || a.id - b.id),
    handoffs: state.handoffs
      .map((handoff) => normalizeHandoffAt(handoff, asOf))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
  };
}

export function createTemporalReplayAdapter(
  state: ReplayedTemporalState,
  asOf: number,
): AsyncStorageAdapter {
  const replayState = normalizeReplayedTemporalState(state, asOf);
  const knowledgeById = new Map(replayState.knowledge.map((item) => [item.id, item]));
  return {
    insertTurn: () => unsupported('insertTurn'),
    insertTurns: () => unsupported('insertTurns'),
    getTurnById: async (id) => replayState.turns.find((turn) => turn.id === id) ?? null,
    getActiveTurns: async (scope, sessionId) =>
      replayState.turns.filter(
        (turn) =>
          matchesScope(turn, scope) &&
          turn.archived_at == null &&
          (sessionId == null || turn.session_id === sessionId),
      ),
    getActiveTurnsPaginated: async () => unsupported('getActiveTurnsPaginated'),
    getTurnsByTimeRange: async (scope, range) =>
      replayState.turns.filter(
        (turn) => matchesScope(turn, scope) && inRange(turn.created_at, range),
      ),
    searchTurns: async (scope, query, options) =>
      replayState.turns
        .filter((turn) => matchesScope(turn, scope) && (options?.activeOnly === false || turn.archived_at == null))
        .map((turn) => ({ item: turn, rank: scoreText(query, turn.content) }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.created_at - a.item.created_at)
        .slice(0, options?.limit ?? 10),
    archiveTurn: () => unsupported('archiveTurn'),
    getArchivedTurnRange: async (sessionId, startId, endId, scope) =>
      replayState.turns.filter(
        (turn) =>
          matchesScope(turn, scope) &&
          turn.session_id === sessionId &&
          turn.id >= startId &&
          turn.id <= endId &&
          turn.archived_at != null,
      ),
    insertWorkingMemory: () => unsupported('insertWorkingMemory'),
    getWorkingMemoryById: async (id) =>
      replayState.workingMemory.find((item) => item.id === id) ?? null,
    getWorkingMemoryBySession: async (sessionId, scope) =>
      replayState.workingMemory.filter(
        (item) => matchesScope(item, scope) && item.session_id === sessionId,
      ),
    getActiveWorkingMemory: async (scope, sessionId) =>
      replayState.workingMemory.filter(
        (item) =>
          matchesScope(item, scope) &&
          (sessionId == null || item.session_id === sessionId) &&
          (item.expires_at == null || item.expires_at > asOf),
      ),
    getLatestWorkingMemory: async (scope, sessionId) =>
      (
        await Promise.resolve(
          replayState.workingMemory
            .filter(
              (item) =>
                matchesScope(item, scope) &&
                (sessionId == null || item.session_id === sessionId) &&
                (item.expires_at == null || item.expires_at > asOf),
            )
            .sort((a, b) => b.id - a.id)[0] ?? null,
        )
      ),
    getWorkingMemoryByTimeRange: async (scope, range) =>
      replayState.workingMemory.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      ),
    expireWorkingMemory: () => unsupported('expireWorkingMemory'),
    markWorkingMemoryPromoted: () => unsupported('markWorkingMemoryPromoted'),
    insertKnowledgeMemory: () => unsupported('insertKnowledgeMemory'),
    insertKnowledgeMemories: () => unsupported('insertKnowledgeMemories'),
    insertKnowledgeCandidate: () => unsupported('insertKnowledgeCandidate'),
    insertKnowledgeCandidates: () => unsupported('insertKnowledgeCandidates'),
    getKnowledgeCandidateById: async () => null,
    listKnowledgeCandidates: async () => [],
    insertKnowledgeEvidence: () => unsupported('insertKnowledgeEvidence'),
    insertKnowledgeEvidenceBatch: () => unsupported('insertKnowledgeEvidenceBatch'),
    listKnowledgeEvidenceForKnowledge: async () => [],
    listKnowledgeEvidenceForCandidate: async () => [],
    promoteKnowledgeCandidate: () => unsupported('promoteKnowledgeCandidate'),
    deleteExpiredKnowledgeCandidates: () => unsupported('deleteExpiredKnowledgeCandidates'),
    getKnowledgeMemoryById: async (id) => knowledgeById.get(id) ?? null,
    getActiveKnowledgeMemory: async (scope) =>
      replayState.knowledge.filter(
        (item) =>
          matchesScope(item, scope) && item.superseded_by_id === null && item.retired_at === null,
      ),
    getActiveKnowledgeMemoryPaginated: async () => unsupported('getActiveKnowledgeMemoryPaginated'),
    getActiveKnowledgeCrossScope: async (scope, level) =>
      replayState.knowledge.filter(
        (item) =>
          matchesScopeLevel(item, scope, level) &&
          item.superseded_by_id === null &&
          item.retired_at === null,
      ),
    getKnowledgeSince: async (scope, level, since) =>
      replayState.knowledge.filter(
        (item) =>
          matchesScopeLevel(item, scope, level) &&
          item.created_at >= since &&
          item.superseded_by_id === null &&
          item.retired_at === null,
      ),
    getKnowledgeByTimeRange: async (scope, range) =>
      replayState.knowledge.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      ),
    searchKnowledge: async (scope, query, options) =>
      activeSearchKnowledge(
        replayState.knowledge.filter((item) => matchesScope(item, scope)),
        options,
      )
        .map((item) => ({ item, rank: scoreText(query, item.fact) }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
        .slice(0, options?.limit ?? 10),
    searchKnowledgeCrossScope: async (scope, level, query, options) =>
      activeSearchKnowledge(
        replayState.knowledge.filter((item) => matchesScopeLevel(item, scope, level)),
        options,
      )
        .map((item) => ({ item, rank: scoreText(query, item.fact) }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
        .slice(0, options?.limit ?? 10),
    insertKnowledgeMemoryAudit: () => unsupported('insertKnowledgeMemoryAudit'),
    getRecentKnowledgeMemoryAudits: async () => [],
    getKnowledgeMemoryAuditsForKnowledge: async () => [],
    updateKnowledgeMemory: () => unsupported('updateKnowledgeMemory'),
    touchKnowledgeMemory: async () => undefined,
    touchKnowledgeMemories: async () => undefined,
    retireKnowledgeMemory: () => unsupported('retireKnowledgeMemory'),
    supersedeKnowledgeMemory: () => unsupported('supersedeKnowledgeMemory'),
    insertWorkItem: () => unsupported('insertWorkItem'),
    getWorkItemById: async (id) => replayState.workItems.find((item) => item.id === id) ?? null,
    getActiveWorkItems: async (scope) =>
      replayState.workItems.filter((item) => matchesScope(item, scope) && item.status !== 'done'),
    getActiveWorkItemsCrossScope: async (scope, level) =>
      replayState.workItems.filter(
        (item) => matchesScopeLevel(item, scope, level) && item.status !== 'done',
      ),
    getWorkItemsByTimeRange: async (scope, range) =>
      replayState.workItems.filter(
        (item) => matchesScope(item, scope) && inRange(item.created_at, range),
      ),
    getWorkItemsByTimeRangeCrossScope: async (scope, level, range) =>
      replayState.workItems.filter(
        (item) => matchesScopeLevel(item, scope, level) && inRange(item.created_at, range),
      ),
    updateWorkItemStatus: () => unsupported('updateWorkItemStatus'),
    updateWorkItem: async () => unsupported('updateWorkItem'),
    deleteWorkItem: () => unsupported('deleteWorkItem'),
    claimWorkItem: async (_input: NewWorkClaimInput) => unsupported('claimWorkItem'),
    renewWorkClaim: async (_claimId: number, _actor: ActorRef, _leaseSeconds?: number) =>
      unsupported('renewWorkClaim'),
    releaseWorkClaim: async (_claimId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('releaseWorkClaim'),
    getWorkClaimById: async (claimId: number) =>
      replayState.workClaims.find((claim) => claim.id === claimId) ?? null,
    getActiveWorkClaim: async (workItemId: number) =>
      replayState.workClaims.find(
        (claim) => claim.work_item_id === workItemId && claim.status === 'active',
      ) ?? null,
    listWorkClaims: async (scope, options?: WorkClaimQuery) =>
      replayState.workClaims.filter((claim) => {
        if (!matchesScope(claim, scope)) return false;
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
      }),
    listWorkClaimsCrossScope: async (scope, level, options?: WorkClaimQuery) =>
      replayState.workClaims.filter((claim) => {
        if (!matchesScopeLevel(claim, scope, level)) return false;
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
      }),
    createHandoff: async (_input: NewHandoffInput) => unsupported('createHandoff'),
    getHandoffById: async (handoffId: number) =>
      replayState.handoffs.find((handoff) => handoff.id === handoffId) ?? null,
    acceptHandoff: async (_handoffId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('acceptHandoff'),
    rejectHandoff: async (_handoffId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('rejectHandoff'),
    cancelHandoff: async (_handoffId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('cancelHandoff'),
    listHandoffs: async (scope, options) =>
      replayState.handoffs.filter((handoff) => {
        if (!matchesScope(handoff, scope)) return false;
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
      }),
    listHandoffsCrossScope: async (scope, level, options) =>
      replayState.handoffs.filter((handoff) => {
        if (!matchesScopeLevel(handoff, scope, level)) return false;
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
      }),
    upsertContextMonitor: () => unsupported('upsertContextMonitor'),
    getContextMonitor: async () => null,
    insertCompactionLog: () => unsupported('insertCompactionLog'),
    getCompactionLogById: async () => null,
    getRecentCompactionLogs: async () => [],
    insertPlaybook: () => unsupported('insertPlaybook'),
    getPlaybookById: async (id) => replayState.playbooks.find((item) => item.id === id) ?? null,
    getActivePlaybooks: async (scope) =>
      replayState.playbooks.filter(
        (item) => matchesScope(item, scope) && (item.status === 'draft' || item.status === 'active'),
      ),
    getActivePlaybooksCrossScope: async (scope, level) =>
      replayState.playbooks.filter(
        (item) =>
          matchesScopeLevel(item, scope, level) &&
          (item.status === 'draft' || item.status === 'active'),
      ),
    searchPlaybooks: async (scope, query, options) =>
      replayState.playbooks
        .filter(
          (item) =>
            matchesScope(item, scope) &&
            (options?.activeOnly === false || (item.status !== 'archived' && item.status !== 'deprecated')),
        )
        .map((item) => ({
          item,
          rank: scoreText(query, `${item.title} ${item.description} ${item.instructions}`),
        }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.updated_at - a.item.updated_at)
        .slice(0, options?.limit ?? 10),
    searchPlaybooksCrossScope: async (scope, level, query, options) =>
      replayState.playbooks
        .filter(
          (item) =>
            matchesScopeLevel(item, scope, level) &&
            (options?.activeOnly === false || (item.status !== 'archived' && item.status !== 'deprecated')),
        )
        .map((item) => ({
          item,
          rank: scoreText(query, `${item.title} ${item.description} ${item.instructions}`),
        }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.updated_at - a.item.updated_at)
        .slice(0, options?.limit ?? 10),
    updatePlaybook: () => unsupported('updatePlaybook'),
    recordPlaybookUse: () => unsupported('recordPlaybookUse'),
    insertPlaybookRevision: () => unsupported('insertPlaybookRevision'),
    getPlaybookRevisions: async () => [],
    insertAssociation: () => unsupported('insertAssociation'),
    getAssociationById: async (id) =>
      replayState.associations.find((item) => item.id === id) ?? null,
    getAssociationsFrom: async (kind, id, scope) =>
      replayState.associations.filter(
        (item) =>
          matchesScope(item, scope) && item.source_kind === kind && item.source_id === id,
      ),
    getAssociationsTo: async (kind, id, scope) =>
      replayState.associations.filter(
        (item) =>
          matchesScope(item, scope) && item.target_kind === kind && item.target_id === id,
      ),
    listAssociations: async (scope) =>
      replayState.associations.filter((item) => matchesScope(item, scope)),
    deleteAssociation: () => unsupported('deleteAssociation'),
    insertMemoryEvent: () => unsupported('insertMemoryEvent'),
    listMemoryEvents: async () => unsupported('listMemoryEvents'),
    listMemoryEventsCrossScope: async () => unsupported('listMemoryEventsCrossScope'),
    getMemoryEventsByEntity: async () => unsupported('getMemoryEventsByEntity'),
    getMemoryEventsBySession: async () => unsupported('getMemoryEventsBySession'),
    getSessionState: async (scope, sessionId) =>
      replayState.sessionStates.find(
        (item) => matchesScope(item, scope) && item.session_id === sessionId,
      ) ?? null,
    upsertSessionState: async (input) => ({
      ...normalizeScope(input),
      session_id: input.session_id,
      currentObjective: input.currentObjective,
      blockers: [...input.blockers],
      assumptions: [...input.assumptions],
      pendingDecisions: [...input.pendingDecisions],
      activeTools: [...input.activeTools],
      recentOutputs: [...input.recentOutputs],
      updatedAt: input.updatedAt,
      source_event_id:
        input.source_event_id != null
          ? normalizeTemporalId(input.source_event_id)
          : replayState.watermarkEventId ?? null,
    }),
    getTemporalWatermark: async (): Promise<TemporalProjectionWatermark | null> => ({
      projection_name: 'temporal',
      last_event_id: replayState.watermarkEventId ?? '0',
      updated_at: asOf,
      cutover_at: asOf,
      metadata: null,
    }),
    upsertTemporalWatermark: () => unsupported('upsertTemporalWatermark'),
    insertSourceDocument: () => unsupported('insertSourceDocument'),
    getSourceDocumentById: async () => null,
    getSourceDocumentByHash: async () => null,
    listSourceDocuments: async () => ({ items: [], hasMore: false, nextCursor: null }),
    updateSourceDocument: () => unsupported('updateSourceDocument'),
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
}

/**
 * Fast temporal query: filters active knowledge by valid_from/valid_until
 * when validity windows are set. Falls back to getContextAt() replay for
 * facts without validity windows.
 */
export async function getFactsAt(
  adapter: AsyncStorageAdapter,
  getContextAt: (asOf: number) => Promise<MemoryContext>,
  options: TemporalQueryOptions,
): Promise<FactsAtResult> {
  const { timestamp, scope, knowledgeClass, fallbackToReplay } = options;

  const activeKnowledge = await adapter.getActiveKnowledgeMemory(scope);

  const withWindows: KnowledgeMemory[] = [];
  const withoutWindows: KnowledgeMemory[] = [];

  for (const fact of activeKnowledge) {
    if (fact.valid_from != null || fact.valid_until != null) {
      withWindows.push(fact);
    } else {
      withoutWindows.push(fact);
    }
  }

  // Fast path: filter windowed facts by timestamp (inclusive end day)
  const fastPathFacts = withWindows.filter((fact) => {
    const fromOk = fact.valid_from == null || fact.valid_from <= timestamp;
    const untilOk = fact.valid_until == null || fact.valid_until > timestamp;
    return fromOk && untilOk;
  });

  const filterByClass = (facts: KnowledgeMemory[]): KnowledgeMemory[] =>
    knowledgeClass ? facts.filter((f) => f.knowledge_class === knowledgeClass) : facts;

  // Pure fast path: all active facts have windows — no replay needed
  if (withoutWindows.length === 0) {
    return {
      facts: filterByClass(fastPathFacts),
      queryTimestamp: timestamp,
      usedFastPath: true,
    };
  }

  // Fallback disabled — return fast-path facts + unwindowed facts as-is
  // Note: this only covers currently-active facts; retired/superseded facts
  // that were valid at the queried timestamp require replay to surface.
  if (!fallbackToReplay) {
    return {
      facts: filterByClass([...fastPathFacts, ...withoutWindows]),
      queryTimestamp: timestamp,
      usedFastPath: withoutWindows.length === 0,
    };
  }

  // Replay captures the full historical picture including retired/superseded facts
  const context = await getContextAt(timestamp);
  const replayedFacts = [
    ...context.trustedCoreMemory,
    ...context.taskRelevantKnowledge,
    ...context.provisionalKnowledge,
    ...context.disputedKnowledge,
    ...context.relevantKnowledge,
    ...context.durableKnowledge,
  ];

  // Merge: use replayed facts as the base, then add any windowed fast-path
  // facts not already present in the replay (replay may miss some windowed
  // facts that are still active but weren't in the context at that time)
  const replayedIds = new Set(replayedFacts.map((f) => f.id));
  const supplemental = fastPathFacts.filter((f) => !replayedIds.has(f.id));

  return {
    facts: filterByClass([...replayedFacts, ...supplemental]),
    queryTimestamp: timestamp,
    usedFastPath: false,
  };
}
