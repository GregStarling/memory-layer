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
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type {
  MemoryEventQuery,
  MemoryEventRecord,
  SessionStateProjection,
  TemporalProjectionWatermark,
  TimelineResult,
} from '../contracts/temporal.js';
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
  watermarkEventId: number | null;
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

function matchesScope(item: MemoryScope, scope: MemoryScope): boolean {
  const left = normalizeScope(item);
  const right = normalizeScope(scope);
  return (
    left.tenant_id === right.tenant_id &&
    left.system_id === right.system_id &&
    left.workspace_id === right.workspace_id &&
    left.collaboration_id === right.collaboration_id &&
    left.scope_id === right.scope_id
  );
}

function matchesLevel(item: MemoryScope, scope: MemoryScope, level: ScopeLevel): boolean {
  const left = normalizeScope(item);
  const right = normalizeScope(scope);
  if (left.tenant_id !== right.tenant_id) return false;
  if (level === 'tenant') return true;
  if (level === 'workspace') return left.workspace_id === right.workspace_id;
  if (left.system_id !== right.system_id) return false;
  if (level === 'system') return true;
  return matchesScope(left, right);
}

function inRange(createdAt: number, range: TimeRange): boolean {
  if (range.start_at !== undefined && createdAt < range.start_at) return false;
  if (range.end_at !== undefined && createdAt > range.end_at) return false;
  return true;
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
  const events: MemoryEventRecord[] = [];
  let cursor = query?.cursor;
  for (;;) {
    const page: TimelineResult = await adapter.listMemoryEvents(scope, {
      ...query,
      cursor,
      limit: query?.limit ?? 500,
    });
    events.push(...page.events);
    if (page.nextCursor == null) break;
    cursor = page.nextCursor;
  }
  return events;
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

  for (const event of [...events].sort((a, b) => a.created_at - b.created_at || a.event_id - b.event_id)) {
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

export function createTemporalReplayAdapter(
  state: ReplayedTemporalState,
  asOf: number,
): AsyncStorageAdapter {
  const knowledgeById = new Map(state.knowledge.map((item) => [item.id, item]));
  return {
    insertTurn: () => unsupported('insertTurn'),
    insertTurns: () => unsupported('insertTurns'),
    getTurnById: async (id) => state.turns.find((turn) => turn.id === id) ?? null,
    getActiveTurns: async (scope, sessionId) =>
      state.turns.filter(
        (turn) =>
          matchesScope(turn, scope) &&
          turn.archived_at == null &&
          (sessionId == null || turn.session_id === sessionId),
      ),
    getActiveTurnsPaginated: async () => unsupported('getActiveTurnsPaginated'),
    getTurnsByTimeRange: async (scope, range) =>
      state.turns.filter((turn) => matchesScope(turn, scope) && inRange(turn.created_at, range)),
    searchTurns: async (scope, query, options) =>
      state.turns
        .filter((turn) => matchesScope(turn, scope) && (options?.activeOnly === false || turn.archived_at == null))
        .map((turn) => ({ item: turn, rank: scoreText(query, turn.content) }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.created_at - a.item.created_at)
        .slice(0, options?.limit ?? 10),
    archiveTurn: () => unsupported('archiveTurn'),
    getArchivedTurnRange: async (sessionId, startId, endId, scope) =>
      state.turns.filter(
        (turn) =>
          matchesScope(turn, scope) &&
          turn.session_id === sessionId &&
          turn.id >= startId &&
          turn.id <= endId &&
          turn.archived_at != null,
      ),
    insertWorkingMemory: () => unsupported('insertWorkingMemory'),
    getWorkingMemoryById: async (id) => state.workingMemory.find((item) => item.id === id) ?? null,
    getWorkingMemoryBySession: async (sessionId, scope) =>
      state.workingMemory.filter(
        (item) => matchesScope(item, scope) && item.session_id === sessionId,
      ),
    getActiveWorkingMemory: async (scope, sessionId) =>
      state.workingMemory.filter(
        (item) =>
          matchesScope(item, scope) &&
          (sessionId == null || item.session_id === sessionId) &&
          (item.expires_at == null || item.expires_at > asOf),
      ),
    getLatestWorkingMemory: async (scope, sessionId) =>
      (
        await Promise.resolve(
          state.workingMemory
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
      state.workingMemory.filter(
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
    getKnowledgeMemoryById: async (id) => knowledgeById.get(id) ?? null,
    getActiveKnowledgeMemory: async (scope) =>
      state.knowledge.filter(
        (item) =>
          matchesScope(item, scope) && item.superseded_by_id === null && item.retired_at === null,
      ),
    getActiveKnowledgeMemoryPaginated: async () => unsupported('getActiveKnowledgeMemoryPaginated'),
    getActiveKnowledgeCrossScope: async (scope, level) =>
      state.knowledge.filter(
        (item) =>
          matchesLevel(item, scope, level) &&
          item.superseded_by_id === null &&
          item.retired_at === null,
      ),
    getKnowledgeSince: async (scope, level, since) =>
      state.knowledge.filter(
        (item) =>
          matchesLevel(item, scope, level) &&
          item.created_at >= since &&
          item.superseded_by_id === null &&
          item.retired_at === null,
      ),
    getKnowledgeByTimeRange: async (scope, range) =>
      state.knowledge.filter((item) => matchesScope(item, scope) && inRange(item.created_at, range)),
    searchKnowledge: async (scope, query, options) =>
      activeSearchKnowledge(
        state.knowledge.filter((item) => matchesScope(item, scope)),
        options,
      )
        .map((item) => ({ item, rank: scoreText(query, item.fact) }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
        .slice(0, options?.limit ?? 10),
    searchKnowledgeCrossScope: async (scope, level, query, options) =>
      activeSearchKnowledge(
        state.knowledge.filter((item) => matchesLevel(item, scope, level)),
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
    getWorkItemById: async (id) => state.workItems.find((item) => item.id === id) ?? null,
    getActiveWorkItems: async (scope) =>
      state.workItems.filter((item) => matchesScope(item, scope) && item.status !== 'done'),
    getActiveWorkItemsCrossScope: async (scope, level) =>
      state.workItems.filter((item) => matchesLevel(item, scope, level) && item.status !== 'done'),
    getWorkItemsByTimeRange: async (scope, range) =>
      state.workItems.filter((item) => matchesScope(item, scope) && inRange(item.created_at, range)),
    getWorkItemsByTimeRangeCrossScope: async (scope, level, range) =>
      state.workItems.filter((item) => matchesLevel(item, scope, level) && inRange(item.created_at, range)),
    updateWorkItemStatus: () => unsupported('updateWorkItemStatus'),
    updateWorkItem: async () => unsupported('updateWorkItem'),
    deleteWorkItem: () => unsupported('deleteWorkItem'),
    claimWorkItem: async (_input: NewWorkClaimInput) => unsupported('claimWorkItem'),
    renewWorkClaim: async (_claimId: number, _actor: ActorRef, _leaseSeconds?: number) =>
      unsupported('renewWorkClaim'),
    releaseWorkClaim: async (_claimId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('releaseWorkClaim'),
    getActiveWorkClaim: async (workItemId: number) =>
      state.workClaims.find(
        (claim) => claim.work_item_id === workItemId && claim.status === 'active' && claim.expires_at > asOf,
      ) ?? null,
    listWorkClaims: async (scope, options?: WorkClaimQuery) =>
      state.workClaims.filter((claim) => {
        if (!matchesScope(claim, scope)) return false;
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
      state.workClaims.filter((claim) => {
        if (!matchesLevel(claim, scope, level)) return false;
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
    acceptHandoff: async (_handoffId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('acceptHandoff'),
    rejectHandoff: async (_handoffId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('rejectHandoff'),
    cancelHandoff: async (_handoffId: number, _actor: ActorRef, _reason?: string) =>
      unsupported('cancelHandoff'),
    listHandoffs: async (scope, options) =>
      state.handoffs.filter((handoff) => {
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
      state.handoffs.filter((handoff) => {
        if (!matchesLevel(handoff, scope, level)) return false;
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
    getPlaybookById: async (id) => state.playbooks.find((item) => item.id === id) ?? null,
    getActivePlaybooks: async (scope) =>
      state.playbooks.filter(
        (item) => matchesScope(item, scope) && (item.status === 'draft' || item.status === 'active'),
      ),
    getActivePlaybooksCrossScope: async (scope, level) =>
      state.playbooks.filter(
        (item) => matchesLevel(item, scope, level) && (item.status === 'draft' || item.status === 'active'),
      ),
    searchPlaybooks: async (scope, query, options) =>
      state.playbooks
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
      state.playbooks
        .filter(
          (item) =>
            matchesLevel(item, scope, level) &&
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
    getAssociationById: async (id) => state.associations.find((item) => item.id === id) ?? null,
    getAssociationsFrom: async (kind, id, scope) =>
      state.associations.filter(
        (item) =>
          matchesScope(item, scope) && item.source_kind === kind && item.source_id === id,
      ),
    getAssociationsTo: async (kind, id, scope) =>
      state.associations.filter(
        (item) =>
          matchesScope(item, scope) && item.target_kind === kind && item.target_id === id,
      ),
    deleteAssociation: () => unsupported('deleteAssociation'),
    insertMemoryEvent: () => unsupported('insertMemoryEvent'),
    listMemoryEvents: async () => unsupported('listMemoryEvents'),
    getMemoryEventsByEntity: async () => unsupported('getMemoryEventsByEntity'),
    getMemoryEventsBySession: async () => unsupported('getMemoryEventsBySession'),
    getSessionState: async (scope, sessionId) =>
      state.sessionStates.find(
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
      source_event_id: input.source_event_id ?? state.watermarkEventId ?? null,
    }),
    getTemporalWatermark: async (): Promise<TemporalProjectionWatermark | null> => ({
      projection_name: 'temporal',
      last_event_id: state.watermarkEventId ?? 0,
      updated_at: asOf,
      cutover_at: asOf,
      metadata: null,
    }),
    upsertTemporalWatermark: () => unsupported('upsertTemporalWatermark'),
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
}
