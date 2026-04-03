import type { EmbeddingAdapter, EmbeddingGenerator } from '../contracts/embedding.js';
import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
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
  PaginationOptions,
  PaginatedResult,
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
import { createCircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
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
import type { StructuredGenerationClient } from '../summarizers/client.js';
import { searchEpisodes, summarizeEpisode, reflect } from './episodic.js';
import { searchCognitive } from './cognitive.js';
import { normalizeScope } from '../contracts/identity.js';

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
}

export interface MemoryManager {
  processTurn(role: TurnRole, content: string, actor?: string): Promise<Turn>;
  processExchange(
    userContent: string,
    assistantContent: string,
    actors?: { user?: string; assistant?: string },
  ): Promise<{ userTurn: Turn; assistantTurn: Turn; compactionResult: CompactionResult | null }>;
  getContext(relevanceQuery?: string): Promise<MemoryContext>;
  getContextAt(asOf: number, relevanceQuery?: string): Promise<MemoryContext>;
  getSessionBootstrap(relevanceQuery?: string): Promise<SessionBootstrap>;
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
  ): Promise<WorkItem>;
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
  close(): Promise<void>;
}

function resolveAdapter(config: MemoryManagerConfig): AsyncStorageAdapter {
  if (config.asyncAdapter) {
    return config.asyncAdapter;
  }
  if (config.adapter) {
    return wrapSyncAdapter(config.adapter);
  }
  throw new Error("MemoryManagerConfig requires either 'adapter' or 'asyncAdapter'");
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
    if (!config.embeddingGenerator || input.trim().length === 0) {
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
      return filteredLexical;
    }

    const queryVector = await buildQueryVector(query);
    if (!queryVector) {
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

  async function getContextInternal(relevanceQuery?: string, asOf?: number): Promise<MemoryContext> {
    const activeTurns = await asyncAdapter.getActiveTurns(config.scope, config.sessionId);
    const queryVector = await buildQueryVector(
      relevanceQuery ??
        activeTurns
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
      logger: config.logger,
      onEvent,
    });
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

  async function insertManagedTurn(role: TurnRole, content: string, actor: string): Promise<Turn> {
    const redactedContent = config.redactText ? config.redactText({ kind: 'turn', text: content }) : content;
    const turn = await asyncAdapter.insertTurn({
      ...config.scope,
      session_id: config.sessionId,
      actor,
      role,
      content: redactedContent,
      token_estimate: tokenEstimator(redactedContent),
    });

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
      const userTurn = await insertManagedTurn('user', userContent, actors?.user ?? 'user');
      const assistantTurn = await insertManagedTurn(
        'assistant',
        assistantContent,
        actors?.assistant ?? 'assistant',
      );
      const compactionResult = autoCompact
        ? await runCompaction(await asyncAdapter.getActiveTurns(config.scope, config.sessionId))
        : null;
      return {
        userTurn,
        assistantTurn,
        compactionResult,
      };
    },

    async getContext(relevanceQuery) {
      return getContextInternal(relevanceQuery);
    },

    async getContextAt(asOf, relevanceQuery) {
      return getContextInternal(relevanceQuery, asOf);
    },

    async getSessionBootstrap(relevanceQuery) {
      const context = await getContextInternal(relevanceQuery);
      return {
        currentObjective: context.currentObjective,
        workingMemory: context.workingMemory,
        relevantKnowledge: context.relevantKnowledge,
        recentSummaries: context.recentSummaries,
        activeObjectives: context.activeObjectives,
        unresolvedWork: context.unresolvedWork,
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

    async trackWorkItem(title, kind = 'objective', status = 'open', detail) {
      return asyncAdapter.insertWorkItem({
        ...config.scope,
        session_id: config.sessionId,
        title: config.redactText ? config.redactText({ kind: 'work_item', text: title }) : title,
        kind,
        status,
        detail:
          detail && config.redactText
            ? config.redactText({ kind: 'work_item', text: detail })
            : detail,
      });
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
        throw new Error(`Memory validation: knowledge memory ${id} was not found`);
      }
      if (!knowledgeMatchesScope(knowledge, config.scope)) {
        throw new Error(`Memory validation: knowledge memory ${id} does not belong to the requested scope`);
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
        throw new Error('searchEpisodes requires a structuredClient in MemoryManagerConfig');
      }
      return searchEpisodes(
        { adapter: asyncAdapter, scope: config.scope, client: config.structuredClient },
        options,
      );
    },

    async summarizeEpisode(sessionId, options) {
      if (!config.structuredClient) {
        throw new Error('summarizeEpisode requires a structuredClient in MemoryManagerConfig');
      }
      const detailLevel = options?.detailLevel ?? 'overview';
      // Fetch both active and all session working memories to include post-compaction data
      const activeTurns = await asyncAdapter.getActiveTurns(config.scope, sessionId);
      const allSessionWm = await asyncAdapter.getWorkingMemoryBySession(sessionId, config.scope);
      // If active turns are empty (compacted), retrieve archived turns from working memory turn ranges
      let turns = activeTurns;
      if (turns.length === 0 && allSessionWm.length > 0) {
        const minStart = Math.min(...allSessionWm.map((wm) => wm.turn_id_start));
        const maxEnd = Math.max(...allSessionWm.map((wm) => wm.turn_id_end));
        turns = await asyncAdapter.getArchivedTurnRange(sessionId, minStart, maxEnd, config.scope);
      }
      return summarizeEpisode(
        { adapter: asyncAdapter, scope: config.scope, client: config.structuredClient },
        { turns, workingMemories: allSessionWm, sessionId, detailLevel, client: config.structuredClient },
      );
    },

    async reflect(options) {
      if (!config.structuredClient) {
        throw new Error('reflect requires a structuredClient in MemoryManagerConfig');
      }
      return reflect(
        { adapter: asyncAdapter, scope: config.scope, client: config.structuredClient },
        options,
      );
    },

    async searchCognitive(options) {
      return searchCognitive(asyncAdapter, config.scope, options);
    },

    async close() {
      await asyncAdapter.close();
    },
  };
}
