import type { EmbeddingAdapter, EmbeddingGenerator } from '../contracts/embedding.js';
import type {
  ActorRef,
  ContextViewPolicy,
  HandoffRecord,
  WorkClaim,
  WorkItemPatch,
} from '../contracts/coordination.js';
import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import {
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
import { buildMemoryContext, type MemoryContext } from './context.js';
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
  MemoryEventEntityKind,
  MemoryEventRecord,
  TemporalStateDiff,
  TemporalStateSnapshot,
  TimelineResult,
} from '../contracts/temporal.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';
import { searchEpisodes, summarizeEpisode, reflect } from './episodic.js';
import { searchCognitive } from './cognitive.js';
import { traverseAssociations, type AssociationGraph } from './associations.js';
import type { Profile, ProfileOptions } from '../contracts/profile.js';
import { getProfile } from './profile.js';
import {
  createPlaybookFromTask,
  revisePlaybook,
  findRelevantPlaybooks,
  type CreatePlaybookFromTaskInput,
} from './playbook.js';
import { normalizeScope } from '../contracts/identity.js';
import {
  createTemporalReplayAdapter,
  foldTemporalState,
  listAllMemoryEvents,
} from './temporal.js';

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
  logger?: Logger;
  onEvent?: EventHook;
  eventEmitter?: MemoryEventEmitter;
  monitorPolicy?: MonitorPolicy;
  extractionPolicy?: ExtractionPolicy;
  contextPolicy?: ContextPolicy;
  maintenancePolicy?: MaintenancePolicy;
  crossScopeLevel?: ScopeLevel;
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
    options?: {
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
    },
  ): Promise<MemoryContext>;
  getContextAt(
    asOf: number,
    relevanceQuery?: string,
    options?: {
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
    },
  ): Promise<MemoryContext>;
  getStateAt(
    asOf: number,
    options?: {
      relevanceQuery?: string;
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
    },
  ): Promise<TemporalStateSnapshot<MemoryContext>>;
  getTimeline(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: number;
  }): Promise<TimelineResult>;
  diffState(
    from: number,
    to: number,
    options?: { sessionId?: string; entityKind?: MemoryEventEntityKind; entityId?: string },
  ): Promise<TemporalStateDiff>;
  listMemoryEvents(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: number;
  }): Promise<TimelineResult>;
  getSessionBootstrap(
    relevanceQuery?: string,
    options?: {
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
    },
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
  pollForChanges(since: Date, options?: { scopeLevel?: ScopeLevel }): Promise<KnowledgeMemory[]>;
  forceCompact(): Promise<CompactionResult | null>;
  learnFact(fact: string, factType: FactType, confidence?: FactConfidence): Promise<KnowledgeMemory>;
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
    cursor?: number;
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): AsyncIterable<MemoryEventRecord>;
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
          await config.embeddingAdapter!.storeEmbedding(item.id, vector);
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

    let semantic: Array<{ knowledgeMemoryId: number; similarity: number }>;
    try {
      semantic =
        level === 'scope'
          ? await config.embeddingAdapter.findSimilar(config.scope, queryVector, {
              limit: options?.limit ?? 10,
              minSimilarity: resolvedContextPolicy.semanticMinSimilarity,
            })
          : await config.embeddingAdapter.findSimilarCrossScope(config.scope, level, queryVector, {
              limit: options?.limit ?? 10,
              minSimilarity: resolvedContextPolicy.semanticMinSimilarity,
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
    for (const result of semantic) {
      const knowledge = await asyncAdapter.getKnowledgeMemoryById(result.knowledgeMemoryId);
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
      for (const result of results) {
        await asyncAdapter.touchKnowledgeMemory(result.item.id);
      }
    }

    return results;
  }

  async function getContextInternal(
    relevanceQuery?: string,
    asOf?: number,
    options?: {
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
    },
  ): Promise<MemoryContext> {
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
      crossScopeLevel: config.crossScopeLevel,
      policy: config.contextPolicy,
      tokenEstimator,
      asOf,
      view: options?.view,
      viewer: options?.viewer,
      includeCoordinationState: options?.includeCoordinationState,
      logger: config.logger,
      onEvent,
    });
  }

  async function getTemporalCutoverAt(): Promise<number | null> {
    const watermark = await asyncAdapter.getTemporalWatermark('temporal');
    return watermark?.cutover_at ?? null;
  }

  async function buildReplayedContext(
    asOf: number,
    relevanceQuery?: string,
    options?: {
      view?: ContextViewPolicy;
      viewer?: ActorRef;
      includeCoordinationState?: boolean;
    },
  ): Promise<{
    context: MemoryContext;
    events: MemoryEventRecord[];
    watermarkEventId: number | null;
    exact: boolean;
    cutoverAt: number | null;
  }> {
    const cutoverAt = await getTemporalCutoverAt();
    if (cutoverAt == null || asOf < cutoverAt) {
      return {
        context: await getContextInternal(relevanceQuery, asOf, options),
        events: [],
        watermarkEventId: null,
        exact: false,
        cutoverAt,
      };
    }

    const events = await listAllMemoryEvents(asyncAdapter, config.scope, {
      endAt: asOf,
      limit: 500,
    });
    const replayed = foldTemporalState(events, { sessionId: config.sessionId });
    const replayAdapter = createTemporalReplayAdapter(replayed, asOf);
    const inferredQuery =
      relevanceQuery ??
      replayed.turns
        .slice(-4)
        .map((turn) => turn.content)
        .join('\n');
    const queryVector = await buildQueryVector(inferredQuery);
    const context = await buildMemoryContext(replayAdapter, config.scope, {
      sessionId: config.sessionId,
      relevanceQuery,
      queryVector,
      embeddingAdapter: config.embeddingAdapter,
      crossScopeLevel: config.crossScopeLevel,
      policy: config.contextPolicy,
      tokenEstimator,
      view: options?.view,
      viewer: options?.viewer,
      includeCoordinationState: options?.includeCoordinationState,
      logger: config.logger,
      onEvent,
    });
    return {
      context,
      events,
      watermarkEventId: replayed.watermarkEventId,
      exact: true,
      cutoverAt,
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
            },
          ),
        () => [] as KnowledgeMemory[],
      );
      await maybeEmbedKnowledge(extracted);
        extracted.forEach((knowledge) => emitKnowledgeChange('promoted', knowledge));
    }

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

    async getStateAt(asOf, options) {
      const replay = await buildReplayedContext(asOf, options?.relevanceQuery, options);
      const replayed = replay.exact
        ? foldTemporalState(replay.events, { sessionId: config.sessionId })
        : {
            turns: replay.context.activeTurns,
            workingMemory: [
              ...replay.context.recentSummaries,
              ...(replay.context.workingMemory ? [replay.context.workingMemory] : []),
            ].sort((a, b) => a.created_at - b.created_at || a.id - b.id),
            knowledge: [
              ...new Map(
                [
                  ...replay.context.trustedCoreMemory,
                  ...replay.context.taskRelevantKnowledge,
                  ...replay.context.provisionalKnowledge,
                  ...replay.context.disputedKnowledge,
                  ...replay.context.associatedKnowledge,
                ].map((item) => [item.id, item]),
              ).values(),
            ],
            workItems: replay.context.activeObjectives,
            workClaims: replay.context.coordinationState?.ownedClaims ?? [],
            handoffs: [
              ...(replay.context.coordinationState?.pendingInboundHandoffs ?? []),
              ...(replay.context.coordinationState?.pendingOutboundHandoffs ?? []),
            ],
            associations: [],
            playbooks: replay.context.relevantPlaybooks ?? [],
            sessionStates: [],
            watermarkEventId: null,
          };
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
      const timeline = await asyncAdapter.listMemoryEvents(config.scope, {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: from + 1,
        endAt: to,
        limit: 500,
      });
      const events = timeline.events;
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
      const profile = await getProfile(asyncAdapter, config.scope);
      return {
        currentObjective: context.currentObjective,
        sessionState: context.sessionState,
        workingMemory: context.workingMemory,
        relevantKnowledge: context.relevantKnowledge,
        recentSummaries: context.recentSummaries,
        activeObjectives: context.activeObjectives,
        unresolvedWork: context.unresolvedWork,
        coordinationState: context.coordinationState,
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

    async pollForChanges(since, options) {
      return asyncAdapter.getKnowledgeSince(
        config.scope,
        options?.scopeLevel ?? config.crossScopeLevel ?? 'scope',
        Math.floor(since.valueOf() / 1000),
      );
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

    async learnFact(fact, factType, confidence = 'high') {
      const knowledge = await asyncAdapter.insertKnowledgeMemory({
        ...config.scope,
        fact: config.redactText ? config.redactText({ kind: 'fact', text: fact }) : fact,
        fact_type: factType,
        knowledge_class: manualKnowledgeClassForFactType(factType),
        source: 'manual',
        confidence,
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
      return asyncAdapter.insertWorkItem({
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
    },

    async updateWorkItem(id, patch, options) {
      return asyncAdapter.updateWorkItem(id, patch, options);
    },

    async claimWorkItem(input) {
      const workItem = await asyncAdapter.getWorkItemById(input.workItemId);
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
      return asyncAdapter.renewWorkClaim(claimId, actor, leaseSeconds);
    },

    async releaseWorkClaim(claimId, actor, reason) {
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
      return asyncAdapter.acceptHandoff(handoffId, actor, reason);
    },

    async rejectHandoff(handoffId, actor, reason) {
      return asyncAdapter.rejectHandoff(handoffId, actor, reason);
    },

    async cancelHandoff(handoffId, actor, reason) {
      return asyncAdapter.cancelHandoff(handoffId, actor, reason);
    },

    async listPendingHandoffs(options) {
      return asyncAdapter.listHandoffs(config.scope, {
        actor: options?.actor,
        direction: options?.direction,
        statuses: ['pending'],
      });
    },

    async *streamChanges(options) {
      let cursor =
        options?.cursor ??
        (await asyncAdapter.getTemporalWatermark('temporal'))?.last_event_id ??
        0;
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
        reverifiedKnowledgeCount: report.reverifiedKnowledgeIds.length,
        demotedKnowledgeCount: report.demotedKnowledgeIds.length,
      });
      return report;
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
      return asyncAdapter.insertAssociation({
        ...input,
        ...norm,
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

    async close() {
      if (config.closeAdapter !== false) {
        await asyncAdapter.close();
      }
    },
  };
}
