export { estimateTokens, createSessionId } from './core/tokens.js';
export { estimateTokens as estimateTokensLocal } from './core/tokens.js';
export { assessContext } from './core/monitor.js';
export { buildMemoryContext } from './core/context.js';
export {
  compactTurns,
  commitCompaction,
  promoteToKnowledge,
  extractKnowledge,
} from './core/orchestrator.js';
export { createMemoryManager } from './core/manager.js';
export { createRegexExtractor } from './core/extractor.js';

export { createSQLiteAdapter, createSQLiteAdapterWithEmbeddings } from './adapters/sqlite/index.js';
export { createClaudeSummarizer } from './summarizers/claude.js';
export { createOpenAISummarizer } from './summarizers/openai.js';
export { createClaudeExtractor, createOpenAIExtractor } from './summarizers/extractor.js';
export {
  SUMMARIZATION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  formatTurnsForSummarization,
  parseSummarizerResponse,
  parseExtractionResponse,
} from './summarizers/prompts.js';

export type { MemoryScope, NormalizedMemoryScope } from './contracts/identity.js';
export type { StorageAdapter } from './contracts/storage.js';
export type { Logger, MemoryEvent, EventHook } from './contracts/observability.js';
export { noopLogger } from './contracts/observability.js';
export type { MonitorPolicy, ExtractionPolicy, ContextPolicy } from './contracts/policy.js';
export {
  DEFAULT_MONITOR_POLICY,
  DEFAULT_EXTRACTION_POLICY,
  DEFAULT_CONTEXT_POLICY,
} from './contracts/policy.js';
export type {
  EmbeddingVector,
  EmbeddingGenerator,
  EmbeddingAdapter,
  SimilarEmbeddingResult,
} from './contracts/embedding.js';
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
  SearchOptions,
  SearchResult,
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
export type { MemoryContext, ContextAssemblyOptions } from './core/context.js';
export type {
  CompactionResult,
  Summarizer,
  SummarizerOutput,
} from './core/orchestrator.js';
export type { ExtractedFact, Extractor } from './core/extractor.js';
export type {
  MemoryManager,
  MemoryManagerConfig,
} from './core/manager.js';
