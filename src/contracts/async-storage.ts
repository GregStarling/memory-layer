import type { MemoryScope, ScopeLevel } from './identity.js';
import type {
  ActorRef,
  HandoffQuery,
  HandoffRecord,
  NewHandoffInput,
  NewWorkClaimInput,
  WorkClaim,
  WorkClaimQuery,
  WorkItemPatch,
} from './coordination.js';
import type {
  MemoryEventEntityKind,
  MemoryEventQuery,
  MemoryEventRecord,
  NewMemoryEventRecord,
  NewSessionStateProjection,
  NewTemporalProjectionWatermark,
  SessionStateProjection,
  TemporalProjectionWatermark,
  TimelineResult,
} from './temporal.js';
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
  NewSourceDocument,
  NewWorkItem,
  NewTurn,
  NewWorkingMemory,
  PaginationOptions,
  PaginatedResult,
  Playbook,
  PlaybookRevision,
  SearchOptions,
  SearchResult,
  SourceDocument,
  SourceDocumentStatus,
  TimeRange,
  Turn,
  WorkItem,
  WorkingMemory,
} from './types.js';
import type {
  ContextContract,
  ContextInvariant,
  ContextEscalationPolicy,
  PersistedGovernanceState,
} from './context-contract.js';

/**
 * Async-first storage adapter interface for remote backends (PostgreSQL, Redis, etc.).
 * Every method returns a Promise, enabling non-blocking I/O.
 *
 * For synchronous adapters (SQLite, in-memory), use `wrapSyncAdapter()` from
 * `memory-layer/adapters/sync-to-async` to convert a `StorageAdapter` into
 * an `AsyncStorageAdapter`.
 */
export interface AsyncStorageAdapter {
  insertTurn(input: NewTurn): Promise<Turn>;
  insertTurns(inputs: NewTurn[]): Promise<Turn[]>;
  getTurnById(id: number): Promise<Turn | null>;
  getActiveTurns(scope: MemoryScope, sessionId?: string): Promise<Turn[]>;
  getActiveTurnsPaginated(
    scope: MemoryScope,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<Turn>>;
  getTurnsByTimeRange(scope: MemoryScope, range: TimeRange): Promise<Turn[]>;
  searchTurns(
    scope: MemoryScope,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult<Turn>[]>;
  archiveTurn(id: number, archivedAt: number, compactionLogId: number): Promise<void>;
  getArchivedTurnRange(
    sessionId: string,
    startId: number,
    endId: number,
    scope: MemoryScope,
  ): Promise<Turn[]>;

  insertWorkingMemory(input: NewWorkingMemory): Promise<WorkingMemory>;
  getWorkingMemoryById(id: number): Promise<WorkingMemory | null>;
  getExistingWorkingMemoryIds?(ids: number[]): Promise<number[]>;
  getWorkingMemoryBySession(sessionId: string, scope: MemoryScope): Promise<WorkingMemory[]>;
  getActiveWorkingMemory(scope: MemoryScope, sessionId?: string): Promise<WorkingMemory[]>;
  getLatestWorkingMemory(scope: MemoryScope, sessionId?: string): Promise<WorkingMemory | null>;
  getWorkingMemoryByTimeRange(scope: MemoryScope, range: TimeRange): Promise<WorkingMemory[]>;
  expireWorkingMemory(id: number): Promise<void>;
  markWorkingMemoryPromoted(id: number, knowledgeMemoryId: number): Promise<void>;

  insertKnowledgeMemory(input: NewKnowledgeMemory): Promise<KnowledgeMemory>;
  insertKnowledgeMemories(inputs: NewKnowledgeMemory[]): Promise<KnowledgeMemory[]>;
  insertKnowledgeCandidate(input: NewKnowledgeCandidate): Promise<KnowledgeCandidate>;
  insertKnowledgeCandidates(inputs: NewKnowledgeCandidate[]): Promise<KnowledgeCandidate[]>;
  getKnowledgeCandidateById(id: number): Promise<KnowledgeCandidate | null>;
  listKnowledgeCandidates(
    scope: MemoryScope,
    options?: { state?: Array<KnowledgeCandidate['state']> },
  ): Promise<KnowledgeCandidate[]>;
  insertKnowledgeEvidence(input: NewKnowledgeEvidence): Promise<KnowledgeEvidence>;
  insertKnowledgeEvidenceBatch(inputs: NewKnowledgeEvidence[]): Promise<KnowledgeEvidence[]>;
  listKnowledgeEvidenceForKnowledge(knowledgeId: number): Promise<KnowledgeEvidence[]>;
  listKnowledgeEvidenceForCandidate(candidateId: number): Promise<KnowledgeEvidence[]>;
  promoteKnowledgeCandidate(candidateId: number, input: NewKnowledgeMemory): Promise<KnowledgeMemory>;
  deleteExpiredKnowledgeCandidates(scope: MemoryScope, olderThan: number): Promise<number[]>;
  getKnowledgeMemoryById(id: number): Promise<KnowledgeMemory | null>;
  getExistingKnowledgeMemoryIds?(ids: number[]): Promise<number[]>;
  getActiveKnowledgeMemory(scope: MemoryScope): Promise<KnowledgeMemory[]>;
  getActiveKnowledgeMemoryPaginated(
    scope: MemoryScope,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<KnowledgeMemory>>;
  getActiveKnowledgeCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
  ): Promise<KnowledgeMemory[]>;
  getKnowledgeSince(scope: MemoryScope, level: ScopeLevel, since: number): Promise<KnowledgeMemory[]>;
  getKnowledgeByTimeRange(scope: MemoryScope, range: TimeRange): Promise<KnowledgeMemory[]>;
  searchKnowledge(
    scope: MemoryScope,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult<KnowledgeMemory>[]>;
  searchKnowledgeCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult<KnowledgeMemory>[]>;
  insertKnowledgeMemoryAudit(input: NewKnowledgeMemoryAudit): Promise<KnowledgeMemoryAudit>;
  getRecentKnowledgeMemoryAudits(
    scope: MemoryScope,
    limit?: number,
  ): Promise<KnowledgeMemoryAudit[]>;
  getKnowledgeMemoryAuditsForKnowledge(
    scope: MemoryScope,
    knowledgeId: number,
    limit?: number,
  ): Promise<KnowledgeMemoryAudit[]>;
  updateKnowledgeMemory(
    id: number,
    patch: {
      knowledge_state?: KnowledgeMemory['knowledge_state'];
      knowledge_class?: KnowledgeMemory['knowledge_class'];
      trust_score?: number;
      verification_status?: KnowledgeMemory['verification_status'];
      verification_notes?: string | null;
      last_verified_at?: number | null;
      next_reverification_at?: number | null;
      last_confirmed_at?: number | null;
      confirmation_count?: number;
      disputed_at?: number | null;
      dispute_reason?: string | null;
      contradiction_score?: number;
      superseded_at?: number | null;
      successful_use_count?: number;
      failed_use_count?: number;
    },
  ): Promise<KnowledgeMemory | null>;
  touchKnowledgeMemory(id: number): Promise<void>;
  touchKnowledgeMemories(ids: number[]): Promise<void>;
  retireKnowledgeMemory(id: number, retiredAt?: number): Promise<void>;
  supersedeKnowledgeMemory(oldId: number, newId: number): Promise<void>;

  insertWorkItem(input: NewWorkItem): Promise<WorkItem>;
  getWorkItemById(id: number): Promise<WorkItem | null>;
  getExistingWorkItemIds?(ids: number[]): Promise<number[]>;
  getActiveWorkItems(scope: MemoryScope): Promise<WorkItem[]>;
  getActiveWorkItemsCrossScope(scope: MemoryScope, level: ScopeLevel): Promise<WorkItem[]>;
  getWorkItemsByTimeRange(scope: MemoryScope, range: TimeRange): Promise<WorkItem[]>;
  getWorkItemsByTimeRangeCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    range: TimeRange,
  ): Promise<WorkItem[]>;
  updateWorkItemStatus(id: number, status: WorkItem['status']): Promise<void>;
  updateWorkItem(
    id: number,
    patch: WorkItemPatch,
    options?: { expectedVersion?: number },
  ): Promise<WorkItem | null>;
  deleteWorkItem(id: number): Promise<void>;
  claimWorkItem(input: NewWorkClaimInput): Promise<WorkClaim>;
  renewWorkClaim(claimId: number, actor: ActorRef, leaseSeconds?: number): Promise<WorkClaim | null>;
  releaseWorkClaim(claimId: number, actor: ActorRef, reason?: string): Promise<WorkClaim | null>;
  getWorkClaimById(claimId: number): Promise<WorkClaim | null>;
  getActiveWorkClaim(workItemId: number): Promise<WorkClaim | null>;
  listWorkClaims(scope: MemoryScope, options?: WorkClaimQuery): Promise<WorkClaim[]>;
  listWorkClaimsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    options?: WorkClaimQuery,
  ): Promise<WorkClaim[]>;
  createHandoff(input: NewHandoffInput): Promise<HandoffRecord>;
  getHandoffById(handoffId: number): Promise<HandoffRecord | null>;
  acceptHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  rejectHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  cancelHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  listHandoffs(scope: MemoryScope, options?: HandoffQuery): Promise<HandoffRecord[]>;
  listHandoffsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    options?: HandoffQuery,
  ): Promise<HandoffRecord[]>;

  upsertContextMonitor(input: ContextMonitorUpsert): Promise<ContextMonitor>;
  getContextMonitor(scope: MemoryScope): Promise<ContextMonitor | null>;

  insertCompactionLog(input: NewCompactionLog): Promise<CompactionLog>;
  getCompactionLogById(id: number): Promise<CompactionLog | null>;
  getRecentCompactionLogs(scope: MemoryScope, limit?: number): Promise<CompactionLog[]>;

  insertPlaybook(input: NewPlaybook): Promise<Playbook>;
  getPlaybookById(id: number): Promise<Playbook | null>;
  getExistingPlaybookIds?(ids: number[]): Promise<number[]>;
  getActivePlaybooks(scope: MemoryScope): Promise<Playbook[]>;
  getActivePlaybooksCrossScope(scope: MemoryScope, level: ScopeLevel): Promise<Playbook[]>;
  searchPlaybooks(
    scope: MemoryScope,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult<Playbook>[]>;
  searchPlaybooksCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult<Playbook>[]>;
  updatePlaybook(
    id: number,
    patch: {
      title?: string;
      description?: string;
      instructions?: string;
      references?: string[];
      templates?: string[];
      scripts?: string[];
      assets?: string[];
      tags?: string[];
      rationale?: string | null;
      status?: Playbook['status'];
    },
  ): Promise<Playbook | null>;
  recordPlaybookUse(id: number): Promise<void>;
  insertPlaybookRevision(input: NewPlaybookRevision): Promise<PlaybookRevision>;
  getPlaybookRevisions(playbookId: number): Promise<PlaybookRevision[]>;

  insertAssociation(input: NewAssociation): Promise<Association>;
  getAssociationById(id: number): Promise<Association | null>;
  getAssociationsFrom(kind: AssociationTargetKind, id: number, scope: MemoryScope): Promise<Association[]>;
  getAssociationsTo(kind: AssociationTargetKind, id: number, scope: MemoryScope): Promise<Association[]>;
  listAssociations(scope: MemoryScope): Promise<Association[]>;
  deleteAssociation(id: number): Promise<void>;

  insertMemoryEvent(input: NewMemoryEventRecord): Promise<MemoryEventRecord>;
  listMemoryEvents(scope: MemoryScope, query?: MemoryEventQuery): Promise<TimelineResult>;
  listMemoryEventsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query?: MemoryEventQuery,
  ): Promise<TimelineResult>;
  getMemoryEventsByEntity(
    scope: MemoryScope,
    entityKind: MemoryEventEntityKind,
    entityId: string,
    query?: Omit<MemoryEventQuery, 'entityKind' | 'entityId'>,
  ): Promise<TimelineResult>;
  getMemoryEventsBySession(
    scope: MemoryScope,
    sessionId: string,
    query?: Omit<MemoryEventQuery, 'sessionId'>,
  ): Promise<TimelineResult>;
  getSessionState(scope: MemoryScope, sessionId: string): Promise<SessionStateProjection | null>;
  upsertSessionState(input: NewSessionStateProjection): Promise<SessionStateProjection>;
  getTemporalWatermark(projectionName?: string): Promise<TemporalProjectionWatermark | null>;
  upsertTemporalWatermark(
    input: NewTemporalProjectionWatermark,
  ): Promise<TemporalProjectionWatermark>;

  insertSourceDocument(input: NewSourceDocument): Promise<SourceDocument>;
  getSourceDocumentById(id: number): Promise<SourceDocument | null>;
  getSourceDocumentByHash(contentHash: string, scope: MemoryScope): Promise<SourceDocument | null>;
  listSourceDocuments(scope: MemoryScope, options?: PaginationOptions): Promise<PaginatedResult<SourceDocument>>;
  updateSourceDocument(id: number, patch: { status?: SourceDocumentStatus; fact_count?: number; processed_at?: number | null }): Promise<SourceDocument | null>;
  getScopeConfig(scope: MemoryScope, key: string): Promise<string | null>;
  setScopeConfig(scope: MemoryScope, key: string, value: string): Promise<void>;

  // Context governance persistence (optional)
  getGovernanceState?(scope: MemoryScope): Promise<PersistedGovernanceState | null>;
  upsertDefaultContextContract?(scope: MemoryScope, contract: ContextContract | null): Promise<void>;
  upsertNamedContextContract?(scope: MemoryScope, name: string, contract: ContextContract): Promise<void>;
  deleteNamedContextContract?(scope: MemoryScope, name: string): Promise<boolean>;
  upsertContextInvariant?(scope: MemoryScope, invariant: ContextInvariant): Promise<void>;
  deleteContextInvariant?(scope: MemoryScope, invariantId: string): Promise<boolean>;
  upsertContextEscalationPolicy?(scope: MemoryScope, policy: ContextEscalationPolicy): Promise<void>;

  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
