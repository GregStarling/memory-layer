import type { MemoryScope, ScopeLevel } from './identity.js';
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
} from './types.js';

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
  getActiveTurns(scope: MemoryScope): Promise<Turn[]>;
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
    scope?: MemoryScope,
  ): Promise<Turn[]>;

  insertWorkingMemory(input: NewWorkingMemory): Promise<WorkingMemory>;
  getWorkingMemoryById(id: number): Promise<WorkingMemory | null>;
  getWorkingMemoryBySession(sessionId: string, scope?: MemoryScope): Promise<WorkingMemory[]>;
  getActiveWorkingMemory(scope: MemoryScope): Promise<WorkingMemory[]>;
  getLatestWorkingMemory(scope: MemoryScope): Promise<WorkingMemory | null>;
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
  getKnowledgeMemoryById(id: number): Promise<KnowledgeMemory | null>;
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
  retireKnowledgeMemory(id: number, retiredAt?: number): Promise<void>;
  supersedeKnowledgeMemory(oldId: number, newId: number): Promise<void>;

  insertWorkItem(input: NewWorkItem): Promise<WorkItem>;
  getActiveWorkItems(scope: MemoryScope): Promise<WorkItem[]>;
  getWorkItemsByTimeRange(scope: MemoryScope, range: TimeRange): Promise<WorkItem[]>;
  updateWorkItemStatus(id: number, status: WorkItem['status']): Promise<void>;
  deleteWorkItem(id: number): Promise<void>;

  upsertContextMonitor(input: ContextMonitorUpsert): Promise<ContextMonitor>;
  getContextMonitor(scope: MemoryScope): Promise<ContextMonitor | null>;

  insertCompactionLog(input: NewCompactionLog): Promise<CompactionLog>;
  getCompactionLogById(id: number): Promise<CompactionLog | null>;
  getRecentCompactionLogs(scope: MemoryScope, limit?: number): Promise<CompactionLog[]>;

  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
