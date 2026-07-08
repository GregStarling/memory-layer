import type { AliasMap } from '../contracts/aliases.js';
import type { OntologyConfig } from '../contracts/ontology.js';
import type {
  EmbeddingAdapter,
  EmbeddingGenerator,
  EmbeddingQueryFilter,
} from '../contracts/embedding.js';
import type {
  ActorRef,
  ContextViewPolicy,
  HandoffRecord,
  WorkClaim,
  WorkItemPatch,
} from '../contracts/coordination.js';
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import {
  NotImplementedError,
  ProviderUnavailableError,
  ResourceNotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../contracts/errors.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MaintenancePolicy,
  MonitorPolicy,
} from '../contracts/policy.js';
import type {
  ContextContract,
  ContextContractReference,
  ContextInvariant,
  ContextRequest,
  ContextRequestResolution,
  AppliedContextContract,
  ContextWarning,
  ContextEscalationPolicy,
  ContextEscalationChange,
  ContextEscalationRuleDecision,
  ContextEscalationDecision,
  ContextGovernanceSnapshot,
} from '../contracts/context-contract.js';
import {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_MAINTENANCE_POLICY,
  DEFAULT_MONITOR_POLICY,
} from '../contracts/policy.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type {
  CompactionLog,
  ContextMonitor,
  FactConfidence,
  FactType,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  KnowledgeTrustAssessment,
  NewPlaybook,
  PaginationOptions,
  PaginatedResult,
  Playbook,
  Association,
  AssociationTargetKind,
  AssociationType,
  NewAssociation,
  PlaybookRevision,
  SearchOptions,
  SearchResult,
  EpisodeSearchOptions,
  EpisodeSummary,
  ReflectOptions,
  ReflectResult,
  TimeRange,
  Turn,
  TurnRole,
  WorkItem,
  WorkingMemory,
} from '../contracts/types.js';
import {
  buildDerivedShortTermState,
  buildMemoryContext,
  filterKnowledgeByContextRequirements,
  getContextWorkItems,
  resolveContextScopeLevel,
  resolveVisibleHandoffs,
  resolveVisibleAssociations,
  resolveVisibleKnowledge,
  resolveVisiblePlaybooks,
  resolveVisibleWorkClaims,
  resolveVisibleWorkItems,
  type MemoryContext,
} from './context.js';
import type { MemoryEventEmitter } from './events.js';
import type { Extractor } from './extractor.js';
import type { SessionBootstrap } from './formatter.js';
import {
  compactTurns,
  extractKnowledge,
  type CompactionResult,
  type Summarizer,
} from './orchestrator.js';
import { assessContext } from './monitor.js';
import { runMaintenance, type MaintenanceReport } from './maintenance.js';
import { emitMemoryEvent } from './telemetry.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { isBaseVisible } from '../adapters/shared/index.js';
import { estimateTokens, type TokenEstimator } from './tokens.js';
import {
  createCircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
import { DEFAULT_EXTRACTION_POLICY } from '../contracts/policy.js';
import { assessKnowledgeReverification } from './trust.js';
import { matchesKnowledgeSearchOptions, rankKnowledge } from './retrieval.js';
import {
  computeNextReverificationAt,
  getDueReverificationKnowledge,
  resolveMaintenancePolicy,
} from './knowledge-lifecycle.js';
import type {
  CognitiveSearchOptions,
  CognitiveSearchResult,
} from '../contracts/cognitive.js';
import type {
  TemporalId,
  TemporalIdInput,
  MemoryEventEntityKind,
  MemoryEventRecord,
  TemporalStateDiff,
  TemporalStateSnapshot,
  TimelineResult,
} from '../contracts/temporal.js';
import { compareTemporalIds, normalizeTemporalId } from '../contracts/temporal.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';
import { searchEpisodes, summarizeEpisode, reflect } from './episodic.js';
import { searchCognitive } from './cognitive.js';
import { traverseAssociations, type AssociationGraph } from './associations.js';
import { exportAsMarkdown } from './markdown-export.js';
import { createHash } from 'crypto';
import type { Profile, ProfileOptions } from '../contracts/profile.js';
import { buildProfileFromKnowledge, getProfile } from './profile.js';
import {
  createPlaybookFromTask,
  revisePlaybook,
  findRelevantPlaybooks,
  type CreatePlaybookFromTaskInput,
} from './playbook.js';
import {
  createTemporalReplayAdapter,
  foldTemporalState,
  listAllMemoryEvents,
  listAllMemoryEventsBounded,
  listAllMemoryEventsCrossScope,
  normalizeReplayedTemporalState,
  normalizeHandoffAt,
  normalizeWorkClaimAt,
  getFactsAt,
} from './temporal.js';
import { discover } from './discover.js';
import { getGraphReport } from './graph-report.js';
import { reflectOnKnowledge } from './reflection.js';
import { derive } from './derived.js';
import { getCurationSummary, type CurationInput } from './curation.js';
import { getCoreMemory } from './core-memory.js';
import { discoverAliasCandidates } from './aliases.js';
import { exportBundle, importBundle, type ExportBundleResult, type ImportBundleResult } from './bundles.js';
import { refreshDocuments, type DocumentDescriptor, type RefreshResult } from './corpus-refresh.js';
import type { DiscoverOptions, DiscoveryReport } from '../contracts/discovery.js';
import type { GraphReportOptions, GraphReport } from '../contracts/graph-report.js';
import type { TemporalQueryOptions, FactsAtResult } from '../contracts/temporal-query.js';
import type { ReflectOnKnowledgeOptions, KnowledgeReflectionResult } from '../contracts/reflection.js';
import type { DeriveOptions, DerivedOutput } from '../contracts/derived.js';
import type { CurationOptions, CurationSummary } from '../contracts/curation.js';
import type { CoreMemoryOptions, CoreMemoryBundle } from '../contracts/core-memory.js';
import type { AliasCandidate } from '../contracts/aliases.js';
import type { BundleExportOptions, BundleImportOptions, MemoryBundle } from '../contracts/bundles.js';
import type { DiscoverAliasCandidatesOptions } from './aliases.js';
import { getNativeSyncAdapter } from '../adapters/sync-to-async.js';
import {
  parseAliases,
  parseOntology,
  SCOPE_CONFIG_KEYS,
  serializeAliases,
  serializeOntology,
} from './scope-config.js';

export interface MemoryManagerConfig {
  /** Synchronous storage adapter (SQLite, in-memory). Mutually exclusive with asyncAdapter. */
  adapter?: StorageAdapter;
  /** Async storage adapter (PostgreSQL, remote). Mutually exclusive with adapter. */
  asyncAdapter?: AsyncStorageAdapter;
  scope: MemoryScope;
  sessionId: string;
  summarizer: Summarizer;
  extractor?: Extractor;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingGenerator?: EmbeddingGenerator;
  /**
   * Identifier of the active embedding model (Phase 2.4). Stored alongside each
   * vector so mismatched vectors are excluded from similarity search in the
   * storage layer before any distance comparison. Defaults to `'unknown'`.
   */
  embeddingModel?: string;
  logger?: Logger;
  onEvent?: EventHook;
  eventEmitter?: MemoryEventEmitter;
  monitorPolicy?: MonitorPolicy;
  extractionPolicy?: ExtractionPolicy;
  contextPolicy?: ContextPolicy;
  maintenancePolicy?: MaintenancePolicy;
  crossScopeLevel?: ScopeLevel;
  contextContract?: ContextContract;
  contextContracts?: Record<string, ContextContract>;
  invariants?: ContextInvariant[];
  escalationPolicy?: ContextEscalationPolicy;
  tokenEstimator?: TokenEstimator;
  autoCompact?: boolean;
  autoExtract?: boolean;
  failurePolicy?: {
    summarizer?: 'throw' | 'retry_once' | 'log_and_continue';
    extractor?: 'throw' | 'retry_once' | 'log_and_continue' | 'disable_auto_extract';
  };
  circuitBreaker?: {
    summarizer?: CircuitBreakerOptions;
    extractor?: CircuitBreakerOptions;
    embeddings?: CircuitBreakerOptions;
  };
  redactText?: (input: { kind: 'turn' | 'fact' | 'work_item'; text: string }) => string;
  structuredClient?: StructuredGenerationClient;
  closeAdapter?: boolean;
  aliasMap?: AliasMap;
  ontology?: OntologyConfig;
}

export interface ContextQueryOptions {
  view?: ContextViewPolicy;
  viewer?: ActorRef;
  includeCoordinationState?: boolean;
  contract?: ContextContractReference;
  invariants?: ContextInvariant[];
}

export interface ContextExpansionOptions {
  currentContract?: ContextContractReference;
}

export interface KnowledgeChangeRecord {
  event_id: TemporalId;
  event_type: MemoryEventRecord['event_type'];
  created_at: number;
  knowledge: KnowledgeMemory;
}

export interface KnowledgeChangeResult {
  changes: KnowledgeChangeRecord[];
  nextCursor: TemporalId;
}

export interface MemoryManager {
  processTurn(role: TurnRole, content: string, actor?: string): Promise<Turn>;
  processExchange(
    userContent: string,
    assistantContent: string,
    actors?: { user?: string; assistant?: string },
  ): Promise<{ userTurn: Turn; assistantTurn: Turn; compactionResult: CompactionResult | null }>;
  getContext(
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<MemoryContext>;
  getContextAt(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<MemoryContext>;
  requestContextExpansion(
    request: ContextRequest,
    options?: ContextExpansionOptions,
  ): Promise<ContextRequestResolution>;
  getContextGovernance(): Promise<ContextGovernanceSnapshot>;
  setDefaultContextContract(contract: ContextContract | null): Promise<ContextContract | null>;
  putContextContract(name: string, contract: ContextContract): Promise<ContextContract>;
  deleteContextContract(name: string): Promise<boolean>;
  putContextInvariant(invariant: ContextInvariant): Promise<ContextInvariant>;
  deleteContextInvariant(id: string): Promise<boolean>;
  getContextEscalationPolicy(): Promise<ContextGovernanceSnapshot['escalationPolicy']>;
  setContextEscalationPolicy(
    policy: ContextEscalationPolicy,
  ): Promise<ContextGovernanceSnapshot['escalationPolicy']>;
  getStateAt(
    asOf: number,
    options?: {
      relevanceQuery?: string;
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
      contract?: ContextContractReference;
      invariants?: ContextInvariant[];
    },
  ): Promise<TemporalStateSnapshot<MemoryContext>>;
  getTimeline(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: TemporalIdInput;
  }): Promise<TimelineResult>;
  diffState(
    from: number,
    to: number,
    options?: {
      sessionId?: string;
      entityKind?: MemoryEventEntityKind;
      entityId?: string;
      maxEvents?: number;
    },
  ): Promise<TemporalStateDiff>;
  listMemoryEvents(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: TemporalIdInput;
  }): Promise<TimelineResult>;
  getSessionBootstrap(
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<SessionBootstrap>;
  getSessionBootstrapAt(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<SessionBootstrap>;
  captureSnapshot(
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<{
    bootstrap: SessionBootstrap;
    context: MemoryContext;
    frozenAt: number;
    watermarkEventId: string | null;
    profile: Profile | null;
  }>;
  getRuntimeDiagnostics(): Promise<{
    circuitBreakers: {
      summarizer: CircuitBreakerSnapshot;
      extractor: CircuitBreakerSnapshot;
      embeddings: CircuitBreakerSnapshot;
    };
  }>;
  recall(timeRange: TimeRange): Promise<{
    turns: Turn[];
    workingMemory: WorkingMemory[];
    knowledge: KnowledgeMemory[];
    workItems: WorkItem[];
  }>;
  search(
    query: string,
    options?: SearchOptions,
  ): Promise<{ turns: SearchResult<Turn>[]; knowledge: SearchResult<KnowledgeMemory>[] }>;
  searchCrossScope(
    query: string,
    level: ScopeLevel,
    options?: SearchOptions,
  ): Promise<{ knowledge: SearchResult<KnowledgeMemory>[] }>;
  listKnowledgeChanges(options?: {
    cursor?: TemporalIdInput;
    since?: Date;
    scopeLevel?: ScopeLevel;
    limit?: number;
  }): Promise<KnowledgeChangeResult>;
  pollForChanges(since: Date, options?: { scopeLevel?: ScopeLevel }): Promise<KnowledgeMemory[]>;
  forceCompact(): Promise<CompactionResult | null>;
  learnFact(fact: string, factType: FactType, confidence?: FactConfidence, rationale?: string | null): Promise<KnowledgeMemory>;
  trackWorkItem(
    title: string,
    kind?: WorkItem['kind'],
    status?: WorkItem['status'],
    detail?: string,
    options?: { visibilityClass?: WorkItem['visibility_class'] },
  ): Promise<WorkItem>;
  updateWorkItem(
    id: number,
    patch: WorkItemPatch,
    options?: { expectedVersion?: number },
  ): Promise<WorkItem | null>;
  claimWorkItem(input: {
    workItemId: number;
    actor: ActorRef;
    leaseSeconds?: number;
  }): Promise<WorkClaim>;
  renewWorkClaim(
    claimId: number,
    actor: ActorRef,
    leaseSeconds?: number,
  ): Promise<WorkClaim | null>;
  releaseWorkClaim(
    claimId: number,
    actor: ActorRef,
    reason?: string,
  ): Promise<WorkClaim | null>;
  listWorkClaims(options?: {
    actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
    sessionId?: string;
  }): Promise<WorkClaim[]>;
  handoffWorkItem(input: {
    workItemId: number;
    fromActor: ActorRef;
    toActor: ActorRef;
    summary: string;
    contextBundleRef?: string | null;
    expiresAt?: number | null;
  }): Promise<HandoffRecord>;
  acceptHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  rejectHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  cancelHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  listPendingHandoffs(options?: {
    actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
    direction?: 'inbound' | 'outbound' | 'all';
  }): Promise<HandoffRecord[]>;
  streamChanges(options?: {
    cursor?: TemporalIdInput;
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): AsyncIterable<MemoryEventRecord>;
  resolveChangeStreamCursor(cursor?: TemporalIdInput): Promise<TemporalId>;
  inspectKnowledge(id: number): Promise<{
    knowledge: KnowledgeMemory | null;
    evidence: KnowledgeEvidence[];
    audits: KnowledgeMemoryAudit[];
  }>;
  listKnowledge(options?: PaginationOptions): Promise<PaginatedResult<KnowledgeMemory>>;
  getKnowledgeAudits(options?: { knowledgeId?: number; limit?: number }): Promise<KnowledgeMemoryAudit[]>;
  getContextMonitor(): Promise<ContextMonitor | null>;
  getRecentCompactionLogs(limit?: number): Promise<CompactionLog[]>;
  getDueReverification(options?: { limit?: number }): Promise<KnowledgeMemory[]>;
  reverifyKnowledge(id: number): Promise<KnowledgeTrustAssessment>;
  runReverification(options?: { limit?: number }): Promise<{
    reverifiedKnowledgeIds: number[];
    demotedKnowledgeIds: number[];
  }>;
  runMaintenance(policy?: MaintenancePolicy): Promise<MaintenanceReport>;
  /**
   * Re-embed active knowledge whose stored embedding's (model, dimensions) do
   * not match the active provider (Phase 2.4). Batches through the active
   * knowledge set, re-embeds mismatched/missing rows with the active provider,
   * and overwrites their stored vectors + metadata. No-op without an embedding
   * adapter + generator. Returns the ids that were re-embedded.
   *
   * TODO(plan 6.3): expose via HTTP/MCP once the operation registry lands
   * (transport churn deferred).
   */
  reembedKnowledge(options?: { batchSize?: number }): Promise<{ reembeddedIds: number[] }>;
  searchEpisodes(options: EpisodeSearchOptions): Promise<EpisodeSummary[]>;
  summarizeEpisode(sessionId: string, options?: { detailLevel?: EpisodeSummary['detailLevel'] }): Promise<EpisodeSummary>;
  reflect(options: ReflectOptions): Promise<ReflectResult>;
  searchCognitive(options: CognitiveSearchOptions): Promise<CognitiveSearchResult>;
  getProfile(options?: ProfileOptions): Promise<Profile>;
  createPlaybook(input: Omit<NewPlaybook, 'tenant_id' | 'system_id' | 'scope_id' | 'workspace_id' | 'collaboration_id'>): Promise<Playbook>;
  createPlaybookFromTask(input: CreatePlaybookFromTaskInput): Promise<Playbook>;
  revisePlaybook(
    playbookId: number,
    newInstructions: string,
    revisionReason: string,
    sourceSessionId?: string | null,
  ): Promise<{ playbook: Playbook; revision: PlaybookRevision }>;
  getPlaybook(id: number): Promise<Playbook | null>;
  listPlaybooks(): Promise<Playbook[]>;
  searchPlaybooks(query: string, options?: SearchOptions): Promise<SearchResult<Playbook>[]>;
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
  ): Promise<Playbook | null>;
  recordPlaybookUse(id: number): Promise<void>;
  addAssociation(input: Omit<NewAssociation, 'tenant_id' | 'system_id' | 'scope_id' | 'workspace_id' | 'collaboration_id'>): Promise<Association>;
  getAssociations(kind: AssociationTargetKind, id: number): Promise<{ from: Association[]; to: Association[] }>;
  traverseAssociations(kind: AssociationTargetKind, id: number, options?: { maxDepth?: number; maxNodes?: number }): Promise<AssociationGraph>;
  removeAssociation(id: number): Promise<void>;
  ingestDocument(
    content: string,
    options: { title: string; url?: string; mimeType?: string; metadata?: Record<string, string> },
  ): Promise<{ document: import('../contracts/types.js').SourceDocument; knowledge: KnowledgeMemory[] }>;
  getSourceDocument(id: number): Promise<import('../contracts/types.js').SourceDocument | null>;
  listSourceDocuments(options?: PaginationOptions): Promise<PaginatedResult<import('../contracts/types.js').SourceDocument>>;
  exportAsMarkdown(options?: import('../contracts/export.js').MarkdownExportOptions): Promise<import('../contracts/export.js').MarkdownExportResult>;
  promoteResponse(turnId: number, options?: { factTypes?: FactType[]; minConfidence?: FactConfidence }): Promise<KnowledgeMemory[]>;

  // Phase 5 methods
  discover(options?: DiscoverOptions): Promise<DiscoveryReport>;
  getGraphReport(options?: GraphReportOptions): Promise<GraphReport>;
  getFactsAt(timestamp: number, options?: Partial<Omit<TemporalQueryOptions, 'timestamp' | 'scope'>>): Promise<FactsAtResult>;
  reflectOnKnowledge(options?: ReflectOnKnowledgeOptions): Promise<KnowledgeReflectionResult>;
  derive(options?: DeriveOptions): Promise<DerivedOutput[]>;
  getCurationSummary(input?: Partial<CurationInput>, options?: CurationOptions): Promise<CurationSummary>;
  getCoreMemory(options?: CoreMemoryOptions): Promise<CoreMemoryBundle>;
  setAliases(aliasMap: AliasMap): void;
  getAliases(): AliasMap | undefined;
  saveAliases(aliasMap: AliasMap): Promise<void>;
  loadAliases(): Promise<AliasMap | undefined>;
  getAliasCandidates(options?: DiscoverAliasCandidatesOptions): Promise<AliasCandidate[]>;
  setOntology(ontology: OntologyConfig): void;
  getOntology(): OntologyConfig | undefined;
  saveOntology(ontology: OntologyConfig): Promise<void>;
  loadOntology(): Promise<OntologyConfig | undefined>;
  exportBundle(name: string, options?: Partial<BundleExportOptions>): ExportBundleResult;
  importBundle(bundle: MemoryBundle, options: BundleImportOptions): ImportBundleResult;
  refreshDocuments(documents: DocumentDescriptor[]): RefreshResult;

  close(): Promise<void>;
}

function resolveAdapter(config: MemoryManagerConfig): AsyncStorageAdapter {
  if (config.asyncAdapter) {
    return config.asyncAdapter;
  }
  if (config.adapter) {
    return wrapSyncAdapter(config.adapter);
  }
  throw new ValidationError("MemoryManagerConfig requires either 'adapter' or 'asyncAdapter'");
}

function resolveSyncAdapter(
  config: MemoryManagerConfig,
  asyncAdapter: AsyncStorageAdapter,
  operation: string,
): StorageAdapter {
  const syncAdapter = config.adapter ?? getNativeSyncAdapter(asyncAdapter);
  if (!syncAdapter) {
    throw new NotImplementedError(
      `${operation} is not available on this deployment (requires sync adapter access)`,
    );
  }
  return syncAdapter;
}

function manualKnowledgeClassForFactType(factType: FactType): KnowledgeMemory['knowledge_class'] {
  switch (factType) {
    case 'preference':
      return 'preference';
    case 'constraint':
      return 'constraint';
    case 'decision':
      return 'procedure';
    case 'entity':
      return 'identity';
    default:
      return 'project_fact';
  }
}

function mergeContextContract(
  base: ContextContract | undefined,
  override: ContextContract | undefined,
): ContextContract | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    knowledgeClasses: override?.knowledgeClasses ?? base?.knowledgeClasses,
  };
}

function mergeContextInvariants(
  base: ContextInvariant[] | undefined,
  override: ContextInvariant[] | undefined,
): ContextInvariant[] {
  const merged = [...(base ?? []), ...(override ?? [])];
  if (merged.length === 0) return [];
  const deduped = new Map<string, ContextInvariant>();
  for (const invariant of merged) {
    deduped.set(invariant.id, invariant);
  }
  return [...deduped.values()];
}

function normalizeContextEscalationPolicy(
  policy: ContextEscalationPolicy | undefined,
): ContextGovernanceSnapshot['escalationPolicy'] {
  return {
    defaultDecision: policy?.defaultDecision ?? 'review',
    byChange: { ...(policy?.byChange ?? {}) },
    maxView: policy?.maxView,
    maxScopeLevel: policy?.maxScopeLevel,
    maxTokenBudget: policy?.maxTokenBudget,
    minimumAllowedTrustScore: policy?.minimumAllowedTrustScore,
  };
}

function cloneContextContract(contract: ContextContract | null | undefined): ContextContract | null {
  if (!contract) return null;
  return {
    ...contract,
    knowledgeClasses: contract.knowledgeClasses ? [...contract.knowledgeClasses] : undefined,
  };
}

function cloneContextInvariant(invariant: ContextInvariant): ContextInvariant {
  return { ...invariant };
}

function cloneContextEscalationPolicy(
  policy: ContextGovernanceSnapshot['escalationPolicy'],
): ContextGovernanceSnapshot['escalationPolicy'] {
  return {
    ...policy,
    byChange: { ...(policy.byChange ?? {}) },
  };
}

function viewRank(view: ContextViewPolicy | undefined): number {
  switch (view) {
    case 'operator_supervisor':
      return 4;
    case 'workspace_shared':
      return 3;
    case 'local_plus_shared_collaboration':
      return 2;
    case 'local_only':
    default:
      return 1;
  }
}

function scopeLevelRank(level: ScopeLevel | undefined): number {
  switch (level) {
    case 'tenant':
      return 4;
    case 'system':
      return 3;
    case 'workspace':
      return 2;
    case 'scope':
    default:
      return 1;
  }
}

/**
 * Resolve an association endpoint (source or target) and verify it exists
 * and belongs to the caller's normalized scope. Throws a descriptive error
 * if the node is missing or cross-scope. This is the sole authority on
 * association ID validity; HTTP/MCP layers should NOT rely on their own
 * type checks for scope safety.
 */
async function assertAssociationEndpointInScope(
  adapter: AsyncStorageAdapter,
  norm: ReturnType<typeof normalizeScope>,
  kind: AssociationTargetKind,
  id: number,
  role: 'source' | 'target',
): Promise<void> {
  const scopedMatch = (record: {
    tenant_id: string;
    system_id: string;
    workspace_id: string;
    collaboration_id: string;
    scope_id: string;
  }) =>
    record.tenant_id === norm.tenant_id &&
    record.system_id === norm.system_id &&
    record.workspace_id === norm.workspace_id &&
    record.collaboration_id === norm.collaboration_id &&
    record.scope_id === norm.scope_id;

  if (kind === 'knowledge') {
    const km = await adapter.getKnowledgeMemoryById(id);
    if (!km) {
      throw new ResourceNotFoundError(`addAssociation: ${role} knowledge ${id} does not exist`);
    }
    if (!scopedMatch(km)) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} knowledge ${id} is not in the current scope`,
      );
    }
    return;
  }
  if (kind === 'playbook') {
    const pb = await adapter.getPlaybookById(id);
    if (!pb) {
      throw new ResourceNotFoundError(`addAssociation: ${role} playbook ${id} does not exist`);
    }
    if (!scopedMatch(pb)) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} playbook ${id} is not in the current scope`,
      );
    }
    return;
  }
  if (kind === 'working_memory') {
    const wm = await adapter.getWorkingMemoryById(id);
    if (!wm) {
      throw new ResourceNotFoundError(
        `addAssociation: ${role} working_memory ${id} does not exist`,
      );
    }
    if (!scopedMatch(wm)) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} working_memory ${id} is not in the current scope`,
      );
    }
    return;
  }
  if (kind === 'work_item') {
    const match = await adapter.getWorkItemById(id);
    if (!match) {
      throw new ResourceNotFoundError(
        `addAssociation: ${role} work_item ${id} does not exist in the current scope`,
      );
    }
    if (
      match.tenant_id !== norm.tenant_id ||
      match.system_id !== norm.system_id ||
      match.workspace_id !== norm.workspace_id ||
      match.collaboration_id !== norm.collaboration_id ||
      match.scope_id !== norm.scope_id
    ) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} work_item ${id} does not exist in the current scope`,
      );
    }
    return;
  }
  // Exhaustiveness: AssociationTargetKind has no other members.
  throw new ValidationError(`addAssociation: unknown ${role} kind '${kind as string}'`);
}

/**
 * Merge archived and active turns by id, preserving order by turn id.
 * Partially compacted sessions have both sets; summarizing from only one
 * drops context, so callers should always pass the union through this.
 */
function mergeTurnsById(archived: Turn[], active: Turn[]): Turn[] {
  const byId = new Map<number, Turn>();
  for (const t of archived) byId.set(t.id, t);
  for (const t of active) byId.set(t.id, t);
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

function knowledgeMatchesScope(knowledge: KnowledgeMemory, scope: MemoryScope): boolean {
  const normalized = normalizeScope(scope);
  return (
    knowledge.tenant_id === normalized.tenant_id &&
    knowledge.system_id === normalized.system_id &&
    knowledge.workspace_id === normalized.workspace_id &&
    knowledge.collaboration_id === normalized.collaboration_id &&
    knowledge.scope_id === normalized.scope_id
  );
}

function entityMatchesScope(
  entity: { tenant_id: string; system_id: string; workspace_id: string; collaboration_id: string; scope_id: string },
  scope: MemoryScope,
): boolean {
  const normalized = normalizeScope(scope);
  return (
    entity.tenant_id === normalized.tenant_id &&
    entity.system_id === normalized.system_id &&
    entity.workspace_id === normalized.workspace_id &&
    entity.collaboration_id === normalized.collaboration_id &&
    entity.scope_id === normalized.scope_id
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const asyncAdapter = resolveAdapter(config);
  const autoCompact = config.autoCompact ?? true;
  let autoExtractEnabled = config.autoExtract ?? Boolean(config.extractor);
  let deferredSoftCompaction = false;
  const tokenEstimator = config.tokenEstimator ?? estimateTokens;
  const circuitBreakers = {
    summarizer: createCircuitBreaker(config.circuitBreaker?.summarizer),
    extractor: createCircuitBreaker(config.circuitBreaker?.extractor),
    embeddings: createCircuitBreaker(config.circuitBreaker?.embeddings),
  };

  // Cache last maintenance/reflection results for curation summary auto-population
  let lastMaintenanceReport: import('./maintenance.js').MaintenanceReport | undefined;
  let lastMaintenanceTimestamp: number | undefined;
  let lastReflectionResult: import('../contracts/reflection.js').KnowledgeReflectionResult | undefined;
  let lastReflectionTimestamp: number | undefined;
  let lastDerivedOutputs: import('../contracts/derived.js').DerivedOutput[] | undefined;
  let lastDerivedTimestamp: number | undefined;
  let defaultContextContract = cloneContextContract(config.contextContract);
  const namedContextContracts = new Map<string, ContextContract>(
    Object.entries(config.contextContracts ?? {}).map(([name, contract]) => [
      name,
      cloneContextContract({ name: contract.name ?? name, ...contract })!,
    ]),
  );
  const configuredInvariants = mergeContextInvariants(config.invariants, undefined);
  const contextInvariants = new Map<string, ContextInvariant>(
    configuredInvariants.map((invariant) => [invariant.id, cloneContextInvariant(invariant)]),
  );
  let escalationPolicy = normalizeContextEscalationPolicy(config.escalationPolicy);

  let governanceLoaded = false;
  let governanceLoadPromise: Promise<void> | null = null;

  async function ensureGovernanceLoaded(): Promise<void> {
    if (governanceLoaded) return;
    if (governanceLoadPromise) return governanceLoadPromise;
    governanceLoadPromise = (async () => {
      const persisted = await asyncAdapter.getGovernanceState?.(config.scope);
      if (persisted) {
        if (persisted.defaultContract?.state === 'set') {
          defaultContextContract = cloneContextContract(persisted.defaultContract.contract);
        } else if (persisted.defaultContract?.state === 'cleared') {
          defaultContextContract = null;
        }
        for (const [name, contract] of Object.entries(persisted.namedContracts)) {
          namedContextContracts.set(name, cloneContextContract({ name: contract.name ?? name, ...contract })!);
        }
        for (const name of persisted.deletedContractNames) {
          namedContextContracts.delete(name);
        }
        for (const inv of persisted.invariants) {
          contextInvariants.set(inv.id, cloneContextInvariant(inv));
        }
        for (const invariantId of persisted.deletedInvariantIds) {
          contextInvariants.delete(invariantId);
        }
        if (persisted.escalationPolicy) {
          escalationPolicy = normalizeContextEscalationPolicy(persisted.escalationPolicy);
        }
      }
      governanceLoaded = true;
    })();
    return governanceLoadPromise;
  }

  const onEvent: EventHook = (event) => {
    config.onEvent?.(event);
    config.eventEmitter?.emit({
      ...event,
      meta: {
        schemaVersion: 1,
        ...event.meta,
      },
    });
  };

  function resolveContextContractReference(
    reference?: ContextContractReference,
  ): ContextContract | undefined {
    if (reference == null) {
      return defaultContextContract ?? undefined;
    }
    if (typeof reference === 'string') {
      const named = namedContextContracts.get(reference);
      if (!named) {
        throw new ValidationError(`Unknown context contract: ${reference}`);
      }
      return mergeContextContract(defaultContextContract ?? undefined, {
        name: named.name ?? reference,
        ...named,
      });
    }
    return mergeContextContract(defaultContextContract ?? undefined, reference);
  }

  function getManagedInvariants(): ContextInvariant[] {
    return [...contextInvariants.values()].map(cloneContextInvariant);
  }

  function getGovernanceSnapshot(): ContextGovernanceSnapshot {
    const contracts = Object.fromEntries(
      [...namedContextContracts.entries()].map(([name, contract]) => [
        name,
        cloneContextContract(contract)!,
      ]),
    );
    return {
      defaultContract: cloneContextContract(defaultContextContract),
      contracts,
      invariants: getManagedInvariants(),
      escalationPolicy: cloneContextEscalationPolicy(escalationPolicy),
    };
  }

  function resolveContextQueryOptions(options?: ContextQueryOptions): {
    contract?: ContextContract;
    invariants: ContextInvariant[];
    view?: ContextViewPolicy;
    viewer?: ActorRef;
    includeCoordinationState?: boolean;
  } {
    return {
      contract: resolveContextContractReference(options?.contract),
      invariants: mergeContextInvariants(getManagedInvariants(), options?.invariants),
      view: options?.view,
      viewer: options?.viewer,
      includeCoordinationState: options?.includeCoordinationState,
    };
  }

  function materializeAppliedContextContract(contract?: ContextContract): AppliedContextContract {
    const view = contract?.view;
    const crossScopeLevel = resolveContextScopeLevel(
      contract?.crossScopeLevel ?? config.crossScopeLevel,
      view,
    );
    return {
      name: contract?.name,
      view,
      crossScopeLevel,
      tokenBudget:
        contract?.tokenBudget ??
        config.contextPolicy?.tokenBudget ??
        DEFAULT_CONTEXT_POLICY.tokenBudget,
      maxKnowledgeItems:
        contract?.maxKnowledgeItems ??
        config.contextPolicy?.maxKnowledgeItems ??
        DEFAULT_CONTEXT_POLICY.maxKnowledgeItems,
      maxRecentSummaries:
        contract?.maxRecentSummaries ??
        config.contextPolicy?.maxRecentSummaries ??
        DEFAULT_CONTEXT_POLICY.maxRecentSummaries,
      knowledgeClasses: contract?.knowledgeClasses ? [...contract.knowledgeClasses] : null,
      minimumTrustScore: contract?.minimumTrustScore ?? null,
      includeCoordinationState: contract?.includeCoordinationState ?? false,
    };
  }

  function knowledgeClassesAreBroader(
    current: AppliedContextContract['knowledgeClasses'],
    proposed: AppliedContextContract['knowledgeClasses'],
  ): boolean {
    if (current == null) return false;
    if (proposed == null) return true;
    const currentSet = new Set(current);
    return proposed.some((item) => !currentSet.has(item));
  }

  function buildContextExpansionResolution(
    request: ContextRequest,
    currentContract: ContextContract | undefined,
  ): ContextRequestResolution {
    const mergedContract = mergeContextContract(currentContract, request.contract);
    const currentApplied = currentContract ? materializeAppliedContextContract(currentContract) : null;
    const proposedApplied = materializeAppliedContextContract(mergedContract);
    const rationale: string[] = [];
    const changeKinds: ContextEscalationChange[] = [];

    if ((currentApplied?.view ? viewRank(proposedApplied.view) : 0) > viewRank(currentApplied?.view)) {
      changeKinds.push('broaden_view');
      rationale.push('Requested a broader visibility view.');
    }
    if (
      (currentApplied?.crossScopeLevel
        ? scopeLevelRank(proposedApplied.crossScopeLevel)
        : 0) > scopeLevelRank(currentApplied?.crossScopeLevel)
    ) {
      changeKinds.push('widen_scope');
      rationale.push('Requested a wider cross-scope retrieval level.');
    }
    if (
      currentApplied?.minimumTrustScore != null &&
      proposedApplied.minimumTrustScore != null &&
      proposedApplied.minimumTrustScore < currentApplied.minimumTrustScore
    ) {
      changeKinds.push('lower_minimum_trust');
      rationale.push('Requested a lower minimum trust threshold.');
    }
    if (knowledgeClassesAreBroader(currentApplied?.knowledgeClasses ?? null, proposedApplied.knowledgeClasses)) {
      changeKinds.push('broaden_knowledge_classes');
      rationale.push('Requested additional knowledge classes.');
    }
    if (
      currentApplied &&
      !currentApplied.includeCoordinationState &&
      proposedApplied.includeCoordinationState
    ) {
      changeKinds.push('include_coordination_state');
      rationale.push('Requested coordination state that is not currently exposed.');
    }
    if (
      currentApplied &&
      proposedApplied.tokenBudget > currentApplied.tokenBudget
    ) {
      changeKinds.push('increase_token_budget');
      rationale.push('Requested a larger token budget.');
    }
    if (rationale.length === 0) {
      rationale.push('Request can be satisfied within the current context boundary.');
    }
    let decision: ContextEscalationDecision = 'approved';

    if (
      escalationPolicy.maxView &&
      viewRank(proposedApplied.view) > viewRank(escalationPolicy.maxView)
    ) {
      decision = 'denied';
      rationale.push(`Policy caps visibility at ${escalationPolicy.maxView}.`);
    }
    if (
      escalationPolicy.maxScopeLevel &&
      scopeLevelRank(proposedApplied.crossScopeLevel) > scopeLevelRank(escalationPolicy.maxScopeLevel)
    ) {
      decision = 'denied';
      rationale.push(`Policy caps cross-scope retrieval at ${escalationPolicy.maxScopeLevel}.`);
    }
    if (
      escalationPolicy.maxTokenBudget != null &&
      proposedApplied.tokenBudget > escalationPolicy.maxTokenBudget
    ) {
      decision = 'denied';
      rationale.push(`Policy caps token budget at ${escalationPolicy.maxTokenBudget}.`);
    }
    if (
      escalationPolicy.minimumAllowedTrustScore != null &&
      proposedApplied.minimumTrustScore != null &&
      proposedApplied.minimumTrustScore < escalationPolicy.minimumAllowedTrustScore
    ) {
      decision = 'denied';
      rationale.push(
        `Policy does not allow trust thresholds below ${escalationPolicy.minimumAllowedTrustScore.toFixed(2)}.`,
      );
    }

    if (decision !== 'denied' && changeKinds.length > 0) {
      let strongestDecision: ContextEscalationRuleDecision = 'allow';
      for (const changeKind of changeKinds) {
        const ruleDecision = escalationPolicy.byChange?.[changeKind] ?? escalationPolicy.defaultDecision;
        if (ruleDecision === 'deny') {
          strongestDecision = 'deny';
          rationale.push(`Policy denies ${changeKind}.`);
          break;
        }
        if (ruleDecision === 'review') {
          strongestDecision = 'review';
        }
      }
      decision =
        strongestDecision === 'deny'
          ? 'denied'
          : strongestDecision === 'review'
            ? 'requires_approval'
            : 'approved';
    }

    const requiresEscalation = decision === 'requires_approval';
    const warnings: ContextWarning[] =
      decision === 'approved'
        ? []
        : [
            {
              code: 'contract_filtered',
              severity: 'warning',
              message:
                decision === 'denied'
                  ? 'This request exceeds the configured escalation policy and was denied.'
                  : 'This request broadens the current contract and requires approval by the orchestrator.',
              metadata: {
                decision,
                changeKinds,
              },
            },
          ];

    return {
      requestId: createHash('sha1')
        .update(JSON.stringify({ request, mergedContract, scope: config.scope, sessionId: config.sessionId }))
        .digest('hex')
        .slice(0, 16),
      requestedAt: Math.floor(Date.now() / 1000),
      reason: request.reason,
      note: request.note ?? null,
      currentContract: currentApplied,
      proposedContract: proposedApplied,
      proposedContractInput: mergedContract ?? {},
      changeKinds,
      decision,
      requiresEscalation,
      rationale,
      warnings,
    };
  }

  function resolveScopeLevelForContextQuery(options?: ContextQueryOptions): ScopeLevel | undefined {
    const resolvedOptions = resolveContextQueryOptions(options);
    return resolveContextScopeLevel(
      resolvedOptions.contract?.crossScopeLevel ?? config.crossScopeLevel,
      resolvedOptions.view ?? resolvedOptions.contract?.view,
    );
  }

  function filterKnowledgeForContextQuery(
    knowledge: KnowledgeMemory[],
    options?: ContextQueryOptions,
  ): KnowledgeMemory[] {
    const resolvedOptions = resolveContextQueryOptions(options);
    const view = resolvedOptions.view ?? resolvedOptions.contract?.view;
    const visibleKnowledge = view
      ? resolveVisibleKnowledge(knowledge, config.scope, view)
      : knowledge;
    return filterKnowledgeByContextRequirements(visibleKnowledge, {
      knowledgeClasses: resolvedOptions.contract?.knowledgeClasses,
      minimumTrustScore: resolvedOptions.contract?.minimumTrustScore,
    });
  }

  async function collectKnowledgeForProfile(
    adapter: AsyncStorageAdapter,
    options?: ContextQueryOptions,
    asOf?: number,
  ): Promise<KnowledgeMemory[]> {
    const scopeLevel = resolveScopeLevelForContextQuery(options);
    const knowledge =
      scopeLevel && scopeLevel !== 'scope'
        ? await adapter.getActiveKnowledgeCrossScope(config.scope, scopeLevel)
        : await adapter.getActiveKnowledgeMemory(config.scope);
    const temporalKnowledge =
      asOf == null ? knowledge : knowledge.filter((item) => item.created_at <= asOf);
    return filterKnowledgeForContextQuery(temporalKnowledge, options);
  }

  function emitKnowledgeChange(
    action: 'learned' | 'promoted' | 'reverified' | 'demoted' | 'retired',
    knowledge: KnowledgeMemory,
  ): void {
    emitMemoryEvent('knowledge_change', knowledge, { logger: config.logger, onEvent }, 0, {
      action,
      knowledgeId: knowledge.id,
      fact: knowledge.fact,
      factType: knowledge.fact_type,
      knowledgeState: knowledge.knowledge_state,
      scope: {
        tenant_id: knowledge.tenant_id,
        system_id: knowledge.system_id,
        workspace_id: knowledge.workspace_id,
        collaboration_id: knowledge.collaboration_id,
        scope_id: knowledge.scope_id,
      },
    });
  }

  function emitDegradation(
    kind: 'summarizer' | 'extractor' | 'embeddings',
    detail: Record<string, unknown>,
  ): void {
    emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
      action: 'degraded_mode',
      subsystem: kind,
      ...detail,
    });
  }

  function emitRetrievalFallback(
    reason:
      | 'embedding_adapter_unavailable'
      | 'embedding_generator_unavailable'
      | 'query_vector_unavailable'
      | 'semantic_search_failed',
    detail: Record<string, unknown> = {},
  ): void {
    emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
      action: 'retrieval_fallback',
      reason,
      strategy: 'lexical_only',
      ...detail,
    });
  }

  async function withFailurePolicy<T>(
    kind: 'summarizer' | 'extractor',
    run: () => Promise<T>,
    fallback: () => T | Promise<T>,
  ): Promise<T> {
    const strategy =
      config.failurePolicy?.[kind] ??
      (kind === 'extractor' ? 'disable_auto_extract' : 'throw');

    try {
      return await circuitBreakers[kind].execute(run);
    } catch (error) {
      if (strategy === 'retry_once') {
        try {
          return await run();
        } catch (retryError) {
          config.logger?.error(`memory.${kind}.retry_failed`, {
            error: String(retryError),
          });
          throw retryError;
        }
      }

      config.logger?.error(`memory.${kind}.failed`, {
        error: String(error),
      });

      if (strategy === 'disable_auto_extract' && kind === 'extractor') {
        autoExtractEnabled = false;
        emitDegradation(kind, {
          strategy,
          error: String(error),
          autoExtractEnabled,
        });
        return fallback();
      }

      if (strategy === 'log_and_continue') {
        emitDegradation(kind, {
          strategy,
          error: String(error),
        });
        return fallback();
      }

      throw error;
    }
  }

  async function persistMonitorState(
    state: 'idle' | 'soft_triggered' | 'hard_triggered' | 'compacting',
    score: number,
    turns: Turn[],
    lastCompactionAt?: number | null,
  ): Promise<void> {
    await asyncAdapter.upsertContextMonitor({
      ...config.scope,
      compaction_state: state,
      active_turn_count: turns.length,
      active_token_estimate: turns.reduce((acc, turn) => acc + turn.token_estimate, 0),
      compaction_score: score,
      last_compaction_at: lastCompactionAt,
    });
  }

  async function buildQueryVector(input: string): Promise<Float32Array | undefined> {
    if (input.trim().length === 0) {
      return undefined;
    }
    if (!config.embeddingGenerator) {
      emitRetrievalFallback('embedding_generator_unavailable', {
        stage: 'query_vector',
      });
      return undefined;
    }
    try {
      const vectors = await circuitBreakers.embeddings.execute(() =>
        config.embeddingGenerator!([input]),
      );
      return vectors[0];
    } catch (error) {
      config.logger?.warn('memory.embeddings.query_vector_failed', {
        error: String(error),
      });
      emitDegradation('embeddings', {
        stage: 'query_vector',
        error: String(error),
      });
      emitRetrievalFallback('query_vector_unavailable', {
        stage: 'query_vector',
        error: String(error),
      });
      return undefined;
    }
  }

  const activeEmbeddingModel = config.embeddingModel ?? 'unknown';

  /**
   * Build the active-provider similarity filter (Phase 2.4, D2) from a query
   * vector: only stored embeddings with matching dimensions (and model, when
   * the active model is KNOWN) are compared. When the manager has no configured
   * embeddingModel (`activeEmbeddingModel === 'unknown'`) the model is OMITTED
   * so adapters filter by dimensions alone — passing model='unknown' as a strict
   * filter would wrongly exclude real-model vectors and kill semantic search.
   * Returns undefined when there is no vector to size.
   */
  function activeEmbeddingFilter(
    queryVector: Float32Array | undefined,
  ): EmbeddingQueryFilter | undefined {
    if (!queryVector) return undefined;
    return activeEmbeddingModel === 'unknown'
      ? { dimensions: queryVector.length }
      : { model: activeEmbeddingModel, dimensions: queryVector.length };
  }

  async function maybeEmbedKnowledge(knowledge: KnowledgeMemory[]): Promise<void> {
    if (!config.embeddingAdapter || !config.embeddingGenerator || knowledge.length === 0) {
      return;
    }
    try {
      const vectors = await circuitBreakers.embeddings.execute(() =>
        config.embeddingGenerator!(knowledge.map((item) => item.fact)),
      );
      for (const [index, item] of knowledge.entries()) {
        const vector = vectors[index];
        if (vector) {
          await config.embeddingAdapter!.storeEmbedding(item.id, vector, {
            model: activeEmbeddingModel,
            dimensions: vector.length,
          });
        }
      }
    } catch (error) {
      config.logger?.warn('memory.embeddings.index_failed', {
        error: String(error),
        knowledgeCount: knowledge.length,
      });
      emitDegradation('embeddings', {
        stage: 'index',
        error: String(error),
        knowledgeCount: knowledge.length,
      });
    }
  }

  function normalizeSemanticMatches(
    matches: Array<{ knowledgeMemoryId: number; similarity: number }>,
  ): Map<number, number> {
    if (matches.length === 0) {
      return new Map();
    }
    const maxSimilarity = Math.max(...matches.map((match) => match.similarity), 1);
    return new Map(
      matches.map((match) => [match.knowledgeMemoryId, match.similarity / maxSimilarity]),
    );
  }

  async function getHybridKnowledgeResults(
    query: string,
    options?: SearchOptions,
    level: ScopeLevel = config.crossScopeLevel ?? 'scope',
  ): Promise<SearchResult<KnowledgeMemory>[]> {
    const resolvedContextPolicy = {
      ...DEFAULT_CONTEXT_POLICY,
      ...config.contextPolicy,
    };
    const lexical =
      level === 'scope'
        ? await asyncAdapter.searchKnowledge(config.scope, query, options)
        : await asyncAdapter.searchKnowledgeCrossScope(config.scope, level, query, options);
    const filteredLexical = lexical.filter((result) => matchesKnowledgeSearchOptions(result.item, options));
    if (!config.embeddingAdapter) {
      emitRetrievalFallback('embedding_adapter_unavailable', {
        stage: 'semantic_search',
        scopeLevel: level,
      });
      return filteredLexical;
    }

    const queryVector = await buildQueryVector(query);
    if (!queryVector) {
      emitRetrievalFallback('query_vector_unavailable', {
        stage: 'semantic_search',
        scopeLevel: level,
      });
      return filteredLexical;
    }

    const embeddingFilter = activeEmbeddingFilter(queryVector);

    // Detect silently-degraded semantic search (Phase 2.4): if stored
    // embeddings exist for this scope but NONE match the active provider's
    // model/dimensions, similarity search will return nothing on merit —
    // surface a degraded-mode event so operators can see it and trigger reembed.
    if (embeddingFilter && level === 'scope' && config.embeddingAdapter.getEmbeddingCoverage) {
      try {
        const coverage = await config.embeddingAdapter.getEmbeddingCoverage(
          config.scope,
          embeddingFilter,
        );
        if (coverage.total > 0 && coverage.matching === 0) {
          emitDegradation('embeddings', {
            stage: 'semantic_search',
            reason: 'all_stored_embeddings_mismatch',
            activeModel: activeEmbeddingModel,
            activeDimensions: embeddingFilter.dimensions,
            storedTotal: coverage.total,
            storedMismatched: coverage.mismatched,
          });
          emitRetrievalFallback('semantic_search_failed', {
            stage: 'semantic_search',
            reason: 'all_stored_embeddings_mismatch',
            scopeLevel: level,
          });
        }
      } catch {
        // Coverage diagnostics are best-effort; never fail the query on them.
      }
    }

    let semantic: Array<{ knowledgeMemoryId: number; similarity: number }>;
    try {
      semantic =
        level === 'scope'
          ? await config.embeddingAdapter.findSimilar(config.scope, queryVector, {
              limit: options?.limit ?? 10,
              minSimilarity: resolvedContextPolicy.semanticMinSimilarity,
              filter: embeddingFilter,
            })
          : await config.embeddingAdapter.findSimilarCrossScope(config.scope, level, queryVector, {
              limit: options?.limit ?? 10,
              minSimilarity: resolvedContextPolicy.semanticMinSimilarity,
              filter: embeddingFilter,
            });
    } catch (error) {
      config.logger?.warn('memory.embeddings.semantic_search_failed', {
        error: String(error),
        scopeLevel: level,
      });
      emitDegradation('embeddings', {
        stage: 'semantic_search',
        error: String(error),
        scopeLevel: level,
      });
      emitRetrievalFallback('semantic_search_failed', {
        stage: 'semantic_search',
        error: String(error),
        scopeLevel: level,
      });
      return filteredLexical;
    }

    const lexicalRanks = new Map<number, number>();
    const semanticRanks = normalizeSemanticMatches(semantic);
    filteredLexical.forEach((result) => lexicalRanks.set(result.item.id, result.rank));

    const merged = new Map<number, SearchResult<KnowledgeMemory>>();
    for (const result of filteredLexical) {
      merged.set(result.item.id, result);
    }
    // Batch-fetch semantic-only hits to avoid N+1 individual lookups
    const semanticOnlyIds = semantic
      .filter((result) => !merged.has(result.knowledgeMemoryId))
      .map((result) => result.knowledgeMemoryId);
    const fetchedKnowledgeMap = new Map<number, KnowledgeMemory>();
    if (semanticOnlyIds.length > 0) {
      const fetched = await Promise.all(
        semanticOnlyIds.map((id) => asyncAdapter.getKnowledgeMemoryById(id)),
      );
      for (const km of fetched) {
        // F4/P6 defensive gate: semantic-only hits are hydrated via the UNSCOPED
        // getKnowledgeMemoryById, which bypasses the cross-scope visibility WHERE
        // clause the adapters apply in findSimilarCrossScope. Re-apply the base
        // visibility predicate here so a private fact from another scope can never
        // surface through the semantic dimension even if the embedding index leaks
        // its id. Same-scope hits pass trivially (item scope === query scope).
        if (km && isBaseVisible(km.visibility_class, km, config.scope)) {
          fetchedKnowledgeMap.set(km.id, km);
        }
      }
    }

    for (const result of semantic) {
      const knowledge = merged.has(result.knowledgeMemoryId)
        ? merged.get(result.knowledgeMemoryId)!.item
        : fetchedKnowledgeMap.get(result.knowledgeMemoryId) ?? null;
      if (!knowledge) continue;
      if (!matchesKnowledgeSearchOptions(knowledge, options)) continue;
      const existing = merged.get(knowledge.id);
      const recencyScore =
        knowledge.last_accessed_at > 0
          ? 1 / (1 + Math.max(0, Math.floor(Date.now() / 1000) - knowledge.last_accessed_at) / 86400)
          : 0;
      const ranking = rankKnowledge({
        knowledge,
        lexicalScore: lexicalRanks.get(knowledge.id) ?? 0,
        semanticScore: semanticRanks.get(knowledge.id) ?? 0,
        recencyScore,
        importanceScore: Math.min(1, knowledge.access_count / 10),
        policy: resolvedContextPolicy,
        scope: config.scope,
        relevanceTexts: [query],
        preferLocalTrusted: options?.preferLocalTrusted ?? true,
        preferLineageMemory: options?.preferLineageMemory ?? level !== 'scope',
      });
      merged.set(knowledge.id, {
        item: knowledge,
        rank: existing ? Math.max(existing.rank, ranking.finalScore) : ranking.finalScore,
      });
    }

    const results = [...merged.values()]
      .sort((a, b) => b.rank - a.rank || b.item.last_accessed_at - a.item.last_accessed_at)
      .slice(0, options?.limit ?? 10);

    if (config.contextPolicy?.touchSelectedKnowledge ?? true) {
      await asyncAdapter.touchKnowledgeMemories(results.map((result) => result.item.id));
    }

    return results;
  }

  async function getContextInternal(
    relevanceQuery?: string,
    asOf?: number,
    options?: ContextQueryOptions,
  ): Promise<MemoryContext> {
    await ensureGovernanceLoaded();
    const resolvedOptions = resolveContextQueryOptions(options);
    const activeTurns = await asyncAdapter.getActiveTurns(config.scope, config.sessionId);
    const relevantTurns = asOf == null
      ? activeTurns
      : activeTurns.filter((turn) => turn.created_at <= asOf);
    const queryVector = await buildQueryVector(
      relevanceQuery ??
        relevantTurns
          .slice(-4)
          .map((turn) => turn.content)
          .join('\n'),
    );

    return buildMemoryContext(asyncAdapter, config.scope, {
      sessionId: config.sessionId,
      relevanceQuery,
      queryVector,
      embeddingAdapter: config.embeddingAdapter,
      embeddingFilter: activeEmbeddingFilter(queryVector),
      crossScopeLevel: resolvedOptions.contract?.crossScopeLevel ?? config.crossScopeLevel,
      policy: config.contextPolicy,
      contract: resolvedOptions.contract,
      invariants: resolvedOptions.invariants,
      tokenEstimator,
      asOf,
      view: resolvedOptions.view,
      viewer: resolvedOptions.viewer,
      includeCoordinationState: resolvedOptions.includeCoordinationState,
      logger: config.logger,
      onEvent,
    });
  }

  async function refreshSessionStateProjection(): Promise<void> {
    try {
      const [activeTurns, workingMemoryCandidates, contextWorkItems, watermark] =
        await Promise.all([
          asyncAdapter.getActiveTurns(config.scope, config.sessionId),
          asyncAdapter.getActiveWorkingMemory(config.scope, config.sessionId),
          // Session-state projection stays scope-local even when wider
          // retrieval is configured; it is a fast resume artifact, not a full
          // cross-scope context assembly.
          getContextWorkItems(asyncAdapter, config.scope, undefined, 'scope'),
          asyncAdapter.getTemporalWatermark('temporal'),
        ]);
      const shortTermState = buildDerivedShortTermState({
        activeTurns,
        workingMemoryCandidates,
        contextWorkItems,
        maxRecentSummaries:
          config.contextPolicy?.maxRecentSummaries ??
          DEFAULT_CONTEXT_POLICY.maxRecentSummaries,
      });
      await asyncAdapter.upsertSessionState({
        ...normalizeScope(config.scope),
        session_id: config.sessionId,
        ...shortTermState.sessionState,
        source_event_id: watermark?.last_event_id ?? null,
      });
    } catch (error) {
      config.logger?.warn?.('memory.session_state_projection_refresh_failed', {
        error: String(error),
        sessionId: config.sessionId,
      });
      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'session_state_projection_refresh_failed',
        sessionId: config.sessionId,
        error: String(error),
      });
    }
  }

  async function collectBestEffortTemporalState(
    asOf: number,
    options?: ContextQueryOptions,
  ): Promise<{
    turns: Turn[];
    workingMemory: WorkingMemory[];
    knowledge: KnowledgeMemory[];
    workItems: WorkItem[];
    workClaims: WorkClaim[];
    handoffs: HandoffRecord[];
    associations: Association[];
    playbooks: Playbook[];
  }> {
    const resolvedOptions = resolveContextQueryOptions(options);
    const view = resolvedOptions.view ?? resolvedOptions.contract?.view;
    const effectiveScopeLevel = resolveContextScopeLevel(
      resolvedOptions.contract?.crossScopeLevel ?? config.crossScopeLevel,
      view,
    );
    const [
      turns,
      workingMemory,
      knowledge,
      contextWorkItems,
      playbooks,
      associations,
      rawWorkClaims,
      rawHandoffs,
    ] = await Promise.all([
      asyncAdapter.getTurnsByTimeRange(config.scope, { end_at: asOf }),
      asyncAdapter.getWorkingMemoryByTimeRange(config.scope, { end_at: asOf }),
      effectiveScopeLevel && effectiveScopeLevel !== 'scope'
        ? asyncAdapter.getActiveKnowledgeCrossScope(config.scope, effectiveScopeLevel)
        : asyncAdapter.getActiveKnowledgeMemory(config.scope),
      getContextWorkItems(asyncAdapter, config.scope, asOf, effectiveScopeLevel),
      effectiveScopeLevel && effectiveScopeLevel !== 'scope'
        ? asyncAdapter.getActivePlaybooksCrossScope(config.scope, effectiveScopeLevel)
        : asyncAdapter.getActivePlaybooks(config.scope),
      asyncAdapter.listAssociations(config.scope),
      effectiveScopeLevel && effectiveScopeLevel !== 'scope'
        ? asyncAdapter.listWorkClaimsCrossScope(config.scope, effectiveScopeLevel, {
            includeExpired: true,
            includeReleased: true,
          })
        : asyncAdapter.listWorkClaims(config.scope, {
            includeExpired: true,
            includeReleased: true,
          }),
      effectiveScopeLevel && effectiveScopeLevel !== 'scope'
        ? asyncAdapter.listHandoffsCrossScope(config.scope, effectiveScopeLevel)
        : asyncAdapter.listHandoffs(config.scope),
    ]);

    const visibleKnowledge = (
      view
        ? resolveVisibleKnowledge(
            knowledge.filter((item) => item.created_at <= asOf),
            config.scope,
            view,
          )
        : knowledge.filter((item) => item.created_at <= asOf)
    );
    const filteredKnowledge = filterKnowledgeByContextRequirements(visibleKnowledge, {
      knowledgeClasses: resolvedOptions.contract?.knowledgeClasses,
      minimumTrustScore: resolvedOptions.contract?.minimumTrustScore,
    }).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    const visibleWorkItems = (
      view ? resolveVisibleWorkItems(contextWorkItems, config.scope, view) : contextWorkItems
    ).sort((a, b) => a.updated_at - b.updated_at || a.created_at - b.created_at || a.id - b.id);
    const visiblePlaybooks = (
      view
        ? resolveVisiblePlaybooks(
            playbooks.filter((item) => item.created_at <= asOf),
            config.scope,
            view,
          )
        : playbooks.filter((item) => item.created_at <= asOf)
    ).sort((a, b) => a.updated_at - b.updated_at || a.created_at - b.created_at || a.id - b.id);
    const visibleWorkClaims = (
      view
        ? resolveVisibleWorkClaims(
            rawWorkClaims.map((claim) => normalizeWorkClaimAt(claim, asOf)),
            config.scope,
            view,
          )
        : rawWorkClaims.map((claim) => normalizeWorkClaimAt(claim, asOf))
    ).sort((a, b) => a.claimed_at - b.claimed_at || a.id - b.id);
    const visibleHandoffs = (
      view
        ? resolveVisibleHandoffs(
            rawHandoffs.map((handoff) => normalizeHandoffAt(handoff, asOf)),
            config.scope,
            view,
          )
        : rawHandoffs.map((handoff) => normalizeHandoffAt(handoff, asOf))
    ).sort((a, b) => a.created_at - b.created_at || a.id - b.id);

    return {
      turns: turns
        .filter((turn) => turn.session_id === config.sessionId)
        .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
      workingMemory: workingMemory
        .filter((item) => item.session_id === config.sessionId)
        .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
      knowledge: filteredKnowledge,
      workItems: visibleWorkItems,
      workClaims: visibleWorkClaims,
      handoffs: visibleHandoffs,
      associations: filterAssociationsForContextState(
        associations
          .filter((association) => association.created_at <= asOf)
          .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
        options,
        {
          knowledge: filteredKnowledge,
          workItems: visibleWorkItems,
          workingMemory: workingMemory
            .filter((item) => item.session_id === config.sessionId)
            .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
          playbooks: visiblePlaybooks,
        },
      ),
      playbooks: visiblePlaybooks,
    };
  }

  function filterAssociationsForContextState(
    associations: Association[],
    options: ContextQueryOptions | undefined,
    state: {
      knowledge: KnowledgeMemory[];
      workItems: WorkItem[];
      workingMemory: WorkingMemory[];
      playbooks: Playbook[];
    },
  ): Association[] {
    const resolvedOptions = resolveContextQueryOptions(options);
    const visibleAssociations = resolvedOptions.view
      ? resolveVisibleAssociations(associations, config.scope, resolvedOptions.view)
      : associations;
    const visibleKnowledgeIds = new Set(state.knowledge.map((item) => item.id));
    const visibleWorkItemIds = new Set(state.workItems.map((item) => item.id));
    const visibleWorkingMemoryIds = new Set(state.workingMemory.map((item) => item.id));
    const visiblePlaybookIds = new Set(state.playbooks.map((item) => item.id));
    const isVisibleEndpoint = (kind: AssociationTargetKind, id: number): boolean => {
      if (kind === 'knowledge') return visibleKnowledgeIds.has(id);
      if (kind === 'work_item') return visibleWorkItemIds.has(id);
      if (kind === 'working_memory') return visibleWorkingMemoryIds.has(id);
      if (kind === 'playbook') return visiblePlaybookIds.has(id);
      return false;
    };
    return visibleAssociations.filter(
      (association) =>
        isVisibleEndpoint(association.source_kind, association.source_id) &&
        isVisibleEndpoint(association.target_kind, association.target_id),
    );
  }

  function filterTemporalStateForContext(
    state: {
      turns: Turn[];
      workingMemory: WorkingMemory[];
      knowledge: KnowledgeMemory[];
      workItems: WorkItem[];
      workClaims: WorkClaim[];
      handoffs: HandoffRecord[];
      associations: Association[];
      playbooks: Playbook[];
    },
    options?: ContextQueryOptions,
  ) {
    const resolvedOptions = resolveContextQueryOptions(options);
    const view = resolvedOptions.view ?? resolvedOptions.contract?.view;
    const turns = state.turns
      .slice()
      .filter((turn) => turn.session_id === config.sessionId)
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    const workingMemory = state.workingMemory
      .slice()
      .filter((item) => item.session_id === config.sessionId)
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    const knowledge = filterKnowledgeForContextQuery(state.knowledge, options)
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    const workItems = (
      view ? resolveVisibleWorkItems(state.workItems, config.scope, view) : [...state.workItems]
    ).sort((a, b) => a.updated_at - b.updated_at || a.created_at - b.created_at || a.id - b.id);
    const playbooks = (
      view ? resolveVisiblePlaybooks(state.playbooks, config.scope, view) : [...state.playbooks]
    ).sort((a, b) => a.updated_at - b.updated_at || a.created_at - b.created_at || a.id - b.id);
    const workClaims = (
      view ? resolveVisibleWorkClaims(state.workClaims, config.scope, view) : [...state.workClaims]
    ).sort((a, b) => a.claimed_at - b.claimed_at || a.id - b.id);
    const handoffs = (
      view ? resolveVisibleHandoffs(state.handoffs, config.scope, view) : [...state.handoffs]
    ).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    const associations = filterAssociationsForContextState(
      [...state.associations].sort((a, b) => a.created_at - b.created_at || a.id - b.id),
      options,
      { knowledge, workItems, workingMemory, playbooks },
    );
    return {
      turns,
      workingMemory,
      knowledge,
      workItems,
      workClaims,
      handoffs,
      associations,
      playbooks,
    };
  }

  async function getTemporalCutoverAt(): Promise<number | null> {
    const watermark = await asyncAdapter.getTemporalWatermark('temporal');
    return watermark?.cutover_at ?? null;
  }

  async function resolveChangeStreamCursorInternal(
    cursor?: TemporalIdInput,
  ): Promise<TemporalId> {
    if (cursor != null) return normalizeTemporalId(cursor);
    return (await asyncAdapter.getTemporalWatermark('temporal'))?.last_event_id ?? '0';
  }

  function isKnowledgeChangeEvent(event: MemoryEventRecord): boolean {
    return (
      event.entity_kind === 'knowledge_memory' &&
      event.event_type !== 'knowledge.touched'
    );
  }

  function normalizeKnowledgeChangeSnapshot(knowledge: KnowledgeMemory): KnowledgeMemory {
    return {
      ...knowledge,
      ...normalizeScope(knowledge),
      source_collaboration_id: knowledge.source_collaboration_id,
    };
  }

  async function materializeKnowledgeChanges(
    events: MemoryEventRecord[],
  ): Promise<KnowledgeChangeRecord[]> {
    const changes: KnowledgeChangeRecord[] = [];
    for (const event of events) {
      if (!isKnowledgeChangeEvent(event)) continue;
      const after =
        event.payload.after &&
        typeof event.payload.after === 'object' &&
        !Array.isArray(event.payload.after)
          ? (event.payload.after as KnowledgeMemory)
          : null;
      const knowledge =
        after ??
        (Number.isInteger(Number(event.entity_id))
          ? await asyncAdapter.getKnowledgeMemoryById(Number(event.entity_id))
          : null);
      if (!knowledge) continue;
      changes.push({
        event_id: event.event_id,
        event_type: event.event_type,
        created_at: event.created_at,
        knowledge: normalizeKnowledgeChangeSnapshot(knowledge),
      });
    }
    return changes;
  }

  async function listKnowledgeChangesInternal(options?: {
    cursor?: TemporalIdInput;
    since?: Date;
    scopeLevel?: ScopeLevel;
    limit?: number;
  }): Promise<KnowledgeChangeResult> {
    const scopeLevel = options?.scopeLevel ?? config.crossScopeLevel ?? 'scope';
    const limit = options?.limit ?? 100;
    const since = options?.since ? Math.floor(options.since.valueOf() / 1000) : undefined;
    const explicitCursor = options?.cursor != null ? normalizeTemporalId(options.cursor) : null;

    if (explicitCursor == null && since == null) {
      return {
        changes: [],
        nextCursor: await resolveChangeStreamCursorInternal(),
      };
    }

    let cursor = explicitCursor;
    const changes: KnowledgeChangeRecord[] = [];

    for (;;) {
      const timeline =
        scopeLevel === 'scope'
          ? await asyncAdapter.listMemoryEvents(config.scope, {
              cursor: cursor ?? undefined,
              entityKind: 'knowledge_memory',
              startAt: since,
              limit,
            })
          : await asyncAdapter.listMemoryEventsCrossScope(config.scope, scopeLevel, {
              cursor: cursor ?? undefined,
              entityKind: 'knowledge_memory',
              startAt: since,
              limit,
            });

      const timelineCursor =
        timeline.events[timeline.events.length - 1]?.event_id ??
        timeline.nextCursor ??
        cursor ??
        (since != null ? await resolveChangeStreamCursorInternal() : '0');

      changes.push(...(await materializeKnowledgeChanges(timeline.events)));

      if (explicitCursor != null || timeline.nextCursor == null) {
        return {
          changes,
          nextCursor: timelineCursor,
        };
      }

      if (cursor != null && compareTemporalIds(timeline.nextCursor, cursor) <= 0) {
        throw new ValidationError('Memory validation: change cursor did not advance');
      }

      cursor = timeline.nextCursor;
    }
  }

  async function buildReplayedContext(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
    replayCutoff?: {
      throughEventId?: TemporalId | null;
    },
  ): Promise<{
    context: MemoryContext;
    events: MemoryEventRecord[];
    state: ReturnType<typeof normalizeReplayedTemporalState> | null;
    watermarkEventId: TemporalId | null;
    exact: boolean;
    cutoverAt: number | null;
  }> {
    const cutoverAt = await getTemporalCutoverAt();
    await ensureGovernanceLoaded();
    if (cutoverAt == null || asOf < cutoverAt) {
      return {
        // Pre-cutover replay is best-effort only. The historical filters still
        // apply, but semantic retrieval may consult the live embedding index
        // because that index has no temporal dimension before the cutover.
        context: await getContextInternal(relevanceQuery, asOf, options),
        events: [],
        state: null,
        watermarkEventId: null,
        exact: false,
        cutoverAt,
      };
    }

    const resolvedOptions = resolveContextQueryOptions(options);
    const replayScopeLevel = resolveContextScopeLevel(
      resolvedOptions.contract?.crossScopeLevel ?? config.crossScopeLevel,
      resolvedOptions.view ?? resolvedOptions.contract?.view,
    );
    const events =
      replayScopeLevel != null && replayScopeLevel !== 'scope'
        ? await listAllMemoryEventsCrossScope(asyncAdapter, config.scope, replayScopeLevel, {
            endAt: asOf,
            limit: 500,
          })
        : await listAllMemoryEvents(asyncAdapter, config.scope, {
            endAt: asOf,
            limit: 500,
          });
    const filteredEvents =
      replayCutoff?.throughEventId != null
        ? events.filter(
            (event) => compareTemporalIds(event.event_id, replayCutoff.throughEventId!) <= 0,
          )
        : events;
    const replayed = normalizeReplayedTemporalState(
      foldTemporalState(filteredEvents, { sessionId: config.sessionId }),
      asOf,
    );
    const replayAdapter = createTemporalReplayAdapter(replayed, asOf);
    const inferredRelevanceQuery = replayed.turns
      .slice(-4)
      .map((turn) => turn.content)
      .join('\n')
      .trim();
    const resolvedRelevanceQuery = relevanceQuery ?? (inferredRelevanceQuery || undefined);
    // Exact replay stays on the replay adapter only, so no live semantic data
    // can leak into the assembled historical context after temporal cutover.
    const context = await buildMemoryContext(replayAdapter, config.scope, {
      sessionId: config.sessionId,
      relevanceQuery: resolvedRelevanceQuery,
      crossScopeLevel: resolvedOptions.contract?.crossScopeLevel ?? config.crossScopeLevel,
      policy: config.contextPolicy,
      contract: resolvedOptions.contract,
      invariants: resolvedOptions.invariants,
      tokenEstimator,
      view: resolvedOptions.view,
      viewer: resolvedOptions.viewer,
      includeCoordinationState: resolvedOptions.includeCoordinationState,
      logger: config.logger,
      onEvent,
    });
    return {
      context,
      events: filteredEvents,
      state: replayed,
      watermarkEventId: replayCutoff?.throughEventId ?? replayed.watermarkEventId,
      exact: true,
      cutoverAt,
    };
  }

  function buildSessionBootstrapPayload(
    context: MemoryContext,
    profile: Profile,
  ): SessionBootstrap {
    return {
      currentObjective: context.currentObjective,
      sessionState: context.sessionState,
      workingMemory: context.workingMemory,
      relevantKnowledge: context.relevantKnowledge,
      recentSummaries: context.recentSummaries,
      activeObjectives: context.activeObjectives,
      unresolvedWork: context.unresolvedWork,
      coordinationState: context.coordinationState,
      invariants: context.invariants,
      warnings: context.warnings,
      degradedContext: context.degradedContext,
      profile,
    };
  }

  async function executeCompaction(
    turns: Turn[],
    trigger: 'soft' | 'hard' | 'manual' | 'session_gap',
    retainedTurnCount: number,
    score: number,
  ): Promise<CompactionResult | null> {
    await persistMonitorState('compacting', score, turns);

    const result = await withFailurePolicy(
      'summarizer',
      () =>
        compactTurns(
          asyncAdapter,
          config.scope,
          config.sessionId,
          turns,
          config.summarizer,
          trigger,
          retainedTurnCount,
          { logger: config.logger, onEvent },
        ),
      () => null,
    );

    if (!result) {
      await persistMonitorState('idle', score, turns);
      emitDegradation('summarizer', {
        stage: 'compaction',
        strategy: config.failurePolicy?.summarizer ?? 'throw',
      });
      return null;
    }

    const remainingTurns = await asyncAdapter.getActiveTurns(config.scope, config.sessionId);
    await persistMonitorState(
      'idle',
      score,
      remainingTurns,
      Math.floor(Date.now() / 1000),
    );
    deferredSoftCompaction = false;

    if (config.extractor && autoExtractEnabled) {
      const extracted = await withFailurePolicy(
        'extractor',
        () =>
          extractKnowledge(
            asyncAdapter,
            result.workingMemory.id,
            config.scope,
            config.extractor!,
            {
              logger: config.logger,
              onEvent,
              policy: config.extractionPolicy,
              aliasMap: config.aliasMap,
            },
          ),
        () => [] as KnowledgeMemory[],
      );
      await maybeEmbedKnowledge(extracted);
        extracted.forEach((knowledge) => emitKnowledgeChange('promoted', knowledge));
    }

    await refreshSessionStateProjection();

    return result;
  }

  async function runCompaction(turns: Turn[]): Promise<CompactionResult | null> {
    const latestWorkingMemory = await asyncAdapter.getLatestWorkingMemory(
      config.scope,
      config.sessionId,
    );
    const report = assessContext(
      {
        scope: config.scope,
        session_id: config.sessionId,
        active_turns: turns,
        latest_working_memory: latestWorkingMemory,
      },
      config.monitorPolicy,
    );

    const longGapDetected = report.topic_drift_signals.some(
      (signal) => signal.type === 'long_intra_session_gap' && signal.detected,
    );
    if (longGapDetected && turns.length > 1) {
      return executeCompaction(
        turns,
        'session_gap',
        Math.max(
          1,
          Math.min(
            config.monitorPolicy?.softRetainTurns ?? DEFAULT_MONITOR_POLICY.softRetainTurns,
            turns.length - 1,
          ),
        ),
        report.score_breakdown.total,
      );
    }

    if (report.recommendation.action === 'none') {
      await persistMonitorState('idle', report.score_breakdown.total, turns);
      deferredSoftCompaction = false;
      return null;
    }

    if (report.recommendation.action === 'soft' && report.recommendation.defer_to_idle) {
      await persistMonitorState('soft_triggered', report.score_breakdown.total, turns);
      deferredSoftCompaction = true;
      return null;
    }

    return executeCompaction(
      turns,
      report.recommendation.action,
      Math.max(0, Math.min(report.recommendation.post_compaction_target_turns, turns.length - 1)),
      report.score_breakdown.total,
    );
  }

  async function insertManagedTurnRecord(
    role: TurnRole,
    content: string,
    actor: string,
  ): Promise<Turn> {
    const redactedContent = config.redactText ? config.redactText({ kind: 'turn', text: content }) : content;
    return asyncAdapter.insertTurn({
      ...config.scope,
      session_id: config.sessionId,
      actor,
      role,
      content: redactedContent,
      token_estimate: tokenEstimator(redactedContent),
    });
  }

  async function insertManagedTurn(role: TurnRole, content: string, actor: string): Promise<Turn> {
    const turn = await insertManagedTurnRecord(role, content, actor);
    emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
      action: 'process_turn',
      role,
      turnId: turn.id,
    });

    return turn;
  }

  return {
    async processTurn(role, content, actor = role === 'assistant' ? 'assistant' : 'user') {
      const turn = await insertManagedTurn(role, content, actor);

      if (autoCompact) {
        const activeTurns = await asyncAdapter.getActiveTurns(config.scope, config.sessionId);
        await runCompaction(activeTurns);
      }

      await refreshSessionStateProjection();

      return turn;
    },

    async processExchange(userContent, assistantContent, actors) {
      const [userTurn, assistantTurn] = await asyncAdapter.transaction(async () => {
        const createdUserTurn = await insertManagedTurnRecord(
          'user',
          userContent,
          actors?.user ?? 'user',
        );
        const createdAssistantTurn = await insertManagedTurnRecord(
          'assistant',
          assistantContent,
          actors?.assistant ?? 'assistant',
        );
        return [createdUserTurn, createdAssistantTurn] as const;
      });
      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'process_turn',
        role: 'user',
        turnId: userTurn.id,
      });
      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'process_turn',
        role: 'assistant',
        turnId: assistantTurn.id,
      });
      const compactionResult = autoCompact
        ? await runCompaction(await asyncAdapter.getActiveTurns(config.scope, config.sessionId))
        : null;
      await refreshSessionStateProjection();
      return {
        userTurn,
        assistantTurn,
        compactionResult,
      };
    },

    async getContext(relevanceQuery, options) {
      return getContextInternal(relevanceQuery, undefined, options);
    },

    async getContextAt(asOf, relevanceQuery, options) {
      return (await buildReplayedContext(asOf, relevanceQuery, options)).context;
    },

    async requestContextExpansion(request, options) {
      await ensureGovernanceLoaded();
      const currentContract = resolveContextContractReference(options?.currentContract);
      return buildContextExpansionResolution(request, currentContract);
    },

    async getContextGovernance() {
      await ensureGovernanceLoaded();
      return getGovernanceSnapshot();
    },

    async setDefaultContextContract(contract) {
      await ensureGovernanceLoaded();
      defaultContextContract = cloneContextContract(contract);
      await asyncAdapter.upsertDefaultContextContract?.(config.scope, contract);
      return cloneContextContract(defaultContextContract);
    },

    async putContextContract(name, contract) {
      await ensureGovernanceLoaded();
      if (!name.trim()) {
        throw new ValidationError('Context contract name is required');
      }
      const stored = cloneContextContract({
        ...contract,
        name: contract.name ?? name,
      })!;
      namedContextContracts.set(name, stored);
      await asyncAdapter.upsertNamedContextContract?.(config.scope, name, stored);
      return cloneContextContract(stored)!;
    },

    async deleteContextContract(name) {
      await ensureGovernanceLoaded();
      const deleted = namedContextContracts.delete(name);
      if (deleted) {
        await asyncAdapter.deleteNamedContextContract?.(config.scope, name);
      }
      return deleted;
    },

    async putContextInvariant(invariant) {
      await ensureGovernanceLoaded();
      if (!invariant.id.trim()) {
        throw new ValidationError('Context invariant id is required');
      }
      contextInvariants.set(invariant.id, cloneContextInvariant(invariant));
      await asyncAdapter.upsertContextInvariant?.(config.scope, invariant);
      return cloneContextInvariant(contextInvariants.get(invariant.id)!);
    },

    async deleteContextInvariant(id) {
      await ensureGovernanceLoaded();
      const deleted = contextInvariants.delete(id);
      if (deleted) {
        await asyncAdapter.deleteContextInvariant?.(config.scope, id);
      }
      return deleted;
    },

    async getContextEscalationPolicy() {
      await ensureGovernanceLoaded();
      return cloneContextEscalationPolicy(escalationPolicy);
    },

    async setContextEscalationPolicy(policy) {
      await ensureGovernanceLoaded();
      escalationPolicy = normalizeContextEscalationPolicy(policy);
      await asyncAdapter.upsertContextEscalationPolicy?.(config.scope, policy);
      return cloneContextEscalationPolicy(escalationPolicy);
    },

    async getStateAt(asOf, options) {
      const replay = await buildReplayedContext(asOf, options?.relevanceQuery, options);
      const replayed = replay.exact
        ? filterTemporalStateForContext(replay.state!, options)
        : await collectBestEffortTemporalState(asOf, options);
      return {
        asOf,
        exact: replay.exact,
        cutoverAt: replay.cutoverAt,
        watermarkEventId: replay.watermarkEventId,
        context: replay.context,
        sessionState: replay.context.sessionState,
        turns: replayed.turns,
        workingMemory: replayed.workingMemory,
        knowledge: replayed.knowledge,
        workItems: replayed.workItems,
        workClaims: replayed.workClaims,
        handoffs: replayed.handoffs,
        coordinationState: replay.context.coordinationState,
        associations: replayed.associations,
        playbooks: replayed.playbooks,
      };
    },

    async getTimeline(options) {
      return asyncAdapter.listMemoryEvents(config.scope, {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: options?.startAt,
        endAt: options?.endAt,
        limit: options?.limit,
        cursor: options?.cursor,
      });
    },

    async diffState(from, to, options) {
      const cutoverAt = await getTemporalCutoverAt();
      const eventQuery = {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: from + 1,
        endAt: to,
        limit: 500,
      };
      const events =
        options?.maxEvents != null
          ? await listAllMemoryEventsBounded(asyncAdapter, config.scope, options.maxEvents, eventQuery)
          : await listAllMemoryEvents(asyncAdapter, config.scope, eventQuery);
      const byEntityKind: Partial<Record<MemoryEventEntityKind, number>> = {};
      const byEventType: Partial<Record<MemoryEventRecord['event_type'], number>> = {};
      for (const event of events) {
        byEntityKind[event.entity_kind] = (byEntityKind[event.entity_kind] ?? 0) + 1;
        byEventType[event.event_type] = (byEventType[event.event_type] ?? 0) + 1;
      }
      return {
        from,
        to,
        exact: cutoverAt != null && from >= cutoverAt && to >= cutoverAt,
        cutoverAt,
        watermarkRange: {
          fromEventId: events[0]?.event_id ?? null,
          toEventId: events[events.length - 1]?.event_id ?? null,
        },
        events,
        summary: {
          totalEvents: events.length,
          byEntityKind,
          byEventType,
        },
      };
    },

    async listMemoryEvents(options) {
      const timeline = await asyncAdapter.listMemoryEvents(config.scope, {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: options?.startAt,
        endAt: options?.endAt,
        limit: options?.limit,
        cursor: options?.cursor,
      });
      return {
        events: [...timeline.events].reverse(),
        nextCursor: timeline.nextCursor,
      };
    },

    async getSessionBootstrap(relevanceQuery, options) {
      const context = await getContextInternal(relevanceQuery, undefined, options);
      const profile = buildProfileFromKnowledge(
        await collectKnowledgeForProfile(asyncAdapter, options),
      );
      return buildSessionBootstrapPayload(context, profile);
    },

    async getSessionBootstrapAt(asOf, relevanceQuery, options) {
      const replay = await buildReplayedContext(asOf, relevanceQuery, options);
      const profile =
        replay.exact && replay.state
          ? buildProfileFromKnowledge(
              await collectKnowledgeForProfile(
                createTemporalReplayAdapter(replay.state, asOf),
                options,
                asOf,
              ),
            )
          : buildProfileFromKnowledge(await collectKnowledgeForProfile(asyncAdapter, options, asOf));
      return buildSessionBootstrapPayload(replay.context, profile);
    },

    async captureSnapshot(relevanceQuery, options) {
      const frozenAt = Math.floor(Date.now() / 1000);
      const watermark = await asyncAdapter.getTemporalWatermark('temporal');
      if (!watermark || watermark.last_event_id === '0') {
        const [context, profile] = await Promise.all([
          getContextInternal(relevanceQuery, undefined, options),
          collectKnowledgeForProfile(asyncAdapter, options).then((knowledge) =>
            buildProfileFromKnowledge(knowledge),
          ),
        ]);
        return {
          bootstrap: buildSessionBootstrapPayload(context, profile),
          context,
          frozenAt,
          watermarkEventId: null,
          profile,
        };
      }

      const replay = await buildReplayedContext(
        watermark.updated_at,
        relevanceQuery,
        options,
        {
          throughEventId: watermark.last_event_id,
        },
      );
      const profile =
        replay.exact && replay.state
          ? buildProfileFromKnowledge(
              await collectKnowledgeForProfile(
                createTemporalReplayAdapter(replay.state, watermark.updated_at),
                options,
                watermark.updated_at,
              ),
            )
          : buildProfileFromKnowledge(
              await collectKnowledgeForProfile(asyncAdapter, options, watermark.updated_at),
            );
      return {
        bootstrap: buildSessionBootstrapPayload(replay.context, profile),
        context: replay.context,
        frozenAt,
        watermarkEventId: replay.exact ? watermark.last_event_id : null,
        profile,
      };
    },

    async getRuntimeDiagnostics() {
      return {
        circuitBreakers: {
          summarizer: circuitBreakers.summarizer.getSnapshot(),
          extractor: circuitBreakers.extractor.getSnapshot(),
          embeddings: circuitBreakers.embeddings.getSnapshot(),
        },
      };
    },

    async recall(timeRange) {
      return {
        turns: await asyncAdapter.getTurnsByTimeRange(config.scope, timeRange),
        workingMemory: await asyncAdapter.getWorkingMemoryByTimeRange(config.scope, timeRange),
        knowledge: await asyncAdapter.getKnowledgeByTimeRange(config.scope, timeRange),
        workItems: await asyncAdapter.getWorkItemsByTimeRange(config.scope, timeRange),
      };
    },

    async search(query, options) {
      const results = {
        turns: await asyncAdapter.searchTurns(config.scope, query, options),
        knowledge: await getHybridKnowledgeResults(query, options, config.crossScopeLevel ?? 'scope'),
      };
      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'search',
        query,
        turnResultCount: results.turns.length,
        knowledgeResultCount: results.knowledge.length,
      });
      return results;
    },

    async searchCrossScope(query, level, options) {
      return {
        knowledge: await getHybridKnowledgeResults(query, options, level),
      };
    },

    async listKnowledgeChanges(options) {
      return listKnowledgeChangesInternal(options);
    },

    async pollForChanges(since, options) {
      const result = await listKnowledgeChangesInternal({
        since,
        scopeLevel: options?.scopeLevel,
        limit: 500,
      });
      const latestByKnowledgeId = new Map<number, KnowledgeMemory>();
      for (const change of result.changes) {
        latestByKnowledgeId.delete(change.knowledge.id);
        latestByKnowledgeId.set(change.knowledge.id, change.knowledge);
      }
      return [...latestByKnowledgeId.values()];
    },

    async forceCompact() {
      if (deferredSoftCompaction) {
        config.logger?.info('memory.compaction.flushing_deferred');
      }
      const turns = await asyncAdapter.getActiveTurns(config.scope, config.sessionId);
      const latestWorkingMemory = await asyncAdapter.getLatestWorkingMemory(
        config.scope,
        config.sessionId,
      );
      const report = assessContext(
        {
          scope: config.scope,
          session_id: config.sessionId,
          active_turns: turns,
          latest_working_memory: latestWorkingMemory,
        },
        config.monitorPolicy,
      );
      if (report.recommendation.action === 'none') {
        return null;
      }
      return executeCompaction(
        turns,
        'manual',
        Math.max(0, Math.min(report.recommendation.post_compaction_target_turns, turns.length - 1)),
        report.score_breakdown.total,
      );
    },

    async learnFact(fact, factType, confidence = 'high', rationale) {
      const knowledge = await asyncAdapter.insertKnowledgeMemory({
        ...config.scope,
        fact: config.redactText ? config.redactText({ kind: 'fact', text: fact }) : fact,
        fact_type: factType,
        knowledge_class: manualKnowledgeClassForFactType(factType),
        source: 'manual',
        confidence,
        rationale: rationale ?? null,
      });
      await maybeEmbedKnowledge([knowledge]);
      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'learn_fact',
        knowledgeMemoryId: knowledge.id,
        factType,
      });
      emitKnowledgeChange('learned', knowledge);
      return knowledge;
    },

    async trackWorkItem(title, kind = 'objective', status = 'open', detail, options) {
      const workItem = await asyncAdapter.insertWorkItem({
        ...config.scope,
        session_id: config.sessionId,
        visibility_class: options?.visibilityClass ?? 'private',
        title: config.redactText ? config.redactText({ kind: 'work_item', text: title }) : title,
        kind,
        status,
        detail:
          detail && config.redactText
            ? config.redactText({ kind: 'work_item', text: detail })
            : detail,
      });
      await refreshSessionStateProjection();
      return workItem;
    },

    async updateWorkItem(id, patch, options) {
      const existing = await asyncAdapter.getWorkItemById(id);
      if (!existing) {
        return null;
      }
      if (!entityMatchesScope(existing, config.scope)) {
        throw new ScopeMismatchError(`Work item ${id} does not belong to the current scope`);
      }
      const workItem = await asyncAdapter.updateWorkItem(id, patch, options);
      await refreshSessionStateProjection();
      return workItem;
    },

    async claimWorkItem(input) {
      const workItem = await asyncAdapter.getWorkItemById(input.workItemId);
      if (workItem && !entityMatchesScope(workItem, config.scope)) {
        throw new ScopeMismatchError(`Work item ${input.workItemId} does not belong to the current scope`);
      }
      return asyncAdapter.claimWorkItem({
        ...normalizeScope(config.scope),
        work_item_id: input.workItemId,
        actor: input.actor,
        session_id: config.sessionId,
        lease_seconds: input.leaseSeconds,
        visibility_class: workItem?.visibility_class ?? 'private',
      });
    },

    async renewWorkClaim(claimId, actor, leaseSeconds) {
      const claim = await asyncAdapter.getWorkClaimById(claimId);
      if (claim && !entityMatchesScope(claim, config.scope)) {
        throw new ScopeMismatchError(`Work claim ${claimId} does not belong to the current scope`);
      }
      return asyncAdapter.renewWorkClaim(claimId, actor, leaseSeconds);
    },

    async releaseWorkClaim(claimId, actor, reason) {
      const claim = await asyncAdapter.getWorkClaimById(claimId);
      if (claim && !entityMatchesScope(claim, config.scope)) {
        throw new ScopeMismatchError(`Work claim ${claimId} does not belong to the current scope`);
      }
      return asyncAdapter.releaseWorkClaim(claimId, actor, reason);
    },

    async listWorkClaims(options) {
      return asyncAdapter.listWorkClaims(config.scope, {
        actor: options?.actor,
        sessionId: options?.sessionId,
      });
    },

    async handoffWorkItem(input) {
      const workItem = await asyncAdapter.getWorkItemById(input.workItemId);
      if (workItem && !entityMatchesScope(workItem, config.scope)) {
        throw new ScopeMismatchError(`Work item ${input.workItemId} does not belong to the current scope`);
      }
      return asyncAdapter.createHandoff({
        ...normalizeScope(config.scope),
        work_item_id: input.workItemId,
        from_actor: input.fromActor,
        to_actor: input.toActor,
        session_id: config.sessionId,
        summary: input.summary,
        context_bundle_ref: input.contextBundleRef ?? null,
        expires_at: input.expiresAt ?? null,
        visibility_class: workItem?.visibility_class ?? 'private',
      });
    },

    async acceptHandoff(handoffId, actor, reason) {
      const handoff = await asyncAdapter.getHandoffById(handoffId);
      if (handoff && !entityMatchesScope(handoff, config.scope)) {
        throw new ScopeMismatchError(`Handoff ${handoffId} does not belong to the current scope`);
      }
      return asyncAdapter.acceptHandoff(handoffId, actor, reason);
    },

    async rejectHandoff(handoffId, actor, reason) {
      const handoff = await asyncAdapter.getHandoffById(handoffId);
      if (handoff && !entityMatchesScope(handoff, config.scope)) {
        throw new ScopeMismatchError(`Handoff ${handoffId} does not belong to the current scope`);
      }
      return asyncAdapter.rejectHandoff(handoffId, actor, reason);
    },

    async cancelHandoff(handoffId, actor, reason) {
      const handoff = await asyncAdapter.getHandoffById(handoffId);
      if (handoff && !entityMatchesScope(handoff, config.scope)) {
        throw new ScopeMismatchError(`Handoff ${handoffId} does not belong to the current scope`);
      }
      return asyncAdapter.cancelHandoff(handoffId, actor, reason);
    },

    async listPendingHandoffs(options) {
      return asyncAdapter.listHandoffs(config.scope, {
        actor: options?.actor,
        direction: options?.direction,
        statuses: ['pending'],
      });
    },

    async resolveChangeStreamCursor(cursor) {
      return resolveChangeStreamCursorInternal(cursor);
    },

    async *streamChanges(options) {
      let cursor = await resolveChangeStreamCursorInternal(options?.cursor);
      while (!options?.signal?.aborted) {
        const page = await asyncAdapter.listMemoryEvents(config.scope, {
          cursor,
          sessionId: options?.sessionId,
          entityKind: options?.entityKind,
          entityId: options?.entityId,
          limit: 100,
        });
        for (const event of page.events) {
          cursor = event.event_id;
          yield event;
        }
        if (options?.signal?.aborted) break;
        await delay(options?.pollIntervalMs ?? 250);
      }
    },

    async inspectKnowledge(id) {
      const knowledge = await asyncAdapter.getKnowledgeMemoryById(id);
      if (!knowledge || !knowledgeMatchesScope(knowledge, config.scope)) {
        return { knowledge: null, evidence: [], audits: [] };
      }
      const evidence = await asyncAdapter.listKnowledgeEvidenceForKnowledge(id);
      const audits = await asyncAdapter.getKnowledgeMemoryAuditsForKnowledge(
        config.scope,
        id,
        50,
      );
      return { knowledge, evidence, audits };
    },

    async listKnowledge(options) {
      return asyncAdapter.getActiveKnowledgeMemoryPaginated(config.scope, options);
    },

    async getKnowledgeAudits(options) {
      if (options?.knowledgeId != null) {
        return asyncAdapter.getKnowledgeMemoryAuditsForKnowledge(
          config.scope,
          options.knowledgeId,
          options.limit ?? 20,
        );
      }
      return asyncAdapter.getRecentKnowledgeMemoryAudits(config.scope, options?.limit ?? 20);
    },

    async getContextMonitor() {
      return asyncAdapter.getContextMonitor(config.scope);
    },

    async getRecentCompactionLogs(limit) {
      return asyncAdapter.getRecentCompactionLogs(config.scope, limit ?? 10);
    },

    async getDueReverification(options) {
      const now = Math.floor(Date.now() / 1000);
      const maintenancePolicy = resolveMaintenancePolicy(config.maintenancePolicy);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      return getDueReverificationKnowledge(activeKnowledge, maintenancePolicy, now).slice(
        0,
        options?.limit ?? activeKnowledge.length,
      );
    },

    async reverifyKnowledge(id) {
      const knowledge = await asyncAdapter.getKnowledgeMemoryById(id);
      if (!knowledge) {
        throw new ResourceNotFoundError(`Memory validation: knowledge memory ${id} was not found`);
      }
      if (!knowledgeMatchesScope(knowledge, config.scope)) {
        throw new ScopeMismatchError(
          `Memory validation: knowledge memory ${id} does not belong to the requested scope`,
        );
      }
      const evidence = await asyncAdapter.listKnowledgeEvidenceForKnowledge(id);
      const policy = {
        ...DEFAULT_EXTRACTION_POLICY,
        ...config.extractionPolicy,
      };
      const assessment = assessKnowledgeReverification({
        knowledge,
        evidence,
        policy,
      });
      const supportEvidence = evidence.filter((item) => item.support_polarity === 'supports');
      const successCount = supportEvidence.filter((item) => item.outcome === 'success').length;
      const failureCount = supportEvidence.filter((item) => item.outcome === 'failure').length;
      const now = Math.floor(Date.now() / 1000);
      const maintenancePolicy = resolveMaintenancePolicy(config.maintenancePolicy);
      const nextReverificationAt = computeNextReverificationAt(
        {
          ...knowledge,
          knowledge_state: assessment.state,
          last_verified_at: now,
          last_confirmed_at:
            assessment.state === 'trusted' ? now : knowledge.last_confirmed_at,
          confirmation_count:
            assessment.state === 'trusted'
              ? knowledge.confirmation_count + 1
              : knowledge.confirmation_count,
        },
        maintenancePolicy,
      );
      const updated = await asyncAdapter.updateKnowledgeMemory(id, {
        knowledge_state: assessment.state,
        knowledge_class:
          failureCount > successCount &&
          ['strategy', 'procedure'].includes(knowledge.knowledge_class)
            ? 'anti_pattern'
            : successCount > 0 &&
                assessment.state === 'trusted' &&
                knowledge.knowledge_class === 'procedure'
              ? 'strategy'
              : knowledge.knowledge_class,
        trust_score: assessment.trust_score,
        verification_status:
          assessment.state === 'trusted'
            ? 'verified'
            : assessment.state === 'provisional'
              ? 'corroborated'
              : 'unverified',
        verification_notes: assessment.reasons.join(', ') || null,
        last_verified_at: now,
        next_reverification_at: nextReverificationAt,
        last_confirmed_at: assessment.state === 'trusted' ? now : knowledge.last_confirmed_at,
        confirmation_count:
          assessment.state === 'trusted'
            ? knowledge.confirmation_count + 1
            : knowledge.confirmation_count,
        disputed_at: assessment.state === 'disputed' ? now : knowledge.disputed_at,
        dispute_reason: assessment.state === 'disputed' ? assessment.reasons.join(', ') : knowledge.dispute_reason,
        contradiction_score:
          assessment.state === 'disputed'
            ? Math.max(knowledge.contradiction_score, 1)
            : knowledge.contradiction_score,
        successful_use_count: knowledge.successful_use_count + successCount,
        failed_use_count: knowledge.failed_use_count + failureCount,
      });
      if (updated) {
        emitKnowledgeChange(assessment.state === 'trusted' ? 'reverified' : 'demoted', updated);
      }
      return assessment;
    },

    async runReverification(options) {
      const now = Math.floor(Date.now() / 1000);
      const maintenancePolicy = resolveMaintenancePolicy(config.maintenancePolicy);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      const due = getDueReverificationKnowledge(activeKnowledge, maintenancePolicy, now).slice(
        0,
        options?.limit ?? activeKnowledge.length,
      );
      const reverifiedKnowledgeIds: number[] = [];
      const demotedKnowledgeIds: number[] = [];
      for (const item of due) {
        const assessment = await this.reverifyKnowledge(item.id);
        reverifiedKnowledgeIds.push(item.id);
        if (assessment.state !== 'trusted') {
          demotedKnowledgeIds.push(item.id);
        }
      }
      return { reverifiedKnowledgeIds, demotedKnowledgeIds };
    },

    async runMaintenance(policy) {
      const effectivePolicyInput = {
        ...(config.maintenancePolicy ?? {}),
        ...(policy ?? {}),
        classRetentionOverrides: {
          ...(config.maintenancePolicy?.classRetentionOverrides ?? {}),
          ...(policy?.classRetentionOverrides ?? {}),
        },
      };
      const effectivePolicy = resolveMaintenancePolicy(effectivePolicyInput);
      const report = await runMaintenance(asyncAdapter, config.scope, effectivePolicy);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      const due = getDueReverificationKnowledge(
        activeKnowledge,
        effectivePolicy,
        Math.floor(Date.now() / 1000),
      );
      const reverification = { reverifiedKnowledgeIds: [] as number[], demotedKnowledgeIds: [] as number[] };
      for (const item of due) {
        const assessment = await this.reverifyKnowledge(item.id);
        reverification.reverifiedKnowledgeIds.push(item.id);
        if (assessment.state !== 'trusted') {
          reverification.demotedKnowledgeIds.push(item.id);
        }
      }
      report.reverifiedKnowledgeIds.push(...reverification.reverifiedKnowledgeIds);
      report.demotedKnowledgeIds.push(...reverification.demotedKnowledgeIds);
      report.reverifiedKnowledgeIds = [...new Set(report.reverifiedKnowledgeIds)];
      report.demotedKnowledgeIds = [...new Set(report.demotedKnowledgeIds)];
      for (const retiredId of report.retiredKnowledgeIds) {
        const retired = await asyncAdapter.getKnowledgeMemoryById(retiredId);
        if (retired) emitKnowledgeChange('retired', retired);
      }
      for (const demotedId of report.demotedKnowledgeIds) {
        const demoted = await asyncAdapter.getKnowledgeMemoryById(demotedId);
        if (demoted) emitKnowledgeChange('demoted', demoted);
      }
      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'run_maintenance',
        expiredWorkingMemoryCount: report.expiredWorkingMemoryIds.length,
        retiredKnowledgeCount: report.retiredKnowledgeIds.length,
        deletedWorkItemCount: report.deletedWorkItemIds.length,
        deletedAssociationCount: report.deletedAssociationIds.length,
        reverifiedKnowledgeCount: report.reverifiedKnowledgeIds.length,
        demotedKnowledgeCount: report.demotedKnowledgeIds.length,
        expiredWorkClaimCount: report.expiredWorkClaimIds.length,
        expiredHandoffCount: report.expiredHandoffIds.length,
      });
      await refreshSessionStateProjection();
      lastMaintenanceReport = report;
      lastMaintenanceTimestamp = Math.floor(Date.now() / 1000);
      return report;
    },

    async reembedKnowledge(options) {
      // Phase 2.4: batch re-embed active knowledge whose stored (model,
      // dimensions) mismatch the active provider (or has no stored vector).
      // No-op without a provider; TODO(plan 6.3) transport routes deferred.
      const reembeddedIds: number[] = [];
      if (!config.embeddingAdapter || !config.embeddingGenerator) {
        return { reembeddedIds };
      }
      const batchSize = Math.max(1, options?.batchSize ?? 50);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);

      // Probe the active provider's dimensionality once.
      let activeDims: number | undefined;
      try {
        const [probe] = await circuitBreakers.embeddings.execute(() =>
          config.embeddingGenerator!(['__reembed_probe__']),
        );
        activeDims = probe?.length;
      } catch {
        activeDims = undefined;
      }

      // D3: staleness is metadata-aware. A stored embedding is stale when
      // dimensions differ from the active provider OR (the active model is known
      // AND the stored model differs) — the same-dimension model swap that a
      // length-only check misses. getEmbeddingMetadata exposes the stored model;
      // adapters that predate it fall back to a length-only check.
      const readMetadata = config.embeddingAdapter.getEmbeddingMetadata?.bind(
        config.embeddingAdapter,
      );
      const stale: KnowledgeMemory[] = [];
      for (const item of activeKnowledge) {
        if (readMetadata) {
          const meta = await readMetadata(item.id);
          if (
            !meta ||
            (activeDims != null && meta.dimensions !== activeDims) ||
            (activeEmbeddingModel !== 'unknown' && meta.model !== activeEmbeddingModel)
          ) {
            stale.push(item);
          }
        } else {
          const stored = await config.embeddingAdapter.getEmbedding(item.id);
          if (!stored || (activeDims != null && stored.length !== activeDims)) {
            stale.push(item);
          }
        }
      }

      for (let i = 0; i < stale.length; i += batchSize) {
        const batch = stale.slice(i, i + batchSize);
        try {
          const vectors = await circuitBreakers.embeddings.execute(() =>
            config.embeddingGenerator!(batch.map((item) => item.fact)),
          );
          for (const [index, item] of batch.entries()) {
            const vector = vectors[index];
            if (!vector) continue;
            await config.embeddingAdapter!.storeEmbedding(item.id, vector, {
              model: activeEmbeddingModel,
              dimensions: vector.length,
            });
            reembeddedIds.push(item.id);
          }
        } catch (error) {
          config.logger?.warn('memory.embeddings.reembed_failed', {
            error: String(error),
            batchStart: i,
            batchSize: batch.length,
          });
          emitDegradation('embeddings', {
            stage: 'reembed',
            error: String(error),
            batchStart: i,
          });
        }
      }

      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'reembed_knowledge',
        activeModel: activeEmbeddingModel,
        activeDimensions: activeDims ?? null,
        candidateCount: stale.length,
        reembeddedCount: reembeddedIds.length,
      });

      return { reembeddedIds };
    },

    async searchEpisodes(options) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError(
          'searchEpisodes requires a structuredClient in MemoryManagerConfig',
        );
      }
      return searchEpisodes(
        {
          adapter: asyncAdapter,
          scope: config.scope,
          client: config.structuredClient,
          telemetry: { logger: config.logger, onEvent },
        },
        options,
      );
    },

    async summarizeEpisode(sessionId, options) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError(
          'summarizeEpisode requires a structuredClient in MemoryManagerConfig',
        );
      }
      const detailLevel = options?.detailLevel ?? 'overview';
      // Fetch both active and all session working memories. Partially
      // compacted sessions have BOTH archived history (covered by working
      // memory turn ranges) and active turns; a recap built from only the
      // active fragment silently drops earlier context, so we always merge
      // archived + active and dedupe by turn id.
      const activeTurns = await asyncAdapter.getActiveTurns(config.scope, sessionId);
      const allSessionWm = await asyncAdapter.getWorkingMemoryBySession(sessionId, config.scope);
      let archivedTurns: Turn[] = [];
      if (allSessionWm.length > 0) {
        const minStart = Math.min(...allSessionWm.map((wm) => wm.turn_id_start));
        const maxEnd = Math.max(...allSessionWm.map((wm) => wm.turn_id_end));
        archivedTurns = await asyncAdapter.getArchivedTurnRange(sessionId, minStart, maxEnd, config.scope);
      }
      const turns = mergeTurnsById(archivedTurns, activeTurns);
      return summarizeEpisode(
        {
          adapter: asyncAdapter,
          scope: config.scope,
          client: config.structuredClient,
          telemetry: { logger: config.logger, onEvent },
        },
        { turns, workingMemories: allSessionWm, sessionId, detailLevel, client: config.structuredClient },
      );
    },

    async reflect(options) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError('reflect requires a structuredClient in MemoryManagerConfig');
      }
      return reflect(
        {
          adapter: asyncAdapter,
          scope: config.scope,
          client: config.structuredClient,
          telemetry: { logger: config.logger, onEvent },
        },
        options,
      );
    },

    async searchCognitive(options) {
      return searchCognitive(asyncAdapter, config.scope, options);
    },

    async getProfile(options) {
      return getProfile(asyncAdapter, config.scope, options);
    },

    async createPlaybook(input) {
      return asyncAdapter.insertPlaybook({ ...input, ...config.scope });
    },

    async createPlaybookFromTask(input) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError(
          'createPlaybookFromTask requires a structuredClient in MemoryManagerConfig',
        );
      }
      return createPlaybookFromTask(
        { adapter: asyncAdapter, scope: config.scope, client: config.structuredClient },
        input,
      );
    },

    async revisePlaybook(playbookId, newInstructions, revisionReason, sourceSessionId) {
      return revisePlaybook(asyncAdapter, config.scope, playbookId, newInstructions, revisionReason, sourceSessionId);
    },

    async getPlaybook(id) {
      const playbook = await asyncAdapter.getPlaybookById(id);
      if (!playbook) return null;
      const norm = normalizeScope(config.scope);
      if (
        playbook.tenant_id !== norm.tenant_id ||
        playbook.system_id !== norm.system_id ||
        playbook.workspace_id !== norm.workspace_id ||
        playbook.collaboration_id !== norm.collaboration_id ||
        playbook.scope_id !== norm.scope_id
      ) {
        return null;
      }
      return playbook;
    },

    async listPlaybooks() {
      return asyncAdapter.getActivePlaybooks(config.scope);
    },

    async searchPlaybooks(query, options) {
      return findRelevantPlaybooks(asyncAdapter, config.scope, query, options);
    },

    async updatePlaybook(id, patch) {
      const playbook = await asyncAdapter.getPlaybookById(id);
      if (!playbook) return null;
      const norm = normalizeScope(config.scope);
      if (
        playbook.tenant_id !== norm.tenant_id ||
        playbook.system_id !== norm.system_id ||
        playbook.workspace_id !== norm.workspace_id ||
        playbook.collaboration_id !== norm.collaboration_id ||
        playbook.scope_id !== norm.scope_id
      ) {
        return null;
      }
      return asyncAdapter.updatePlaybook(id, patch);
    },

    async recordPlaybookUse(id) {
      const playbook = await asyncAdapter.getPlaybookById(id);
      if (!playbook) {
        throw new ResourceNotFoundError(`Playbook ${id} not found`);
      }
      const norm = normalizeScope(config.scope);
      if (
        playbook.tenant_id !== norm.tenant_id ||
        playbook.system_id !== norm.system_id ||
        playbook.workspace_id !== norm.workspace_id ||
        playbook.collaboration_id !== norm.collaboration_id ||
        playbook.scope_id !== norm.scope_id
      ) {
        throw new ScopeMismatchError(`Playbook ${id} does not belong to the requested scope`);
      }
      return asyncAdapter.recordPlaybookUse(id);
    },

    async addAssociation(input) {
      // Validate source/target IDs are positive integers. Callers (HTTP/MCP)
      // only check typeof number, so this is the authoritative guard.
      if (!Number.isInteger(input.source_id) || input.source_id <= 0) {
        throw new ValidationError(
          `addAssociation: source_id must be a positive integer, got ${input.source_id}`,
        );
      }
      if (!Number.isInteger(input.target_id) || input.target_id <= 0) {
        throw new ValidationError(
          `addAssociation: target_id must be a positive integer, got ${input.target_id}`,
        );
      }
      if (input.source_kind === input.target_kind && input.source_id === input.target_id) {
        throw new ValidationError('addAssociation: self-referential associations are not allowed');
      }
      // Validate confidence is in [0, 1] when provided.
      if (input.confidence !== undefined) {
        if (
          typeof input.confidence !== 'number' ||
          Number.isNaN(input.confidence) ||
          input.confidence < 0 ||
          input.confidence > 1
        ) {
          throw new ValidationError(
            `addAssociation: confidence must be a number in [0, 1], got ${input.confidence}`,
          );
        }
      }
      // Resolve source and target: both must exist and belong to the caller's
      // scope. Without this, callers can create orphaned or cross-scope edges,
      // polluting the graph and weakening isolation guarantees.
      const norm = normalizeScope(config.scope);
      await assertAssociationEndpointInScope(
        asyncAdapter, norm, input.source_kind, input.source_id, 'source',
      );
      await assertAssociationEndpointInScope(
        asyncAdapter, norm, input.target_kind, input.target_id, 'target',
      );
      // When the caller does not specify provenance, infer from auto_generated:
      // user-created (non-auto) edges are 'extracted' with full confidence.
      const provenance = input.provenance ?? (input.auto_generated ? 'inferred' : 'extracted');
      const confidence = input.confidence ?? (input.auto_generated ? 0.8 : 1.0);
      return asyncAdapter.insertAssociation({
        ...input,
        ...norm,
        provenance,
        confidence,
      });
    },

    async getAssociations(kind, id) {
      const [from, to] = await Promise.all([
        asyncAdapter.getAssociationsFrom(kind, id, config.scope),
        asyncAdapter.getAssociationsTo(kind, id, config.scope),
      ]);
      return { from, to };
    },

    async traverseAssociations(kind, id, options) {
      return traverseAssociations(asyncAdapter, config.scope, kind, id, options);
    },

    async removeAssociation(id) {
      // Scope safety: verify the association belongs to the current scope by
      // checking the association row's own scope columns. Scanning through
      // active knowledge/playbooks/WM/work items would incorrectly reject
      // associations attached to archived/expired/orphaned nodes, leaving
      // stale edges permanently in the graph.
      if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError(`removeAssociation: id must be a positive integer, got ${id}`);
      }
      const association = await asyncAdapter.getAssociationById(id);
      if (!association) {
        throw new ResourceNotFoundError(`Association ${id} not found`);
      }
      const norm = normalizeScope(config.scope);
      if (
        association.tenant_id !== norm.tenant_id ||
        association.system_id !== norm.system_id ||
        association.workspace_id !== norm.workspace_id ||
        association.collaboration_id !== norm.collaboration_id ||
        association.scope_id !== norm.scope_id
      ) {
        throw new ScopeMismatchError(`Association ${id} not found in the current scope`);
      }
      await asyncAdapter.deleteAssociation(id);
    },

    async ingestDocument(content, options) {
      if (!config.extractor) {
        throw new ValidationError('An extractor is required for document ingestion');
      }
      const contentHash = createHash('sha256').update(content).digest('hex');
      const existing = await asyncAdapter.getSourceDocumentByHash(contentHash, config.scope);
      if (existing) {
        return { document: existing, knowledge: [] };
      }
      const doc = await asyncAdapter.insertSourceDocument({
        ...config.scope,
        title: options.title,
        content_hash: contentHash,
        mime_type: options.mimeType ?? 'text/plain',
        url: options.url ?? null,
        metadata: options.metadata ?? {},
        token_estimate: estimateTokens(content),
      });
      const facts = await config.extractor(content, [], []);
      const created: KnowledgeMemory[] = [];
      for (const fact of facts) {
        const km = await asyncAdapter.insertKnowledgeMemory({
          ...config.scope,
          fact: config.redactText ? config.redactText({ kind: 'fact', text: fact.fact }) : fact.fact,
          fact_type: fact.factType,
          knowledge_class: manualKnowledgeClassForFactType(fact.factType),
          source: 'manual',
          confidence: fact.confidence,
        });
        created.push(km);
      }
      await maybeEmbedKnowledge(created);
      await asyncAdapter.updateSourceDocument(doc.id, {
        status: 'processed',
        fact_count: created.length,
        processed_at: Math.floor(Date.now() / 1000),
      });
      const updated = await asyncAdapter.getSourceDocumentById(doc.id);
      return { document: updated ?? { ...doc, status: 'processed' as const, fact_count: created.length, processed_at: Math.floor(Date.now() / 1000) }, knowledge: created };
    },

    async getSourceDocument(id) {
      const doc = await asyncAdapter.getSourceDocumentById(id);
      if (!doc) return null;
      if (!entityMatchesScope(doc, config.scope)) return null;
      return doc;
    },

    async listSourceDocuments(options) {
      return asyncAdapter.listSourceDocuments(config.scope, options);
    },

    async exportAsMarkdown(options) {
      return exportAsMarkdown(asyncAdapter, config.scope, options);
    },

    async promoteResponse(turnId, options) {
      if (!config.extractor) {
        throw new ValidationError('An extractor is required for response promotion');
      }
      const turn = await asyncAdapter.getTurnById(turnId);
      if (!turn) {
        throw new ResourceNotFoundError(`Turn ${turnId} not found`);
      }
      if (!entityMatchesScope(turn, config.scope)) {
        throw new ScopeMismatchError(`Turn ${turnId} does not belong to the current scope`);
      }
      if (turn.role !== 'assistant') {
        throw new ValidationError('promoteResponse supports only assistant turns');
      }
      const facts = await config.extractor(turn.content, [], []);
      const created: KnowledgeMemory[] = [];
      for (const fact of facts) {
        if (options?.factTypes && !options.factTypes.includes(fact.factType)) continue;
        if (options?.minConfidence) {
          const levels: Record<string, number> = { low: 0, medium: 1, high: 2 };
          if ((levels[fact.confidence] ?? 0) < (levels[options.minConfidence] ?? 0)) continue;
        }
        const km = await asyncAdapter.insertKnowledgeMemory({
          ...config.scope,
          fact: config.redactText ? config.redactText({ kind: 'fact', text: fact.fact }) : fact.fact,
          fact_type: fact.factType,
          knowledge_class: manualKnowledgeClassForFactType(fact.factType),
          source: 'manual',
          confidence: fact.confidence,
        });
        created.push(km);
      }
      await maybeEmbedKnowledge(created);
      return created;
    },

    // --- Phase 5 methods ---

    async discover(options) {
      return discover(resolveSyncAdapter(config, asyncAdapter, 'discover()'), config.scope, options);
    },

    async getGraphReport(options) {
      return getGraphReport(
        resolveSyncAdapter(config, asyncAdapter, 'getGraphReport()'),
        config.scope,
        options,
      );
    },

    async getFactsAt(timestamp, options) {
      const queryOptions: TemporalQueryOptions = {
        timestamp,
        scope: config.scope,
        knowledgeClass: options?.knowledgeClass,
        fallbackToReplay: options?.fallbackToReplay ?? true,
      };
      const getContextAtFn = async (asOf: number) =>
        (await buildReplayedContext(asOf)).context;
      return getFactsAt(asyncAdapter, getContextAtFn, queryOptions);
    },

    async reflectOnKnowledge(options) {
      const result = await reflectOnKnowledge(asyncAdapter, config.scope, {
        ...options,
        scope: options?.scope ?? normalizeScope(config.scope),
        existingAliases: options?.existingAliases ?? config.aliasMap,
      }, config.extractor);
      lastReflectionResult = result;
      lastReflectionTimestamp = Math.floor(Date.now() / 1000);
      return result;
    },

    async derive(options) {
      const deriveScope = options?.scope ?? config.scope;
      const reflection = await reflectOnKnowledge(asyncAdapter, deriveScope, {
        existingAliases: config.aliasMap,
      }, config.extractor);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(deriveScope);
      const outputs = derive(reflection, activeKnowledge, options);
      lastDerivedOutputs = outputs;
      lastDerivedTimestamp = Math.floor(Date.now() / 1000);
      return outputs;
    },

    async getCurationSummary(input, options) {
      // Auto-populate from cached manager state when caller provides no input
      const merged: import('./curation.js').CurationInput = {
        maintenance: input?.maintenance ?? lastMaintenanceReport,
        maintenanceTimestamp: input?.maintenanceTimestamp ?? lastMaintenanceTimestamp,
        reflection: input?.reflection ?? lastReflectionResult,
        reflectionTimestamp: input?.reflectionTimestamp ?? lastReflectionTimestamp,
        derived: input?.derived ?? lastDerivedOutputs,
        derivedTimestamp: input?.derivedTimestamp ?? lastDerivedTimestamp,
        ontologyActions: input?.ontologyActions,
      };
      return getCurationSummary(merged, options);
    },

    async getCoreMemory(options) {
      return getCoreMemory(asyncAdapter, config.scope, options);
    },

    setAliases(aliasMap) {
      config.aliasMap = aliasMap;
    },

    getAliases() {
      return config.aliasMap;
    },

    async saveAliases(aliasMap) {
      config.aliasMap = aliasMap;
      await asyncAdapter.setScopeConfig(
        config.scope,
        SCOPE_CONFIG_KEYS.aliases,
        serializeAliases(aliasMap),
      );
    },

    async loadAliases() {
      const stored = await asyncAdapter.getScopeConfig(config.scope, SCOPE_CONFIG_KEYS.aliases);
      const aliasMap = parseAliases(stored);
      if (aliasMap) {
        config.aliasMap = aliasMap;
      }
      return aliasMap;
    },

    async getAliasCandidates(options) {
      const knowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      return discoverAliasCandidates(knowledge, {
        ...options,
        existingAliases: options?.existingAliases ?? config.aliasMap,
      });
    },

    setOntology(ontology) {
      config.ontology = ontology;
    },

    getOntology() {
      return config.ontology;
    },

    async saveOntology(ontology) {
      config.ontology = ontology;
      await asyncAdapter.setScopeConfig(
        config.scope,
        SCOPE_CONFIG_KEYS.ontology,
        serializeOntology(ontology),
      );
    },

    async loadOntology() {
      const stored = await asyncAdapter.getScopeConfig(config.scope, SCOPE_CONFIG_KEYS.ontology);
      const ontology = parseOntology(stored);
      if (ontology) {
        config.ontology = ontology;
      }
      return ontology;
    },

    exportBundle(name, options) {
      return exportBundle(resolveSyncAdapter(config, asyncAdapter, 'exportBundle()'), name, {
        ...options,
        scope: config.scope, // Always enforce manager's scope
      });
    },

    importBundle(bundle, options) {
      return importBundle(resolveSyncAdapter(config, asyncAdapter, 'importBundle()'), bundle, options);
    },

    refreshDocuments(documents) {
      return refreshDocuments(
        resolveSyncAdapter(config, asyncAdapter, 'refreshDocuments()'),
        config.scope,
        documents,
      );
    },

    async close() {
      if (config.closeAdapter !== false) {
        await asyncAdapter.close();
      }
    },
  };
}
