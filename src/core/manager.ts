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
import type { StructuredGenerationClient } from '../contracts/generation-client.js';
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
import { getNativeSyncAdapter } from '../contracts/native-sync.js';
import {
  parseAliases,
  parseOntology,
  SCOPE_CONFIG_KEYS,
  serializeAliases,
  serializeOntology,
} from './scope-config.js';
import type { MemoryManagerConfig } from './manager-config.js';
import {
  resolveAdapter,
  mergeContextInvariants,
  manualKnowledgeClassForFactType,
} from './manager-support.js';
import type {
  ContextQueryOptions,
  ContextExpansionOptions,
  KnowledgeChangeRecord,
  KnowledgeChangeResult,
} from './manager-types.js';
import type { CapabilityContext } from './capabilities/context.js';
import {
  createCoordinationCapability,
  type CoordinationCapability,
} from './capabilities/coordination.js';
import {
  createGovernanceCapability,
  type GovernanceCapability,
} from './capabilities/governance.js';
import { createTemporalCapability, type TemporalCapability } from './capabilities/temporal.js';
import { createPlaybooksCapability, type PlaybooksCapability } from './capabilities/playbooks.js';
import { createCurationCapability, type CurationCapability } from './capabilities/curation.js';
import { createGraphCapability, type GraphCapability } from './capabilities/graph.js';

// Re-exported for barrel stability: these types moved to neutral leaf modules
// (Phase 6.2) so the capability namespaces can import them without a cycle.
export type { MemoryManagerConfig } from './manager-config.js';
export type {
  ContextQueryOptions,
  ContextExpansionOptions,
  KnowledgeChangeRecord,
  KnowledgeChangeResult,
} from './manager-types.js';
export type {
  CoordinationCapability,
  GovernanceCapability,
  TemporalCapability,
  PlaybooksCapability,
  CurationCapability,
  GraphCapability,
};

export interface MemoryManagerNamespaces {
  /** Multi-agent coordination: work items, leases/claims, and handoffs. */
  coordination: CoordinationCapability;
  /** Context governance: contracts, invariants, and the escalation policy. */
  governance: GovernanceCapability;
  /** Temporal reads: point-in-time state, timeline, diffs, change feeds, snapshots. */
  temporal: TemporalCapability;
  /** Reusable procedure playbooks. */
  playbooks: PlaybooksCapability;
  /** Knowledge curation: reverification, reflection, documents, bundles, aliases/ontology. */
  curation: CurationCapability;
  /** Associations, graph traversal, graph reports, and discovery. */
  graph: GraphCapability;
}

export interface MemoryManager extends MemoryManagerNamespaces {
  // ---- Top-level daily drivers (the blessed flat API; NOT deprecated) ----
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
  getSessionBootstrap(
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<SessionBootstrap>;
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
  forceCompact(): Promise<CompactionResult | null>;
  learnFact(
    fact: string,
    factType: FactType,
    confidence?: FactConfidence,
    rationale?: string | null,
    options?: { visibilityClass?: KnowledgeMemory['visibility_class'] },
  ): Promise<KnowledgeMemory>;
  trackWorkItem(
    title: string,
    kind?: WorkItem['kind'],
    status?: WorkItem['status'],
    detail?: string,
    options?: { visibilityClass?: WorkItem['visibility_class'] },
  ): Promise<WorkItem>;
  reflect(options: ReflectOptions): Promise<ReflectResult>;
  getProfile(options?: ProfileOptions): Promise<Profile>;
  runMaintenance(policy?: MaintenancePolicy): Promise<MaintenanceReport>;
  close(): Promise<void>;

  // ---- @deprecated flat shims (delegate to their namespace twin; Phase 6.2, D-BREAK) ----
  /** @deprecated Use `manager.temporal.getContextAt()` (Phase 6.2). */
  getContextAt(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<MemoryContext>;
  /** @deprecated Use `manager.governance.requestContextExpansion()` (Phase 6.2). */
  requestContextExpansion(
    request: ContextRequest,
    options?: ContextExpansionOptions,
  ): Promise<ContextRequestResolution>;
  /** @deprecated Use `manager.governance.getContextGovernance()` (Phase 6.2). */
  getContextGovernance(): Promise<ContextGovernanceSnapshot>;
  /** @deprecated Use `manager.governance.setDefaultContextContract()` (Phase 6.2). */
  setDefaultContextContract(contract: ContextContract | null): Promise<ContextContract | null>;
  /** @deprecated Use `manager.governance.putContextContract()` (Phase 6.2). */
  putContextContract(name: string, contract: ContextContract): Promise<ContextContract>;
  /** @deprecated Use `manager.governance.deleteContextContract()` (Phase 6.2). */
  deleteContextContract(name: string): Promise<boolean>;
  /** @deprecated Use `manager.governance.putContextInvariant()` (Phase 6.2). */
  putContextInvariant(invariant: ContextInvariant): Promise<ContextInvariant>;
  /** @deprecated Use `manager.governance.deleteContextInvariant()` (Phase 6.2). */
  deleteContextInvariant(id: string): Promise<boolean>;
  /** @deprecated Use `manager.governance.getContextEscalationPolicy()` (Phase 6.2). */
  getContextEscalationPolicy(): Promise<ContextGovernanceSnapshot['escalationPolicy']>;
  /** @deprecated Use `manager.governance.setContextEscalationPolicy()` (Phase 6.2). */
  setContextEscalationPolicy(
    policy: ContextEscalationPolicy,
  ): Promise<ContextGovernanceSnapshot['escalationPolicy']>;
  /** @deprecated Use `manager.temporal.getStateAt()` (Phase 6.2). */
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
  /** @deprecated Use `manager.temporal.getTimeline()` (Phase 6.2). */
  getTimeline(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: TemporalIdInput;
  }): Promise<TimelineResult>;
  /** @deprecated Use `manager.temporal.diffState()` (Phase 6.2). */
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
  /** @deprecated Use `manager.temporal.listMemoryEvents()` (Phase 6.2). */
  listMemoryEvents(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: TemporalIdInput;
  }): Promise<TimelineResult>;
  /** @deprecated Use `manager.temporal.getSessionBootstrapAt()` (Phase 6.2). */
  getSessionBootstrapAt(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<SessionBootstrap>;
  /** @deprecated Use `manager.temporal.captureSnapshot()` (Phase 6.2). */
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
  /** @deprecated Use `manager.temporal.listKnowledgeChanges()` (Phase 6.2). */
  listKnowledgeChanges(options?: {
    cursor?: TemporalIdInput;
    since?: Date;
    scopeLevel?: ScopeLevel;
    limit?: number;
  }): Promise<KnowledgeChangeResult>;
  /** @deprecated Use `manager.temporal.pollForChanges()` (Phase 6.2). */
  pollForChanges(since: Date, options?: { scopeLevel?: ScopeLevel }): Promise<KnowledgeMemory[]>;
  /** @deprecated Use `manager.coordination.updateWorkItem()` (Phase 6.2). */
  updateWorkItem(
    id: number,
    patch: WorkItemPatch,
    options?: { expectedVersion?: number },
  ): Promise<WorkItem | null>;
  /** @deprecated Use `manager.coordination.claimWorkItem()` (Phase 6.2). */
  claimWorkItem(input: {
    workItemId: number;
    actor: ActorRef;
    leaseSeconds?: number;
  }): Promise<WorkClaim>;
  /** @deprecated Use `manager.coordination.renewWorkClaim()` (Phase 6.2). */
  renewWorkClaim(
    claimId: number,
    actor: ActorRef,
    leaseSeconds?: number,
  ): Promise<WorkClaim | null>;
  /** @deprecated Use `manager.coordination.releaseWorkClaim()` (Phase 6.2). */
  releaseWorkClaim(
    claimId: number,
    actor: ActorRef,
    reason?: string,
  ): Promise<WorkClaim | null>;
  /** @deprecated Use `manager.coordination.listWorkClaims()` (Phase 6.2). */
  listWorkClaims(options?: {
    actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
    sessionId?: string;
  }): Promise<WorkClaim[]>;
  /** @deprecated Use `manager.coordination.handoffWorkItem()` (Phase 6.2). */
  handoffWorkItem(input: {
    workItemId: number;
    fromActor: ActorRef;
    toActor: ActorRef;
    summary: string;
    contextBundleRef?: string | null;
    expiresAt?: number | null;
  }): Promise<HandoffRecord>;
  /** @deprecated Use `manager.coordination.acceptHandoff()` (Phase 6.2). */
  acceptHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  /** @deprecated Use `manager.coordination.rejectHandoff()` (Phase 6.2). */
  rejectHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  /** @deprecated Use `manager.coordination.cancelHandoff()` (Phase 6.2). */
  cancelHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  /** @deprecated Use `manager.coordination.listPendingHandoffs()` (Phase 6.2). */
  listPendingHandoffs(options?: {
    actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
    direction?: 'inbound' | 'outbound' | 'all';
  }): Promise<HandoffRecord[]>;
  /** @deprecated Use `manager.temporal.streamChanges()` (Phase 6.2). */
  streamChanges(options?: {
    cursor?: TemporalIdInput;
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): AsyncIterable<MemoryEventRecord>;
  /** @deprecated Use `manager.temporal.resolveChangeStreamCursor()` (Phase 6.2). */
  resolveChangeStreamCursor(cursor?: TemporalIdInput): Promise<TemporalId>;
  /** @deprecated Use `manager.curation.inspectKnowledge()` (Phase 6.2). */
  inspectKnowledge(id: number): Promise<{
    knowledge: KnowledgeMemory | null;
    evidence: KnowledgeEvidence[];
    audits: KnowledgeMemoryAudit[];
  }>;
  /** @deprecated Use `manager.curation.listKnowledge()` (Phase 6.2). */
  listKnowledge(options?: PaginationOptions): Promise<PaginatedResult<KnowledgeMemory>>;
  /** @deprecated Use `manager.curation.getKnowledgeAudits()` (Phase 6.2). */
  getKnowledgeAudits(options?: { knowledgeId?: number; limit?: number }): Promise<KnowledgeMemoryAudit[]>;
  /** @deprecated Use `manager.temporal.getContextMonitor()` (Phase 6.2). */
  getContextMonitor(): Promise<ContextMonitor | null>;
  /** @deprecated Use `manager.temporal.getRecentCompactionLogs()` (Phase 6.2). */
  getRecentCompactionLogs(limit?: number): Promise<CompactionLog[]>;
  /** @deprecated Use `manager.curation.getDueReverification()` (Phase 6.2). */
  getDueReverification(options?: { limit?: number }): Promise<KnowledgeMemory[]>;
  /** @deprecated Use `manager.curation.reverifyKnowledge()` (Phase 6.2). */
  reverifyKnowledge(id: number): Promise<KnowledgeTrustAssessment>;
  /** @deprecated Use `manager.curation.runReverification()` (Phase 6.2). */
  runReverification(options?: { limit?: number }): Promise<{
    reverifiedKnowledgeIds: number[];
    demotedKnowledgeIds: number[];
  }>;
  /**
   * Re-embed active knowledge whose stored embedding's (model, dimensions) do
   * not match the active provider (Phase 2.4). No-op without an embedding
   * adapter + generator. Returns the ids that were re-embedded.
   * @deprecated Use `manager.curation.reembedKnowledge()` (Phase 6.2).
   */
  reembedKnowledge(options?: { batchSize?: number }): Promise<{ reembeddedIds: number[] }>;
  /** @deprecated Use `manager.curation.searchEpisodes()` (Phase 6.2). */
  searchEpisodes(options: EpisodeSearchOptions): Promise<EpisodeSummary[]>;
  /** @deprecated Use `manager.curation.summarizeEpisode()` (Phase 6.2). */
  summarizeEpisode(sessionId: string, options?: { detailLevel?: EpisodeSummary['detailLevel'] }): Promise<EpisodeSummary>;
  /** @deprecated Use `manager.curation.searchCognitive()` (Phase 6.2). */
  searchCognitive(options: CognitiveSearchOptions): Promise<CognitiveSearchResult>;
  /** @deprecated Use `manager.playbooks.createPlaybook()` (Phase 6.2). */
  createPlaybook(input: Omit<NewPlaybook, 'tenant_id' | 'system_id' | 'scope_id' | 'workspace_id' | 'collaboration_id'>): Promise<Playbook>;
  /** @deprecated Use `manager.playbooks.createPlaybookFromTask()` (Phase 6.2). */
  createPlaybookFromTask(input: CreatePlaybookFromTaskInput): Promise<Playbook>;
  /** @deprecated Use `manager.playbooks.revisePlaybook()` (Phase 6.2). */
  revisePlaybook(
    playbookId: number,
    newInstructions: string,
    revisionReason: string,
    sourceSessionId?: string | null,
  ): Promise<{ playbook: Playbook; revision: PlaybookRevision }>;
  /** @deprecated Use `manager.playbooks.getPlaybook()` (Phase 6.2). */
  getPlaybook(id: number): Promise<Playbook | null>;
  /** @deprecated Use `manager.playbooks.listPlaybooks()` (Phase 6.2). */
  listPlaybooks(): Promise<Playbook[]>;
  /** @deprecated Use `manager.playbooks.searchPlaybooks()` (Phase 6.2). */
  searchPlaybooks(query: string, options?: SearchOptions): Promise<SearchResult<Playbook>[]>;
  /** @deprecated Use `manager.playbooks.updatePlaybook()` (Phase 6.2). */
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
  /** @deprecated Use `manager.playbooks.recordPlaybookUse()` (Phase 6.2). */
  recordPlaybookUse(id: number): Promise<void>;
  /** @deprecated Use `manager.graph.addAssociation()` (Phase 6.2). */
  addAssociation(input: Omit<NewAssociation, 'tenant_id' | 'system_id' | 'scope_id' | 'workspace_id' | 'collaboration_id'>): Promise<Association>;
  /** @deprecated Use `manager.graph.getAssociations()` (Phase 6.2). */
  getAssociations(kind: AssociationTargetKind, id: number): Promise<{ from: Association[]; to: Association[] }>;
  /** @deprecated Use `manager.graph.traverseAssociations()` (Phase 6.2). */
  traverseAssociations(kind: AssociationTargetKind, id: number, options?: { maxDepth?: number; maxNodes?: number }): Promise<AssociationGraph>;
  /** @deprecated Use `manager.graph.removeAssociation()` (Phase 6.2). */
  removeAssociation(id: number): Promise<void>;
  /** @deprecated Use `manager.curation.ingestDocument()` (Phase 6.2). */
  ingestDocument(
    content: string,
    options: { title: string; url?: string; mimeType?: string; metadata?: Record<string, string> },
  ): Promise<{ document: import('../contracts/types.js').SourceDocument; knowledge: KnowledgeMemory[] }>;
  /** @deprecated Use `manager.curation.getSourceDocument()` (Phase 6.2). */
  getSourceDocument(id: number): Promise<import('../contracts/types.js').SourceDocument | null>;
  /** @deprecated Use `manager.curation.listSourceDocuments()` (Phase 6.2). */
  listSourceDocuments(options?: PaginationOptions): Promise<PaginatedResult<import('../contracts/types.js').SourceDocument>>;
  /** @deprecated Use `manager.curation.exportAsMarkdown()` (Phase 6.2). */
  exportAsMarkdown(options?: import('../contracts/export.js').MarkdownExportOptions): Promise<import('../contracts/export.js').MarkdownExportResult>;
  /** @deprecated Use `manager.curation.promoteResponse()` (Phase 6.2). */
  promoteResponse(turnId: number, options?: { factTypes?: FactType[]; minConfidence?: FactConfidence }): Promise<KnowledgeMemory[]>;
  /** @deprecated Use `manager.graph.discover()` (Phase 6.2). */
  discover(options?: DiscoverOptions): Promise<DiscoveryReport>;
  /** @deprecated Use `manager.graph.getGraphReport()` (Phase 6.2). */
  getGraphReport(options?: GraphReportOptions): Promise<GraphReport>;
  /** @deprecated Use `manager.temporal.getFactsAt()` (Phase 6.2). */
  getFactsAt(timestamp: number, options?: Partial<Omit<TemporalQueryOptions, 'timestamp' | 'scope'>>): Promise<FactsAtResult>;
  /** @deprecated Use `manager.curation.reflectOnKnowledge()` (Phase 6.2). */
  reflectOnKnowledge(options?: ReflectOnKnowledgeOptions): Promise<KnowledgeReflectionResult>;
  /** @deprecated Use `manager.curation.derive()` (Phase 6.2). */
  derive(options?: DeriveOptions): Promise<DerivedOutput[]>;
  /** @deprecated Use `manager.curation.getCurationSummary()` (Phase 6.2). */
  getCurationSummary(input?: Partial<CurationInput>, options?: CurationOptions): Promise<CurationSummary>;
  /** @deprecated Use `manager.curation.getCoreMemory()` (Phase 6.2). */
  getCoreMemory(options?: CoreMemoryOptions): Promise<CoreMemoryBundle>;
  /** @deprecated Use `manager.curation.setAliases()` (Phase 6.2). */
  setAliases(aliasMap: AliasMap): void;
  /** @deprecated Use `manager.curation.getAliases()` (Phase 6.2). */
  getAliases(): AliasMap | undefined;
  /** @deprecated Use `manager.curation.saveAliases()` (Phase 6.2). */
  saveAliases(aliasMap: AliasMap): Promise<void>;
  /** @deprecated Use `manager.curation.loadAliases()` (Phase 6.2). */
  loadAliases(): Promise<AliasMap | undefined>;
  /** @deprecated Use `manager.curation.getAliasCandidates()` (Phase 6.2). */
  getAliasCandidates(options?: DiscoverAliasCandidatesOptions): Promise<AliasCandidate[]>;
  /** @deprecated Use `manager.curation.setOntology()` (Phase 6.2). */
  setOntology(ontology: OntologyConfig): void;
  /** @deprecated Use `manager.curation.getOntology()` (Phase 6.2). */
  getOntology(): OntologyConfig | undefined;
  /** @deprecated Use `manager.curation.saveOntology()` (Phase 6.2). */
  saveOntology(ontology: OntologyConfig): Promise<void>;
  /** @deprecated Use `manager.curation.loadOntology()` (Phase 6.2). */
  loadOntology(): Promise<OntologyConfig | undefined>;
  /** @deprecated Use `manager.curation.exportBundle()` (Phase 6.2). */
  exportBundle(name: string, options?: Partial<BundleExportOptions>): ExportBundleResult;
  /** @deprecated Use `manager.curation.importBundle()` (Phase 6.2). */
  importBundle(bundle: MemoryBundle, options: BundleImportOptions): ImportBundleResult;
  /** @deprecated Use `manager.curation.refreshDocuments()` (Phase 6.2). */
  refreshDocuments(documents: DocumentDescriptor[]): RefreshResult;
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

  // Governance capability owns the mutable governance cache (Phase 6.2, item 3:
  // default/named contracts, invariants, escalation policy, lazy-load latch).
  // Its internal accessors feed the manager's context-assembly helpers below;
  // the namespace is re-exposed as `manager.governance`.
  const governance = createGovernanceCapability({ asyncAdapter, config });
  const governanceNamespace = governance.namespace;
  const { ensureGovernanceLoaded, resolveContextContractReference, getManagedInvariants } =
    governance.internal;

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

  // ---- Capability wiring (Phase 6.2) ----
  // The shared internal services the manager built above are bundled into an
  // explicit context object. Each capability namespace factory destructures the
  // members it needs; capabilities never reach back into this closure directly.
  const internals: CapabilityContext = {
    asyncAdapter,
    config,
    onEvent,
    tokenEstimator,
    circuitBreakers,
    activeEmbeddingModel,
    emitKnowledgeChange,
    emitDegradation,
    maybeEmbedKnowledge,
    refreshSessionStateProjection,
    getContextInternal,
    buildReplayedContext,
    collectKnowledgeForProfile,
    buildSessionBootstrapPayload,
    filterTemporalStateForContext,
    collectBestEffortTemporalState,
    getTemporalCutoverAt,
    resolveChangeStreamCursorInternal,
    listKnowledgeChangesInternal,
  };

  const coordination = createCoordinationCapability(internals);
  const temporal = createTemporalCapability(internals);
  const playbooks = createPlaybooksCapability(internals);
  const graph = createGraphCapability(internals);
  const curationModule = createCurationCapability(internals);
  const curationNamespace = curationModule.namespace;
  const { recordMaintenance } = curationModule;

  return {
    // ---- Namespaces (Phase 6.2) ----
    coordination,
    governance: governanceNamespace,
    temporal,
    playbooks,
    curation: curationNamespace,
    graph,

    // ---- Top-level daily drivers (NOT deprecated) ----
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

    async getSessionBootstrap(relevanceQuery, options) {
      const context = await getContextInternal(relevanceQuery, undefined, options);
      const profile = buildProfileFromKnowledge(
        await collectKnowledgeForProfile(asyncAdapter, options),
      );
      return buildSessionBootstrapPayload(context, profile);
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

    async learnFact(fact, factType, confidence = 'high', rationale, options) {
      const knowledge = await asyncAdapter.insertKnowledgeMemory({
        ...config.scope,
        visibility_class: options?.visibilityClass ?? 'private',
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

    trackWorkItem(title, kind, status, detail, options) {
      return coordination.trackWorkItem(title, kind, status, detail, options);
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

    async getProfile(options) {
      return getProfile(asyncAdapter, config.scope, options);
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
        const assessment = await curationNamespace.reverifyKnowledge(item.id);
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
      recordMaintenance(report, Math.floor(Date.now() / 1000));
      return report;
    },

    async close() {
      if (config.closeAdapter !== false) {
        await asyncAdapter.close();
      }
    },

    // ---- @deprecated flat shims → namespace twins (Phase 6.2, D-BREAK) ----
    // Governance
    getContextGovernance: (...args) => governanceNamespace.getContextGovernance(...args),
    setDefaultContextContract: (...args) => governanceNamespace.setDefaultContextContract(...args),
    putContextContract: (...args) => governanceNamespace.putContextContract(...args),
    deleteContextContract: (...args) => governanceNamespace.deleteContextContract(...args),
    putContextInvariant: (...args) => governanceNamespace.putContextInvariant(...args),
    deleteContextInvariant: (...args) => governanceNamespace.deleteContextInvariant(...args),
    getContextEscalationPolicy: (...args) => governanceNamespace.getContextEscalationPolicy(...args),
    setContextEscalationPolicy: (...args) => governanceNamespace.setContextEscalationPolicy(...args),
    requestContextExpansion: (...args) => governanceNamespace.requestContextExpansion(...args),

    // Temporal
    getContextAt: (...args) => temporal.getContextAt(...args),
    getStateAt: (...args) => temporal.getStateAt(...args),
    getTimeline: (...args) => temporal.getTimeline(...args),
    diffState: (...args) => temporal.diffState(...args),
    listMemoryEvents: (...args) => temporal.listMemoryEvents(...args),
    getSessionBootstrapAt: (...args) => temporal.getSessionBootstrapAt(...args),
    captureSnapshot: (...args) => temporal.captureSnapshot(...args),
    streamChanges: (...args) => temporal.streamChanges(...args),
    resolveChangeStreamCursor: (...args) => temporal.resolveChangeStreamCursor(...args),
    listKnowledgeChanges: (...args) => temporal.listKnowledgeChanges(...args),
    pollForChanges: (...args) => temporal.pollForChanges(...args),
    getFactsAt: (...args) => temporal.getFactsAt(...args),
    getContextMonitor: (...args) => temporal.getContextMonitor(...args),
    getRecentCompactionLogs: (...args) => temporal.getRecentCompactionLogs(...args),

    // Coordination
    updateWorkItem: (...args) => coordination.updateWorkItem(...args),
    claimWorkItem: (...args) => coordination.claimWorkItem(...args),
    renewWorkClaim: (...args) => coordination.renewWorkClaim(...args),
    releaseWorkClaim: (...args) => coordination.releaseWorkClaim(...args),
    listWorkClaims: (...args) => coordination.listWorkClaims(...args),
    handoffWorkItem: (...args) => coordination.handoffWorkItem(...args),
    acceptHandoff: (...args) => coordination.acceptHandoff(...args),
    rejectHandoff: (...args) => coordination.rejectHandoff(...args),
    cancelHandoff: (...args) => coordination.cancelHandoff(...args),
    listPendingHandoffs: (...args) => coordination.listPendingHandoffs(...args),

    // Playbooks
    createPlaybook: (...args) => playbooks.createPlaybook(...args),
    createPlaybookFromTask: (...args) => playbooks.createPlaybookFromTask(...args),
    revisePlaybook: (...args) => playbooks.revisePlaybook(...args),
    getPlaybook: (...args) => playbooks.getPlaybook(...args),
    listPlaybooks: (...args) => playbooks.listPlaybooks(...args),
    searchPlaybooks: (...args) => playbooks.searchPlaybooks(...args),
    updatePlaybook: (...args) => playbooks.updatePlaybook(...args),
    recordPlaybookUse: (...args) => playbooks.recordPlaybookUse(...args),

    // Graph
    addAssociation: (...args) => graph.addAssociation(...args),
    getAssociations: (...args) => graph.getAssociations(...args),
    traverseAssociations: (...args) => graph.traverseAssociations(...args),
    removeAssociation: (...args) => graph.removeAssociation(...args),
    getGraphReport: (...args) => graph.getGraphReport(...args),
    discover: (...args) => graph.discover(...args),

    // Curation
    inspectKnowledge: (...args) => curationNamespace.inspectKnowledge(...args),
    listKnowledge: (...args) => curationNamespace.listKnowledge(...args),
    getKnowledgeAudits: (...args) => curationNamespace.getKnowledgeAudits(...args),
    getDueReverification: (...args) => curationNamespace.getDueReverification(...args),
    reverifyKnowledge: (...args) => curationNamespace.reverifyKnowledge(...args),
    runReverification: (...args) => curationNamespace.runReverification(...args),
    reembedKnowledge: (...args) => curationNamespace.reembedKnowledge(...args),
    searchEpisodes: (...args) => curationNamespace.searchEpisodes(...args),
    summarizeEpisode: (...args) => curationNamespace.summarizeEpisode(...args),
    searchCognitive: (...args) => curationNamespace.searchCognitive(...args),
    reflectOnKnowledge: (...args) => curationNamespace.reflectOnKnowledge(...args),
    derive: (...args) => curationNamespace.derive(...args),
    getCurationSummary: (...args) => curationNamespace.getCurationSummary(...args),
    getCoreMemory: (...args) => curationNamespace.getCoreMemory(...args),
    ingestDocument: (...args) => curationNamespace.ingestDocument(...args),
    getSourceDocument: (...args) => curationNamespace.getSourceDocument(...args),
    listSourceDocuments: (...args) => curationNamespace.listSourceDocuments(...args),
    exportAsMarkdown: (...args) => curationNamespace.exportAsMarkdown(...args),
    promoteResponse: (...args) => curationNamespace.promoteResponse(...args),
    setAliases: (...args) => curationNamespace.setAliases(...args),
    getAliases: (...args) => curationNamespace.getAliases(...args),
    saveAliases: (...args) => curationNamespace.saveAliases(...args),
    loadAliases: (...args) => curationNamespace.loadAliases(...args),
    getAliasCandidates: (...args) => curationNamespace.getAliasCandidates(...args),
    setOntology: (...args) => curationNamespace.setOntology(...args),
    getOntology: (...args) => curationNamespace.getOntology(...args),
    saveOntology: (...args) => curationNamespace.saveOntology(...args),
    loadOntology: (...args) => curationNamespace.loadOntology(...args),
    exportBundle: (...args) => curationNamespace.exportBundle(...args),
    importBundle: (...args) => curationNamespace.importBundle(...args),
    refreshDocuments: (...args) => curationNamespace.refreshDocuments(...args),
  };
}

