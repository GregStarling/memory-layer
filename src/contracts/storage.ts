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

/**
 * Thrown by storage adapters when an insert violates a unique constraint.
 *
 * Callers that expect duplicate-key collisions (e.g. autoDetectAssociations
 * attempting to insert an already-present edge) should catch this exact
 * class rather than sniffing error codes or messages across adapters.
 */
export class UniqueConstraintError extends Error {
  readonly kind = 'UniqueConstraintError' as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UniqueConstraintError';
  }
}
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
  NewWorkItem,
  NewTurn,
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
} from './types.js';

export interface StorageAdapter {
  insertTurn(input: NewTurn): Turn;
  insertTurns(inputs: NewTurn[]): Turn[];
  getTurnById(id: number): Turn | null;
  getActiveTurns(scope: MemoryScope, sessionId?: string): Turn[];
  getActiveTurnsPaginated(scope: MemoryScope, options?: PaginationOptions): PaginatedResult<Turn>;
  getTurnsByTimeRange(scope: MemoryScope, range: TimeRange): Turn[];
  searchTurns(scope: MemoryScope, query: string, options?: SearchOptions): SearchResult<Turn>[];
  archiveTurn(id: number, archivedAt: number, compactionLogId: number): void;
  getArchivedTurnRange(
    sessionId: string,
    startId: number,
    endId: number,
    scope: MemoryScope,
  ): Turn[];

  insertWorkingMemory(input: NewWorkingMemory): WorkingMemory;
  getWorkingMemoryById(id: number): WorkingMemory | null;
  getWorkingMemoryBySession(sessionId: string, scope: MemoryScope): WorkingMemory[];
  getActiveWorkingMemory(scope: MemoryScope, sessionId?: string): WorkingMemory[];
  getLatestWorkingMemory(scope: MemoryScope, sessionId?: string): WorkingMemory | null;
  getWorkingMemoryByTimeRange(scope: MemoryScope, range: TimeRange): WorkingMemory[];
  expireWorkingMemory(id: number): void;
  markWorkingMemoryPromoted(id: number, knowledgeMemoryId: number): void;

  insertKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory;
  insertKnowledgeMemories(inputs: NewKnowledgeMemory[]): KnowledgeMemory[];
  insertKnowledgeCandidate(input: NewKnowledgeCandidate): KnowledgeCandidate;
  insertKnowledgeCandidates(inputs: NewKnowledgeCandidate[]): KnowledgeCandidate[];
  getKnowledgeCandidateById(id: number): KnowledgeCandidate | null;
  listKnowledgeCandidates(
    scope: MemoryScope,
    options?: { state?: Array<KnowledgeCandidate['state']> },
  ): KnowledgeCandidate[];
  insertKnowledgeEvidence(input: NewKnowledgeEvidence): KnowledgeEvidence;
  insertKnowledgeEvidenceBatch(inputs: NewKnowledgeEvidence[]): KnowledgeEvidence[];
  listKnowledgeEvidenceForKnowledge(knowledgeId: number): KnowledgeEvidence[];
  listKnowledgeEvidenceForCandidate(candidateId: number): KnowledgeEvidence[];
  promoteKnowledgeCandidate(candidateId: number, input: NewKnowledgeMemory): KnowledgeMemory;
  getKnowledgeMemoryById(id: number): KnowledgeMemory | null;
  getActiveKnowledgeMemory(scope: MemoryScope): KnowledgeMemory[];
  getActiveKnowledgeMemoryPaginated(
    scope: MemoryScope,
    options?: PaginationOptions,
  ): PaginatedResult<KnowledgeMemory>;
  getActiveKnowledgeCrossScope(scope: MemoryScope, level: ScopeLevel): KnowledgeMemory[];
  getKnowledgeSince(scope: MemoryScope, level: ScopeLevel, since: number): KnowledgeMemory[];
  getKnowledgeByTimeRange(scope: MemoryScope, range: TimeRange): KnowledgeMemory[];
  searchKnowledge(
    scope: MemoryScope,
    query: string,
    options?: SearchOptions,
  ): SearchResult<KnowledgeMemory>[];
  searchKnowledgeCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query: string,
    options?: SearchOptions,
  ): SearchResult<KnowledgeMemory>[];
  insertKnowledgeMemoryAudit(input: NewKnowledgeMemoryAudit): KnowledgeMemoryAudit;
  getRecentKnowledgeMemoryAudits(scope: MemoryScope, limit?: number): KnowledgeMemoryAudit[];
  getKnowledgeMemoryAuditsForKnowledge(
    scope: MemoryScope,
    knowledgeId: number,
    limit?: number,
  ): KnowledgeMemoryAudit[];
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
  ): KnowledgeMemory | null;
  touchKnowledgeMemory(id: number): void;
  touchKnowledgeMemories(ids: number[]): void;
  retireKnowledgeMemory(id: number, retiredAt?: number): void;
  supersedeKnowledgeMemory(oldId: number, newId: number): void;

  insertWorkItem(input: NewWorkItem): WorkItem;
  getWorkItemById(id: number): WorkItem | null;
  getActiveWorkItems(scope: MemoryScope): WorkItem[];
  getActiveWorkItemsCrossScope(scope: MemoryScope, level: ScopeLevel): WorkItem[];
  getWorkItemsByTimeRange(scope: MemoryScope, range: TimeRange): WorkItem[];
  getWorkItemsByTimeRangeCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    range: TimeRange,
  ): WorkItem[];
  updateWorkItemStatus(id: number, status: WorkItem['status']): void;
  updateWorkItem(
    id: number,
    patch: WorkItemPatch,
    options?: { expectedVersion?: number },
  ): WorkItem | null;
  deleteWorkItem(id: number): void;
  claimWorkItem(input: NewWorkClaimInput): WorkClaim;
  renewWorkClaim(claimId: number, actor: ActorRef, leaseSeconds?: number): WorkClaim | null;
  releaseWorkClaim(claimId: number, actor: ActorRef, reason?: string): WorkClaim | null;
  getActiveWorkClaim(workItemId: number): WorkClaim | null;
  listWorkClaims(scope: MemoryScope, options?: WorkClaimQuery): WorkClaim[];
  listWorkClaimsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    options?: WorkClaimQuery,
  ): WorkClaim[];
  createHandoff(input: NewHandoffInput): HandoffRecord;
  acceptHandoff(handoffId: number, actor: ActorRef, reason?: string): HandoffRecord | null;
  rejectHandoff(handoffId: number, actor: ActorRef, reason?: string): HandoffRecord | null;
  cancelHandoff(handoffId: number, actor: ActorRef, reason?: string): HandoffRecord | null;
  listHandoffs(scope: MemoryScope, options?: HandoffQuery): HandoffRecord[];
  listHandoffsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    options?: HandoffQuery,
  ): HandoffRecord[];

  upsertContextMonitor(input: ContextMonitorUpsert): ContextMonitor;
  getContextMonitor(scope: MemoryScope): ContextMonitor | null;

  insertCompactionLog(input: NewCompactionLog): CompactionLog;
  getCompactionLogById(id: number): CompactionLog | null;
  getRecentCompactionLogs(scope: MemoryScope, limit?: number): CompactionLog[];

  insertPlaybook(input: NewPlaybook): Playbook;
  getPlaybookById(id: number): Playbook | null;
  getActivePlaybooks(scope: MemoryScope): Playbook[];
  getActivePlaybooksCrossScope(scope: MemoryScope, level: ScopeLevel): Playbook[];
  searchPlaybooks(scope: MemoryScope, query: string, options?: SearchOptions): SearchResult<Playbook>[];
  searchPlaybooksCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query: string,
    options?: SearchOptions,
  ): SearchResult<Playbook>[];
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
      status?: Playbook['status'];
    },
  ): Playbook | null;
  recordPlaybookUse(id: number): void;
  insertPlaybookRevision(input: NewPlaybookRevision): PlaybookRevision;
  getPlaybookRevisions(playbookId: number): PlaybookRevision[];

  insertAssociation(input: NewAssociation): Association;
  getAssociationById(id: number): Association | null;
  getAssociationsFrom(kind: AssociationTargetKind, id: number, scope: MemoryScope): Association[];
  getAssociationsTo(kind: AssociationTargetKind, id: number, scope: MemoryScope): Association[];
  listAssociations(scope: MemoryScope): Association[];
  deleteAssociation(id: number): void;

  insertMemoryEvent(input: NewMemoryEventRecord): MemoryEventRecord;
  listMemoryEvents(scope: MemoryScope, query?: MemoryEventQuery): TimelineResult;
  listMemoryEventsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query?: MemoryEventQuery,
  ): TimelineResult;
  getMemoryEventsByEntity(
    scope: MemoryScope,
    entityKind: MemoryEventEntityKind,
    entityId: string,
    query?: Omit<MemoryEventQuery, 'entityKind' | 'entityId'>,
  ): TimelineResult;
  getMemoryEventsBySession(
    scope: MemoryScope,
    sessionId: string,
    query?: Omit<MemoryEventQuery, 'sessionId'>,
  ): TimelineResult;
  getSessionState(scope: MemoryScope, sessionId: string): SessionStateProjection | null;
  upsertSessionState(input: NewSessionStateProjection): SessionStateProjection;
  getTemporalWatermark(projectionName?: string): TemporalProjectionWatermark | null;
  upsertTemporalWatermark(input: NewTemporalProjectionWatermark): TemporalProjectionWatermark;

  transaction<T>(fn: () => T): T;
  close(): void;
}
