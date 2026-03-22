import type { MemoryScope, ScopeLevel } from './identity.js';
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
} from './types.js';

export interface StorageAdapter {
  insertTurn(input: NewTurn): Turn;
  getTurnById(id: number): Turn | null;
  getActiveTurns(scope: MemoryScope): Turn[];
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
  getKnowledgeMemoryById(id: number): KnowledgeMemory | null;
  getActiveKnowledgeMemory(scope: MemoryScope): KnowledgeMemory[];
  getActiveKnowledgeCrossScope(scope: MemoryScope, level: ScopeLevel): KnowledgeMemory[];
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
