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

export interface StorageAdapter {
  insertTurn(input: NewTurn): Turn;
  insertTurns(inputs: NewTurn[]): Turn[];
  getTurnById(id: number): Turn | null;
  getActiveTurns(scope: MemoryScope): Turn[];
  getActiveTurnsPaginated(scope: MemoryScope, options?: PaginationOptions): PaginatedResult<Turn>;
  getTurnsByTimeRange(scope: MemoryScope, range: TimeRange): Turn[];
  searchTurns(scope: MemoryScope, query: string, options?: SearchOptions): SearchResult<Turn>[];
  archiveTurn(id: number, archivedAt: number, compactionLogId: number): void;
  getArchivedTurnRange(
    sessionId: string,
    startId: number,
    endId: number,
    scope?: MemoryScope,
  ): Turn[];

  insertWorkingMemory(input: NewWorkingMemory): WorkingMemory;
  getWorkingMemoryById(id: number): WorkingMemory | null;
  getWorkingMemoryBySession(sessionId: string, scope?: MemoryScope): WorkingMemory[];
  getActiveWorkingMemory(scope: MemoryScope): WorkingMemory[];
  getLatestWorkingMemory(scope: MemoryScope): WorkingMemory | null;
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
  retireKnowledgeMemory(id: number, retiredAt?: number): void;
  supersedeKnowledgeMemory(oldId: number, newId: number): void;

  insertWorkItem(input: NewWorkItem): WorkItem;
  getActiveWorkItems(scope: MemoryScope): WorkItem[];
  getWorkItemsByTimeRange(scope: MemoryScope, range: TimeRange): WorkItem[];
  updateWorkItemStatus(id: number, status: WorkItem['status']): void;
  deleteWorkItem(id: number): void;

  upsertContextMonitor(input: ContextMonitorUpsert): ContextMonitor;
  getContextMonitor(scope: MemoryScope): ContextMonitor | null;

  insertCompactionLog(input: NewCompactionLog): CompactionLog;
  getCompactionLogById(id: number): CompactionLog | null;
  getRecentCompactionLogs(scope: MemoryScope, limit?: number): CompactionLog[];

  transaction<T>(fn: () => T): T;
  close(): void;
}
