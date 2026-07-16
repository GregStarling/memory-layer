/**
 * ai-memory-layer public API surface, organized into tiers (Phase 6.5).
 *
 *   Tier 1 — Core daily API. The ~15 symbols almost every consumer touches:
 *            factories to build a manager/runtime + adapters, the effective-config
 *            inspector, and the handful of load-bearing domain types.
 *   Tier 2 — Capabilities, contracts, integrations, providers, and the full type
 *            vocabulary. Reach for these when you go past the happy path.
 *   Tier 3 — Advanced / low-level building blocks and internal plumbing. Powerful
 *            but rarely imported directly; these are the candidates for removal or
 *            re-homing in the next breaking major (6.0.0). Symbols here that are
 *            genuinely internal *and* unused across the repo are tagged @deprecated;
 *            per D-BREAK, anything an in-repo test/eval/example imports stays
 *            exported un-deprecated (our green suite is the back-compat proof).
 *
 * See docs/API_TIERS.md for the full tier map, the taxonomy mapping
 * (knowledge classes <-> cognitive overlay <-> derived types), and the
 * derived -> playbook promotion story.
 */

// ===========================================================================
// Tier 1 — Core daily API
// ===========================================================================

// Build a memory manager (sync or async adapter).
export { createMemory, createMemoryWithAsyncAdapter } from './composition/quick.js';
// Inspect the fully-merged config with per-field provenance before/without building.
export { resolveEffectiveConfig } from './composition/quick.js';
// Lower-level manager + runtime factories.
export { createMemoryManager } from './core/manager.js';
export { createMemoryRuntime } from './core/runtime.js';
// The two first-class storage adapters.
export { createSQLiteAdapter, createSQLiteAdapterWithEmbeddings } from './adapters/sqlite/index.js';
export { createInMemoryAdapter, createInMemoryAdapterWithEmbeddings } from './adapters/memory/index.js';

// Core domain + config types.
export type {
  MemoryManager,
  MemoryManagerConfig,
} from './core/manager.js';
export type {
  CreateMemoryOptions,
  CreateMemoryAsyncOptions,
  MemoryQualityMode,
  EffectiveManagerConfig,
  ConfigFieldSource,
  EffectiveConfigField,
} from './composition/quick.js';
export type { MemoryScope } from './contracts/identity.js';
export type {
  Turn,
  KnowledgeMemory,
  WorkItem,
  SearchResult,
  SearchOptions,
} from './contracts/types.js';

// ===========================================================================
// Tier 2 — Capabilities, contracts, integrations, providers, types
// ===========================================================================

// -- Composition: presets, provider-configured managers, quick helpers --
export {
  createClaudeMemoryManager,
  createOpenAIMemoryManager,
} from './composition/provider-managers.js';
export { MEMORY_MANAGER_PRESETS, resolveMemoryManagerPreset } from './composition/presets.js';
export type { MemoryQualityTier } from './composition/quick.js';
export type {
  ClaudeMemoryManagerOptions,
  OpenAIMemoryManagerOptions,
} from './composition/provider-managers.js';
export type { MemoryManagerPreset, MemoryManagerPresetConfig } from './composition/presets.js';

// -- Context assembly, formatting, and monitoring --
export { assessContext } from './core/monitor.js';
export { buildMemoryContext } from './core/context.js';
export {
  formatBootstrapForPrompt,
  formatContextAsMessages,
  formatContextForPrompt,
} from './core/formatter.js';
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

// -- Cognitive overlay + episodic recall (documented view over knowledge classes) --
export {
  mapKnowledgeClassToCognitive,
  mapCognitiveToKnowledgeClasses,
} from './contracts/cognitive.js';
export { searchCognitive } from './core/cognitive.js';
export { searchEpisodes, summarizeEpisode, reflect } from './core/episodic.js';
export type {
  CognitiveMemoryType,
  CognitiveMemoryItem,
  CognitiveSearchOptions,
  CognitiveSearchHit,
  CognitiveSearchResult,
} from './contracts/cognitive.js';
export type { EpisodicDeps } from './core/episodic.js';

// -- Profiles + workspace detection --
export {
  getProfile,
  classifyProfileSection,
} from './core/profile.js';
export {
  detectWorkspace,
  workspaceIdFromGitRemote,
  workspaceIdFromPath,
} from './core/workspace-detect.js';
export type {
  ProfileView,
  ProfileSection,
  ProfileEntry,
  Profile,
  ProfileOptions,
} from './contracts/profile.js';

// -- Knowledge lifecycle: maintenance, reflection, discovery, derivation, curation --
export { runMaintenance } from './core/maintenance.js';
export { reflectOnKnowledge } from './core/reflection.js';
export { discover } from './core/discover.js';
export { getGraphReport } from './core/graph-report.js';
export { lintKnowledge } from './core/knowledge-lint.js';
export { getFactsAt } from './core/temporal.js';
export { getCurationSummary, type CurationInput } from './core/curation.js';
export { getCoreMemory } from './core/core-memory.js';
export { validateExtractedFacts, checkOntologyViolations } from './core/ontology.js';
export { derive, registerDerivationHandler, unregisterDerivationHandler } from './core/derived.js';
export { traverseAssociations, autoDetectAssociations } from './core/associations.js';
export { computeClusters, formatClustersAsSection, expandFromClusters } from './core/cluster.js';
export { resolveAliases, discoverAliasCandidates } from './core/aliases.js';
export { exportBundle, importBundle } from './core/bundles.js';
export { refreshDocuments } from './core/corpus-refresh.js';
export type { MaintenanceReport } from './core/maintenance.js';
export type {
  ReflectOnKnowledgeOptions,
  ReflectionFact,
  ReflectionPattern,
  KnowledgeReflectionResult,
} from './contracts/reflection.js';
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
  DerivedOutputType,
  DerivedOutput,
  DeriveOptions,
} from './contracts/derived.js';
export type { AssociationNode, AssociationGraph, TraversalOptions } from './core/associations.js';
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

// -- Runtime lifecycle types --
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

// -- Manager companion types --
export type {
  KnowledgeChangeRecord,
  KnowledgeChangeResult,
  ContextQueryOptions,
  ContextExpansionOptions,
} from './core/manager.js';

// -- Contracts: identity / scope --
export { widenScope } from './contracts/identity.js';
export type { NormalizedMemoryScope, ScopeLevel, ScopeQuery } from './contracts/identity.js';

// -- Contracts: context governance --
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

// -- Contracts: storage + session --
export type { StorageAdapter } from './contracts/storage.js';
export type { AsyncStorageAdapter } from './contracts/async-storage.js';
export type { SessionState } from './contracts/session-state.js';

// -- Contracts: coordination (claims / handoffs) --
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

// -- Contracts: temporal / change stream --
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

// -- Contracts: errors + observability --
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
  NotImplementedError,
  isMemoryDomainError,
} from './contracts/errors.js';
export type { Logger, MemoryEvent, MemoryEventType, EventHook } from './contracts/observability.js';
export { noopLogger } from './contracts/observability.js';

// -- Contracts: policy --
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
  UNLIMITED_TOKEN_BUDGET,
} from './contracts/policy.js';

// -- Contracts: embedding --
export type {
  EmbeddingVector,
  EmbeddingGenerator,
  EmbeddingAdapter,
  SimilarEmbeddingResult,
} from './contracts/embedding.js';

// -- Contracts: the full domain type vocabulary --
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
  NewTurn,
  WorkingMemory,
  NewWorkingMemory,
  KnowledgeCandidate,
  NewKnowledgeCandidate,
  KnowledgeEvidence,
  NewKnowledgeEvidence,
  KnowledgeTrustAssessment,
  KnowledgeConflict,
  NewKnowledgeMemory,
  ContextMonitor,
  ContextMonitorUpsert,
  CompactionLog,
  NewCompactionLog,
  PaginationOptions,
  PaginatedResult,
  TimeRange,
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
  AssociationProvenance,
} from './contracts/types.js';
export { EPISODE_DETAIL_LEVELS, ASSOCIATION_TYPES, ASSOCIATION_TARGET_KINDS } from './contracts/types.js';

// -- Integrations (framework/provider adapters) --
export { createClaudeMemoryTools } from './integrations/claude-tools.js';
export { prepareClaudeAgentInput, wrapClaudeAgentModel } from './integrations/claude-agent.js';
export { createLangChainMemoryBridge } from './integrations/langchain.js';
export { createMemoryMcpAdapter } from './integrations/mcp.js';
export { wrapWithMemory } from './integrations/middleware.js';
export { createOpenAIMemoryTools } from './integrations/openai-tools.js';
export { prepareVercelAIInput, wrapVercelAIModel } from './integrations/vercel-ai.js';
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

// -- Server transports --
export { startHttpServer, createMcpServerHandler, startMcpServer } from './server/index.js';
export type { McpServerConfig } from './server/mcp-server.js';
export type { HttpServerConfig } from './server/http-server.js';

// -- Providers: summarizers + extractors + embeddings --
export { createClaudeSummarizer } from './summarizers/claude.js';
export { createExtractiveSummarizer } from './summarizers/extractive.js';
export { createOpenAISummarizer } from './summarizers/openai.js';
export { createClaudeExtractor, createOpenAIExtractor } from './summarizers/extractor.js';
export { createClientExtractor, createClientSummarizer } from './summarizers/client.js';
export { createLocalEmbeddingGenerator } from './embeddings/local.js';
export type {
  StructuredGenerationClient,
  StructuredGenerationRequest,
} from './summarizers/client.js';

// ===========================================================================
// Tier 3 — Advanced / low-level building blocks (6.0.0 removal candidates)
//
// Powerful but rarely imported directly. Kept exported this major (D-BREAK);
// audit for removal or re-homing in 6.0.0. See docs/API_TIERS.md.
// ===========================================================================

// -- Token estimation primitives --
export {
  estimateTokens,
  createModelTokenEstimator,
  createTiktokenEstimator,
  createSessionId,
} from './core/tokens.js';
export type { TokenEstimator } from './core/tokens.js';

// -- Event emitter + sync/circuit primitives --
export { createMemoryEventEmitter } from './core/events.js';
export { createMemorySync } from './core/sync.js';
export { createCircuitBreaker } from './core/circuit-breaker.js';
export type { MemoryEventEmitter } from './core/events.js';
export type {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitState,
  CircuitBreakerSnapshot,
} from './core/circuit-breaker.js';

// -- Orchestrator internals (compaction / knowledge promotion) --
export {
  compactTurns,
  commitCompaction,
  promoteToKnowledge,
  extractKnowledge,
} from './core/orchestrator.js';
export type {
  CompactionResult,
  KnowledgeVerifier,
  Summarizer,
  SummarizerOutput,
} from './core/orchestrator.js';

// -- Extractor internals --
export { createRegexExtractor, extractTemporalWindow, extractRationale } from './core/extractor.js';
export type { ExtractedFact, Extractor, DomainGroups } from './core/extractor.js';

// -- Streaming primitives --
export { createStreamCollector, processStreamingTurn } from './core/streaming.js';
export type { StreamCollector } from './core/streaming.js';

// -- Adapter plumbing: hand-off sync adapters to the async surface --
export { wrapSyncAdapter } from './adapters/sync-to-async.js';

// -- Embedding resilience wrappers --
export {
  withRetry,
  batchedGenerate,
  createCachedEmbeddingGenerator,
} from './embeddings/resilience.js';

// -- Summarizer/extractor prompt scaffolding --
export {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_PROMPT_VERSION,
  formatTurnsForSummarization,
  parseSummarizerResponse,
  parseExtractionResponse,
} from './summarizers/prompts.js';
