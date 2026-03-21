import type { MemoryScope } from './identity.js';
import type {
  CompactionLog,
  ContextMonitor,
  ContextMonitorUpsert,
  KnowledgeMemory,
  NewCompactionLog,
  NewKnowledgeMemory,
  NewTurn,
  NewWorkingMemory,
  Turn,
  WorkingMemory,
} from './types.js';

export interface StorageAdapter {
  insertTurn(input: NewTurn): Turn;
  getTurnById(id: number): Turn | null;
  getActiveTurns(scope: MemoryScope): Turn[];
  archiveTurn(id: number, archivedAt: number, compactionLogId: number): void;
  getArchivedTurnRange(sessionId: string, startId: number, endId: number): Turn[];

  insertWorkingMemory(input: NewWorkingMemory): WorkingMemory;
  getWorkingMemoryById(id: number): WorkingMemory | null;
  getWorkingMemoryBySession(sessionId: string): WorkingMemory[];
  getActiveWorkingMemory(scope: MemoryScope): WorkingMemory[];
  getLatestWorkingMemory(scope: MemoryScope): WorkingMemory | null;
  expireWorkingMemory(id: number): void;
  markWorkingMemoryPromoted(id: number, knowledgeMemoryId: number): void;

  insertKnowledgeMemory(input: NewKnowledgeMemory): KnowledgeMemory;
  getKnowledgeMemoryById(id: number): KnowledgeMemory | null;
  getActiveKnowledgeMemory(scope: MemoryScope): KnowledgeMemory[];
  touchKnowledgeMemory(id: number): void;
  supersedeKnowledgeMemory(oldId: number, newId: number): void;

  upsertContextMonitor(input: ContextMonitorUpsert): ContextMonitor;
  getContextMonitor(scope: MemoryScope): ContextMonitor | null;

  insertCompactionLog(input: NewCompactionLog): CompactionLog;
  getCompactionLogById(id: number): CompactionLog | null;
  getRecentCompactionLogs(scope: MemoryScope, limit?: number): CompactionLog[];

  transaction<T>(fn: () => T): T;
  close(): void;
}
