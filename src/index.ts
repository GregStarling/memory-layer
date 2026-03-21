// ---------------------------------------------------------------------------
// @nanoclaw/memory - Public API (v1)
// ---------------------------------------------------------------------------
// Call initMemoryDatabase(dbPath) once at application startup.
// Call _initTestMemoryDatabase() for in-memory test instances.
// ---------------------------------------------------------------------------

export {
  initMemoryDatabase,
  _initTestMemoryDatabase,
  closeMemoryDatabase,
  getMemoryDbPath,
  estimateTokens,
  createSessionId,
  insertTurn,
  getTurnById,
  getActiveTurns,
  archiveTurn,
  getArchivedTurnRange,
  insertWorkingMemory,
  getWorkingMemoryById,
  getWorkingMemoryBySession,
  getActiveWorkingMemory,
  getLatestWorkingMemory,
  expireWorkingMemory,
  markWorkingMemoryPromoted,
  insertKnowledgeMemory,
  getKnowledgeMemoryById,
  getActiveKnowledgeMemory,
  touchKnowledgeMemory,
  supersedeKnowledgeMemory,
  upsertContextMonitor,
  getContextMonitor,
  insertCompactionLog,
  getCompactionLogById,
  getRecentCompactionLogs,
} from './db.js';

export { assessContext, estimateTokensLocal } from './monitor.js';

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
} from './types.js';

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
} from './monitor.js';
