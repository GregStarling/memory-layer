export {
  estimateTokens,
  estimateTokens as estimateTokensLocal,
  createModelTokenEstimator,
  createTiktokenEstimator,
  createSessionId,
} from './core/tokens.js';
export { assessContext } from './core/monitor.js';
export { buildMemoryContext } from './core/context.js';
export { createMemoryEventEmitter } from './core/events.js';
export { runMaintenance } from './core/maintenance.js';
export { createMemory } from './core/quick.js';
export { createMemoryWithAsyncAdapter } from './core/quick.js';
export { createMemoryRuntime } from './core/runtime.js';
export { createMemorySync } from './core/sync.js';
export { createCircuitBreaker } from './core/circuit-breaker.js';
export {
  formatBootstrapForPrompt,
  formatContextAsMessages,
  formatContextForPrompt,
} from './core/formatter.js';
export {
  compactTurns,
  commitCompaction,
  promoteToKnowledge,
  extractKnowledge,
} from './core/orchestrator.js';
export { createMemoryManager } from './core/manager.js';
export {
  createClaudeMemoryManager,
  createOpenAIMemoryManager,
} from './core/provider-managers.js';
export { createRegexExtractor, extractTemporalWindow, extractRationale } from './core/extractor.js';
export { discover } from './core/discover.js';
export { getGraphReport } from './core/graph-report.js';
export { getFactsAt } from './core/temporal.js';
export { lintKnowledge } from './core/knowledge-lint.js';
export { computeClusters, formatClustersAsSection, expandFromClusters } from './core/cluster.js';
export { resolveAliases, discoverAliasCandidates } from './core/aliases.js';
export { getCoreMemory } from './core/core-memory.js';
export { reflectOnKnowledge } from './core/reflection.js';
export { exportBundle, importBundle } from './core/bundles.js';
export { refreshDocuments } from './core/corpus-refresh.js';
export { validateExtractedFacts, checkOntologyViolations } from './core/ontology.js';
export { derive, registerDerivationHandler, unregisterDerivationHandler } from './core/derived.js';
export { getCurationSummary, type CurationInput } from './core/curation.js';
export { MEMORY_MANAGER_PRESETS, resolveMemoryManagerPreset } from './core/presets.js';

export { createSQLiteAdapter, createSQLiteAdapterWithEmbeddings } from './adapters/sqlite/index.js';
export { createInMemoryAdapter, createInMemoryAdapterWithEmbeddings } from './adapters/memory/index.js';
export { createClaudeMemoryTools } from './integrations/claude-tools.js';
export { prepareClaudeAgentInput, wrapClaudeAgentModel } from './integrations/claude-agent.js';
export { createLangChainMemoryBridge } from './integrations/langchain.js';
export { createMemoryMcpAdapter } from './integrations/mcp.js';
export { wrapWithMemory } from './integrations/middleware.js';
export { createOpenAIMemoryTools } from './integrations/openai-tools.js';
export { prepareVercelAIInput, wrapVercelAIModel } from './integrations/vercel-ai.js';
export { startHttpServer, createMcpServerHandler, startMcpServer } from './server/index.js';
export { createClaudeSummarizer } from './summarizers/claude.js';
export { createExtractiveSummarizer } from './summarizers/extractive.js';
export { createOpenAISummarizer } from './summarizers/openai.js';
export { createClaudeExtractor, createOpenAIExtractor } from './summarizers/extractor.js';
export { createClientExtractor, createClientSummarizer } from './summarizers/client.js';
export { createLocalEmbeddingGenerator } from './embeddings/local.js';
export {
  withRetry,
  batchedGenerate,
  createCachedEmbeddingGenerator,
} from './embeddings/resilience.js';
export {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_PROMPT_VERSION,
  formatTurnsForSummarization,
  parseSummarizerResponse,
  parseExtractionResponse,
} from './summarizers/prompts.js';

export { wrapSyncAdapter } from './adapters/sync-to-async.js';
export { createStreamCollector, processStreamingTurn } from './core/streaming.js';

export { widenScope } from './contracts/identity.js';
export type { MemoryScope, NormalizedMemoryScope, ScopeLevel, ScopeQuery } from './contracts/identity.js';
export type {
  ContextInvariantSeverity,
  ContextWarningSeverity,
  ContextWarningCode,
  ContextEscalationChange,
  ContextEscalationRuleDecision,
  ContextEscalationDecision,
  ContextRequestReason,
  ContextInvariant,
  ContextContract,
  ContextContractReference,
  ContextEscalationPolicy,
  AppliedContextContract,
  ContextWarning,
  DegradedContext,
  ContextRequest,
  ContextRequestResolution,
  ContextGovernanceSnapshot,
} from './contracts/context-contract.js';
export {
  CONTEXT_INVARIANT_SEVERITIES,
  CONTEXT_WARNING_SEVERITIES,
  CONTEXT_WARNING_CODES,
  CONTEXT_ESCALATION_CHANGE_KINDS,
  CONTEXT_ESCALATION_RULE_DECISIONS,
  CONTEXT_ESCALATION_DECISIONS,
  CONTEXT_REQUEST_REASONS,
} from './contracts/context-contract.js';
export type { StorageAdapter } from './contracts/storage.js';
export type { AsyncStorageAdapter } from './contracts/async-storage.js';
export type { SessionState } from './contracts/session-state.js';
export type {
  ActorKind,
  ActorRef,
  MemoryVisibilityClass,
  ContextViewPolicy,
  WorkClaimStatus,
  HandoffStatus,
  WorkClaim,
  NewWorkClaimInput,
  WorkClaimQuery,
  HandoffRecord,
  NewHandoffInput,
  HandoffQuery,
  WorkItemPatch,
  CoordinationState,
} from './contracts/coordination.js';
export {
  ACTOR_KINDS,
  MEMORY_VISIBILITY_CLASSES,
  CONTEXT_VIEW_POLICIES,
  WORK_CLAIM_STATUSES,
  HANDOFF_STATUSES,
} from './contracts/coordination.js';
export type {
  MemoryEventEntityKind,
  MemoryEventType as TemporalMemoryEventType,
  MemoryEventRecord,
  NewMemoryEventRecord,
  MemoryEventQuery,
  ChangeStreamEvent,
  SessionStateProjection,
  NewSessionStateProjection,
  TemporalProjectionWatermark,
  NewTemporalProjectionWatermark,
  TemporalStateSnapshot,
  TemporalStateDiff,
  TimelineResult,
} from './contracts/temporal.js';
export type {
  MemoryErrorCode,
  MemoryErrorOptions,
} from './contracts/errors.js';
export {
  MemoryDomainError,
  ValidationError,
  ResourceNotFoundError,
  ScopeMismatchError,
  ConflictError,
  ProviderUnavailableError,
  isMemoryDomainError,
} from './contracts/errors.js';
export type { Logger, MemoryEvent, MemoryEventType, EventHook } from './contracts/observability.js';
export { noopLogger } from './contracts/observability.js';
export type {
  MonitorPolicy,
  MonitorPatterns,
  ExtractionPolicy,
  ContextPolicy,
  ContextMode,
  MaintenancePolicy,
} from './contracts/policy.js';
export {
  DEFAULT_MONITOR_POLICY,
  DEFAULT_EXTRACTION_POLICY,
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_MAINTENANCE_POLICY,
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
  KnowledgeState,
  KnowledgeClass,
  EvidenceSourceType,
  SupportPolarity,
  GroundingStrength,
  KnowledgeDecision,
  VerificationStatus,
  CompactionState,
  Turn,
  NewTurn,
  WorkingMemory,
  NewWorkingMemory,
  KnowledgeCandidate,
  NewKnowledgeCandidate,
  KnowledgeEvidence,
  NewKnowledgeEvidence,
  KnowledgeTrustAssessment,
  KnowledgeConflict,
  KnowledgeMemory,
  NewKnowledgeMemory,
  ContextMonitor,
  ContextMonitorUpsert,
  CompactionLog,
  NewCompactionLog,
  SearchOptions,
  SearchResult,
  PaginationOptions,
  PaginatedResult,
  TimeRange,
  WorkItem,
  NewWorkItem,
  EpisodeDetailLevel,
  EpisodeRecap,
  EpisodeSourceReference,
  EpisodeSearchOptions,
  EpisodeSummary,
  ReflectOptions,
  ReflectResult,
  PlaybookStatus,
  Playbook,
  NewPlaybook,
  PlaybookRevision,
  NewPlaybookRevision,
  AssociationType,
  AssociationTargetKind,
  Association,
  NewAssociation,
} from './contracts/types.js';
export { EPISODE_DETAIL_LEVELS, ASSOCIATION_TYPES, ASSOCIATION_TARGET_KINDS } from './contracts/types.js';
export type { AssociationProvenance } from './contracts/types.js';
export type {
  DiscoverOptions,
  BridgeType,
  SurpriseResult,
  GraphStats,
  DiscoveryReport,
} from './contracts/discovery.js';
export { DISCOVER_DEFAULTS } from './contracts/discovery.js';
export type {
  GraphReportSection,
  GraphReportOptions,
  GraphReport,
} from './contracts/graph-report.js';
export { GRAPH_REPORT_DEFAULTS } from './contracts/graph-report.js';
export type {
  TemporalQueryOptions,
  FactsAtResult,
} from './contracts/temporal-query.js';
export type {
  ReflectOnKnowledgeOptions,
  ReflectionFact,
  ReflectionPattern,
  KnowledgeReflectionResult,
} from './contracts/reflection.js';
export type {
  DerivedOutputType,
  DerivedOutput,
  DeriveOptions,
} from './contracts/derived.js';
export type {
  CurationActionType,
  CurationSource,
  CurationAction,
  CurationSummary,
  CurationOptions,
} from './contracts/curation.js';
export type {
  OverflowStrategy,
  RefreshPolicy,
  CoreMemoryBundle,
  CoreMemoryOptions,
} from './contracts/core-memory.js';
export type {
  AliasMap,
  AliasConfig,
  AliasCandidate,
} from './contracts/aliases.js';
export type {
  EntityTypeDefinition,
  RelationshipConstraint,
  ValidationRule,
  OntologyConfig,
} from './contracts/ontology.js';
export type {
  MemoryBundle,
  BundleExportOptions,
  BundleConflictResolution,
  BundleImportOptions,
} from './contracts/bundles.js';
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
export type {
  MemoryContext,
  ContextAssemblyOptions,
  KnowledgeSelectionReason,
  ContextDebugTrace,
  AssociationExpansionTrace,
  TokenTrimTrace,
  ExcludedKnowledgeReason,
  ContextScopeTrace,
} from './core/context.js';
export type { FormatOptions, SessionBootstrap } from './core/formatter.js';
export type { MemoryEventEmitter } from './core/events.js';
export type {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitState,
  CircuitBreakerSnapshot,
} from './core/circuit-breaker.js';
export type { MaintenanceReport } from './core/maintenance.js';
export type {
  MemoryRuntime,
  MemoryRuntimeOptions,
  BeforeModelCallInput,
  BeforeModelCallResult,
  AfterModelCallInput,
  RuntimeWorkItemSuggestion,
  SessionSnapshot,
  SnapshotRuntimeOptions,
} from './core/runtime.js';
export type {
  CompactionResult,
  KnowledgeVerifier,
  Summarizer,
  SummarizerOutput,
} from './core/orchestrator.js';
export type { ExtractedFact, Extractor, DomainGroups } from './core/extractor.js';
export type { TokenEstimator } from './core/tokens.js';
export type {
  KnowledgeChangeRecord,
  KnowledgeChangeResult,
  MemoryManager,
  MemoryManagerConfig,
  ContextQueryOptions,
  ContextExpansionOptions,
} from './core/manager.js';
export type { CreateMemoryOptions, CreateMemoryAsyncOptions } from './core/quick.js';
export type { MemoryQualityMode, MemoryQualityTier } from './core/quick.js';
export type {
  ClaudeMemoryManagerOptions,
  OpenAIMemoryManagerOptions,
} from './core/provider-managers.js';
export type {
  StructuredGenerationClient,
  StructuredGenerationRequest,
} from './summarizers/client.js';
export type { MemoryManagerPreset, MemoryManagerPresetConfig } from './core/presets.js';
export type { ClaudeToolDefinition } from './integrations/claude-tools.js';
export type { LangChainChatMessage, LangChainMemoryVariables } from './integrations/langchain.js';
export type {
  MessageHandler,
  MessageLike,
  MemoryMiddlewareOptions,
} from './integrations/middleware.js';
export type { McpToolDefinition } from './integrations/mcp.js';
export type { OpenAIFunctionTool } from './integrations/openai-tools.js';
export type { VercelAIPreparedInput, VercelAIWrapOptions } from './integrations/vercel-ai.js';
export type { StreamCollector } from './core/streaming.js';
export type { McpServerConfig } from './server/mcp-server.js';
export type { HttpServerConfig } from './server/http-server.js';
export type {
  CognitiveMemoryType,
  CognitiveMemoryItem,
  CognitiveSearchOptions,
  CognitiveSearchHit,
  CognitiveSearchResult,
} from './contracts/cognitive.js';
export {
  mapKnowledgeClassToCognitive,
  mapCognitiveToKnowledgeClasses,
} from './contracts/cognitive.js';
export { searchEpisodes, summarizeEpisode, reflect } from './core/episodic.js';
export type { EpisodicDeps } from './core/episodic.js';
export { searchCognitive } from './core/cognitive.js';
export { traverseAssociations, autoDetectAssociations } from './core/associations.js';
export type { AssociationNode, AssociationGraph, TraversalOptions } from './core/associations.js';
export type {
  ProfileView,
  ProfileSection,
  ProfileEntry,
  Profile,
  ProfileOptions,
} from './contracts/profile.js';
export {
  detectWorkspace,
  workspaceIdFromGitRemote,
  workspaceIdFromPath,
} from './core/workspace-detect.js';
export {
  getProfile,
  classifyProfileSection,
} from './core/profile.js';
