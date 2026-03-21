export { estimateTokens, createSessionId } from './core/tokens.js';
export { estimateTokens as estimateTokensLocal } from './core/tokens.js';
export { assessContext } from './core/monitor.js';
export { compactTurns, commitCompaction, promoteToKnowledge } from './core/orchestrator.js';

export { createSQLiteAdapter } from './adapters/sqlite/index.js';

export type { MemoryScope, NormalizedMemoryScope } from './contracts/identity.js';
export type { StorageAdapter } from './contracts/storage.js';
export type {
  TurnRole,
  CompactionTrigger,
  FactType,
  FactSource,
  FactConfidence,
  CompactionState,
  Turn,
  NewTurn,
  WorkingMemory,
  NewWorkingMemory,
  KnowledgeMemory,
  NewKnowledgeMemory,
  ContextMonitor,
  ContextMonitorUpsert,
  CompactionLog,
  NewCompactionLog,
} from './contracts/types.js';
export type {
  CompactionAction,
  DriftSignalType,
  CompletionSignalType,
  ToolOutputSignalType,
  TopicDriftSignal,
  TaskCompletionSignal,
  HeavyToolOutputSignal,
  ScoreBreakdown,
  CompactionRecommendation,
  MonitorInput,
  ContextHealthReport,
} from './core/monitor.js';
export type { CompactionResult, Summarizer, SummarizerOutput } from './core/orchestrator.js';
