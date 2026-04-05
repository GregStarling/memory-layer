import type { EmbeddingAdapter, EmbeddingVector } from '../contracts/embedding.js';
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type { ContextMode, ContextPolicy } from '../contracts/policy.js';
import { DEFAULT_CONTEXT_POLICY } from '../contracts/policy.js';
import type {
  Association,
  KnowledgeMemory,
  Playbook,
  SearchResult,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../contracts/types.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { estimateTokens, type TokenEstimator } from './tokens.js';
import { emitMemoryEvent } from './telemetry.js';
import { getLineageScore, rankKnowledge } from './retrieval.js';

export interface ContextAssemblyOptions {
  sessionId?: string;
  crossScopeLevel?: ScopeLevel;
  mode?: ContextMode;
  maxKnowledgeItems?: number;
  maxRecentSummaries?: number;
  relevanceQuery?: string;
  tokenBudget?: number;
  queryVector?: EmbeddingVector;
  embeddingAdapter?: EmbeddingAdapter;
  policy?: ContextPolicy;
  logger?: Logger;
  onEvent?: EventHook;
  tokenEstimator?: TokenEstimator;
  asOf?: number;
  associationMinConfidence?: number;
}

export interface KnowledgeSelectionReason {
  knowledgeMemoryId: number;
  bucket: 'trusted_core' | 'task_relevant' | 'provisional' | 'disputed';
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  importanceScore: number;
  trustScore: number;
  classImportanceScore: number;
  diversityPenalty: number;
  finalScore: number;
  explanation: string;
}

export interface MemoryContext {
  mode: ContextMode;
  activeTurns: Turn[];
  workingMemory: WorkingMemory | null;
  trustedCoreMemory: KnowledgeMemory[];
  taskRelevantKnowledge: KnowledgeMemory[];
  provisionalKnowledge: KnowledgeMemory[];
  disputedKnowledge: KnowledgeMemory[];
  relevantKnowledge: KnowledgeMemory[];
  durableKnowledge: KnowledgeMemory[];
  recentSummaries: WorkingMemory[];
  currentObjective: string | null;
  activeObjectives: WorkItem[];
  activeState: string[];
  unresolvedWork: string[];
  relevantPlaybooks?: Playbook[];
  associatedKnowledge: KnowledgeMemory[];
  knowledgeSelectionReasons: KnowledgeSelectionReason[];
  tokenEstimate: number;
}

interface CandidateKnowledge {
  item: KnowledgeMemory;
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  importanceScore: number;
  trustScore: number;
  classImportanceScore: number;
  baseScore: number;
}

function resolveContextPolicy(options?: ContextAssemblyOptions): Required<ContextPolicy> {
  const base = {
    ...DEFAULT_CONTEXT_POLICY,
    ...options?.policy,
    mode: options?.mode ?? options?.policy?.mode ?? DEFAULT_CONTEXT_POLICY.mode,
    maxKnowledgeItems:
      options?.maxKnowledgeItems ??
      options?.policy?.maxKnowledgeItems ??
      DEFAULT_CONTEXT_POLICY.maxKnowledgeItems,
    maxRecentSummaries:
      options?.maxRecentSummaries ??
      options?.policy?.maxRecentSummaries ??
      DEFAULT_CONTEXT_POLICY.maxRecentSummaries,
    tokenBudget:
      options?.tokenBudget ?? options?.policy?.tokenBudget ?? DEFAULT_CONTEXT_POLICY.tokenBudget,
  };
  if (base.mode === 'coding') {
    return {
      ...base,
      lexicalWeight: Math.max(base.lexicalWeight, 1.2),
      importanceWeight: Math.max(base.importanceWeight, 0.4),
    };
  }
  if (base.mode === 'autonomous_agent') {
    return {
      ...base,
      semanticWeight: Math.max(base.semanticWeight, 1.2),
      importanceWeight: Math.max(base.importanceWeight, 0.6),
    };
  }
  if (base.mode === 'review') {
    return {
      ...base,
      lexicalWeight: Math.max(base.lexicalWeight, 1.1),
      importanceWeight: Math.max(base.importanceWeight, 0.5),
    };
  }
  return base;
}

function deriveCurrentObjective(
  workingMemory: WorkingMemory | null,
  activeTurns: Turn[],
): string | null {
  if (workingMemory?.summary) {
    return workingMemory.summary.split(/[.?!]/)[0]?.trim() || null;
  }
  const latestUserTurn = [...activeTurns].reverse().find((turn) => turn.role === 'user');
  return latestUserTurn?.content ?? null;
}

function deriveActiveState(
  workingMemory: WorkingMemory | null,
  activeTurns: Turn[],
): string[] {
  const state = new Set<string>();
  if (workingMemory) {
    for (const entity of workingMemory.key_entities) state.add(`entity:${entity}`);
    for (const tag of workingMemory.topic_tags) state.add(`topic:${tag}`);
  }
  for (const turn of activeTurns.slice(-3)) {
    state.add(`${turn.role}:${turn.content}`);
  }
  return [...state];
}

function deriveUnresolvedWork(
  workingMemory: WorkingMemory | null,
  activeTurns: Turn[],
  relevantKnowledge: KnowledgeMemory[],
  workItems: WorkItem[],
): string[] {
  const unresolved = new Set<string>();
  const unresolvedPattern = /\b(todo|next|follow up|need to|remaining|blocked|pending)\b/i;
  for (const turn of activeTurns) {
    if (unresolvedPattern.test(turn.content)) {
      unresolved.add(turn.content);
    }
  }
  if (workingMemory?.summary && unresolvedPattern.test(workingMemory.summary)) {
    unresolved.add(workingMemory.summary);
  }
  for (const knowledge of relevantKnowledge) {
    if (knowledge.fact_type === 'constraint' || knowledge.fact_type === 'decision') {
      unresolved.add(knowledge.fact);
    }
  }
  for (const item of workItems) {
    if (item.kind === 'unresolved_work' || item.status === 'blocked') {
      unresolved.add(item.title);
    }
  }
  return [...unresolved];
}

function isWorkItemActiveAt(item: WorkItem, asOf: number): boolean {
  return item.created_at <= asOf && !(item.status === 'done' && item.updated_at <= asOf);
}

async function getContextWorkItems(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  asOf?: number,
): Promise<WorkItem[]> {
  if (asOf == null) {
    return adapter.getActiveWorkItems(scope);
  }

  const workItems = await adapter.getWorkItemsByTimeRange(scope, { end_at: asOf });
  return workItems
    .filter((item) => isWorkItemActiveAt(item, asOf))
    .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at || b.id - a.id);
}

function computeContextTokenEstimate(
  activeTurns: Turn[],
  workingMemory: WorkingMemory | null,
  relevantKnowledge: KnowledgeMemory[],
  recentSummaries: WorkingMemory[],
  tokenEstimator: TokenEstimator = estimateTokens,
  playbooks: Playbook[] = [],
  associatedKnowledge: KnowledgeMemory[] = [],
): number {
  const turnTokens = activeTurns.reduce((acc, turn) => acc + turn.token_estimate, 0);
  const workingTokens = workingMemory
    ? tokenEstimator(workingMemory.summary) +
      workingMemory.key_entities.reduce((acc, entity) => acc + tokenEstimator(entity), 0) +
      workingMemory.topic_tags.reduce((acc, tag) => acc + tokenEstimator(tag), 0)
    : 0;
  const knowledgeTokens = relevantKnowledge.reduce(
    (acc, knowledge) => acc + tokenEstimator(knowledge.fact),
    0,
  );
  const summaryTokens = recentSummaries.reduce(
    (acc, summary) => acc + tokenEstimator(summary.summary),
    0,
  );
  const playbookTokens = playbooks.reduce(
    (acc, pb) => acc + tokenEstimator(pb.title) + tokenEstimator(pb.description) + tokenEstimator(pb.instructions),
    0,
  );
  const associatedTokens = associatedKnowledge.reduce(
    (acc, knowledge) => acc + tokenEstimator(knowledge.fact),
    0,
  );

  return turnTokens + workingTokens + knowledgeTokens + summaryTokens + playbookTokens + associatedTokens;
}

function dropLowestPriorityTurn(activeTurns: Turn[]): Turn[] {
  if (activeTurns.length === 0) return activeTurns;
  const removal = [...activeTurns]
    .sort((a, b) => a.priority - b.priority || a.created_at - b.created_at)[0];
  return activeTurns.filter((turn) => turn.id !== removal.id);
}

function normalizeLexicalRanks(results: SearchResult<KnowledgeMemory>[]): Map<number, number> {
  if (results.length === 0) return new Map();
  const maxRank = Math.max(...results.map((result) => result.rank), 1);
  return new Map(results.map((result) => [result.item.id, result.rank / maxRank]));
}

function normalizeSemanticRanks(
  results: Array<{ knowledgeMemoryId: number; similarity: number }>,
): Map<number, number> {
  if (results.length === 0) return new Map();
  const maxSimilarity = Math.max(...results.map((result) => result.similarity), 1);
  return new Map(
    results.map((result) => [result.knowledgeMemoryId, result.similarity / maxSimilarity]),
  );
}

function buildCandidates(
  items: KnowledgeMemory[],
  lexicalRanks: Map<number, number>,
  semanticRanks: Map<number, number>,
  policy: Required<ContextPolicy>,
  scope: MemoryScope,
  relevanceTexts: string[],
  preferLineageMemory: boolean,
): CandidateKnowledge[] {
  const now = Math.floor(Date.now() / 1000);
  return items.map((item) => {
    const lexicalScore = lexicalRanks.get(item.id) ?? 0;
    const semanticScore = semanticRanks.get(item.id) ?? 0;
    const recencyScore =
      item.last_accessed_at > 0
        ? 1 / (1 + Math.max(0, now - item.last_accessed_at) / 86400)
        : 0;
    const importanceScore = Math.min(1, item.access_count / 10);
    const ranking = rankKnowledge({
      knowledge: item,
      lexicalScore,
      semanticScore,
      recencyScore,
      importanceScore,
      policy,
      scope,
      relevanceTexts,
      preferLocalTrusted: true,
      preferLineageMemory,
    });
    return {
      item,
      lexicalScore,
      semanticScore,
      recencyScore,
      importanceScore,
      trustScore: ranking.trustScore,
      classImportanceScore: ranking.classImportanceScore,
      baseScore: ranking.finalScore,
    };
  });
}

function selectKnowledge(
  candidates: CandidateKnowledge[],
  policy: Required<ContextPolicy>,
  bucket: KnowledgeSelectionReason['bucket'],
  limit = policy.maxKnowledgeItems,
): {
  relevantKnowledge: KnowledgeMemory[];
  knowledgeSelectionReasons: KnowledgeSelectionReason[];
} {
  const remaining = [...candidates];
  const selected: CandidateKnowledge[] = [];
  const reasons: KnowledgeSelectionReason[] = [];
  const perTypeCount = new Map<string, number>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const currentTypeCount = perTypeCount.get(candidate.item.fact_type) ?? 0;
      if (currentTypeCount >= policy.maxPerFactType) {
        continue;
      }

      const sameTypePenalty = currentTypeCount * policy.diversityPenalty;
      const sameSlotPenalty = selected.reduce((penalty, existing) => {
        if (
          existing.item.slot_key &&
          candidate.item.slot_key &&
          existing.item.slot_key === candidate.item.slot_key
        ) {
          return penalty + policy.diversityPenalty;
        }
        return penalty;
      }, 0);
      const diversityPenalty = sameTypePenalty + sameSlotPenalty;

      const finalScore = candidate.baseScore - diversityPenalty;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestIndex = i;
        bestPenalty = diversityPenalty;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const [winner] = remaining.splice(bestIndex, 1);
    selected.push(winner);
    perTypeCount.set(winner.item.fact_type, (perTypeCount.get(winner.item.fact_type) ?? 0) + 1);
    reasons.push({
      knowledgeMemoryId: winner.item.id,
      bucket,
      lexicalScore: winner.lexicalScore,
      semanticScore: winner.semanticScore,
      recencyScore: winner.recencyScore,
      importanceScore: winner.importanceScore,
      trustScore: winner.trustScore,
      classImportanceScore: winner.classImportanceScore,
      diversityPenalty: bestPenalty,
      finalScore: bestScore,
      explanation: `${bucket}:${winner.item.knowledge_state}:${winner.item.knowledge_class}`,
    });
  }

  return {
    relevantKnowledge: selected.map((entry) => entry.item),
    knowledgeSelectionReasons: reasons,
  };
}

export async function buildMemoryContext(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options?: ContextAssemblyOptions,
): Promise<MemoryContext> {
  const startedAt = Date.now();
  const normalizedScope = normalizeScope(scope);
  const policy = resolveContextPolicy(options);
  const tokenEstimator = options?.tokenEstimator ?? estimateTokens;
  const asOf = options?.asOf;

  let activeTurns = await adapter.getActiveTurns(normalizedScope, options?.sessionId);
  if (asOf != null) {
    activeTurns = activeTurns.filter((turn) => turn.created_at <= asOf);
  }
  const contextWorkItems = await getContextWorkItems(adapter, normalizedScope, asOf);
  const activeObjectives = contextWorkItems.filter((item) => item.kind === 'objective');
  const workingMemoryCandidates = await adapter.getActiveWorkingMemory(
    normalizedScope,
    options?.sessionId,
  );
  const workingMemory = [...workingMemoryCandidates]
    .filter((item) => asOf == null || item.created_at <= asOf)
    .sort((a, b) => b.id - a.id)[0] ?? null;
  const allWorkingMemory = workingMemoryCandidates.filter((item) => asOf == null || item.created_at <= asOf);
  const recentSummaries = allWorkingMemory
    .filter((summary) => summary.id !== workingMemory?.id)
    .slice(0, policy.maxRecentSummaries);

  const activeKnowledge = options?.crossScopeLevel
    ? await adapter.getActiveKnowledgeCrossScope(normalizedScope, options.crossScopeLevel)
    : await adapter.getActiveKnowledgeMemory(normalizedScope);
  const temporalKnowledge = activeKnowledge.filter((item) => asOf == null || item.created_at <= asOf);
  const lexicalRanks = options?.relevanceQuery
    ? normalizeLexicalRanks(
        options.crossScopeLevel
          ? await adapter.searchKnowledgeCrossScope(
              normalizedScope,
              options.crossScopeLevel,
              options.relevanceQuery,
              {
                limit: policy.maxKnowledgeItems * 2,
                activeOnly: true,
              },
            )
          : await adapter.searchKnowledge(normalizedScope, options.relevanceQuery, {
              limit: policy.maxKnowledgeItems * 2,
              activeOnly: true,
            }),
      )
    : new Map<number, number>();
  let semanticRanks = new Map<number, number>();
  if (options?.embeddingAdapter && options.queryVector) {
    try {
      const semanticResults = options.crossScopeLevel
        ? await options.embeddingAdapter.findSimilarCrossScope(
            normalizedScope,
            options.crossScopeLevel,
            options.queryVector,
            {
              limit: policy.maxKnowledgeItems * 2,
              minSimilarity: policy.semanticMinSimilarity,
            },
          )
        : await options.embeddingAdapter.findSimilar(normalizedScope, options.queryVector, {
            limit: policy.maxKnowledgeItems * 2,
            minSimilarity: policy.semanticMinSimilarity,
          });
      semanticRanks = normalizeSemanticRanks(semanticResults);
    } catch (error) {
      options.logger?.warn?.('memory.context.semantic_search_failed', {
        error: String(error),
      });
    }
  }

  const scopedKnowledge =
    options?.crossScopeLevel && options.crossScopeLevel !== 'scope'
      ? temporalKnowledge.filter(
          (item) =>
            item.scope_id === normalizedScope.scope_id ||
            (normalizedScope.collaboration_id.length > 0 &&
              item.collaboration_id === normalizedScope.collaboration_id) ||
            getLineageScore(normalizedScope.scope_id, item.scope_id) >= policy.minimumLineageScore,
        )
      : temporalKnowledge;
  const relevanceTexts = [
    options?.relevanceQuery ?? '',
    workingMemory?.summary ?? '',
    ...activeObjectives.map((item) => item.title),
  ].filter((value) => value.trim().length > 0);
  const candidates = buildCandidates(
    scopedKnowledge,
    lexicalRanks,
    semanticRanks,
    policy,
    normalizedScope,
    relevanceTexts,
    options?.crossScopeLevel != null && options.crossScopeLevel !== 'scope',
  );
  const trustedCoreClasses = new Set(['identity', 'constraint', 'preference']);
  let trustedCoreMemory = selectKnowledge(
    candidates.filter(
      (candidate) =>
        candidate.item.knowledge_state === 'trusted' &&
        trustedCoreClasses.has(candidate.item.knowledge_class),
    ),
    policy,
    'trusted_core',
    Math.min(policy.trustedCoreLimit, Math.max(3, Math.floor(policy.maxKnowledgeItems / 2))),
  ).relevantKnowledge;
  const trustedCoreIds = new Set(trustedCoreMemory.map((item) => item.id));
  let taskRelevantKnowledge = selectKnowledge(
    candidates.filter(
      (candidate) =>
        candidate.item.knowledge_state === 'trusted' && !trustedCoreIds.has(candidate.item.id),
    ),
    policy,
    'task_relevant',
    Math.min(policy.taskRelevantLimit, Math.max(0, policy.maxKnowledgeItems - trustedCoreMemory.length)),
  ).relevantKnowledge;
  const provisionalKnowledge = selectKnowledge(
    candidates.filter((candidate) => candidate.item.knowledge_state === 'provisional'),
    policy,
    'provisional',
    4,
  ).relevantKnowledge;
  const disputedKnowledge = selectKnowledge(
    candidates.filter((candidate) => candidate.item.knowledge_state === 'disputed'),
    policy,
    'disputed',
    4,
  ).relevantKnowledge;
  let relevantKnowledge = [...trustedCoreMemory, ...taskRelevantKnowledge];
  let knowledgeSelectionReasons = [
    ...selectKnowledge(
      candidates.filter(
        (candidate) =>
          candidate.item.knowledge_state === 'trusted' &&
          trustedCoreClasses.has(candidate.item.knowledge_class),
      ),
      policy,
      'trusted_core',
      trustedCoreMemory.length,
    ).knowledgeSelectionReasons,
    ...selectKnowledge(
      candidates.filter(
        (candidate) =>
          candidate.item.knowledge_state === 'trusted' && !trustedCoreIds.has(candidate.item.id),
      ),
      policy,
      'task_relevant',
      taskRelevantKnowledge.length,
    ).knowledgeSelectionReasons,
    ...selectKnowledge(
      candidates.filter((candidate) => candidate.item.knowledge_state === 'provisional'),
      policy,
      'provisional',
      provisionalKnowledge.length,
    ).knowledgeSelectionReasons,
    ...selectKnowledge(
      candidates.filter((candidate) => candidate.item.knowledge_state === 'disputed'),
      policy,
      'disputed',
      disputedKnowledge.length,
    ).knowledgeSelectionReasons,
  ];

  let relevantPlaybooks: Playbook[] = options?.relevanceQuery
    ? (await adapter.searchPlaybooks(normalizedScope, options.relevanceQuery, { limit: 3, activeOnly: true }))
        .map((hit) => hit.item)
    : [];

  // Single-hop association expansion via supports + related_to edges
  const associationMinConfidence = options?.associationMinConfidence ?? 0.3;
  const selectedIds = new Set(relevantKnowledge.map((k) => k.id));
  const associatedKnowledge: KnowledgeMemory[] = [];
  if (relevantKnowledge.length > 0) {
    const fromPromises = relevantKnowledge.map((k) =>
      adapter.getAssociationsFrom('knowledge', k.id, normalizedScope),
    );
    const toPromises = relevantKnowledge.map((k) =>
      adapter.getAssociationsTo('knowledge', k.id, normalizedScope),
    );
    const [allFromAssocs, allToAssocs] = await Promise.all([
      Promise.all(fromPromises),
      Promise.all(toPromises),
    ]);
    const expandIds = new Set<number>();
    // Outbound: current node is source, neighbor is target
    for (const assocs of allFromAssocs) {
      for (const a of assocs) {
        if (
          (a.association_type === 'supports' || a.association_type === 'related_to') &&
          a.target_kind === 'knowledge' &&
          a.confidence >= associationMinConfidence &&
          !selectedIds.has(a.target_id) &&
          !expandIds.has(a.target_id)
        ) {
          expandIds.add(a.target_id);
        }
      }
    }
    // Inbound: current node is target, neighbor is source
    for (const assocs of allToAssocs) {
      for (const a of assocs) {
        if (
          (a.association_type === 'supports' || a.association_type === 'related_to') &&
          a.source_kind === 'knowledge' &&
          a.confidence >= associationMinConfidence &&
          !selectedIds.has(a.source_id) &&
          !expandIds.has(a.source_id)
        ) {
          expandIds.add(a.source_id);
        }
      }
    }
    for (const targetId of expandIds) {
      const km = await adapter.getKnowledgeMemoryById(targetId);
      if (
        km &&
        km.knowledge_state !== 'retired' &&
        km.knowledge_state !== 'superseded' &&
        km.tenant_id === normalizedScope.tenant_id &&
        km.system_id === normalizedScope.system_id &&
        km.workspace_id === normalizedScope.workspace_id &&
        km.collaboration_id === normalizedScope.collaboration_id &&
        km.scope_id === normalizedScope.scope_id
      ) {
        associatedKnowledge.push(km);
      }
    }
  }

  let trimmedSummaries = [...recentSummaries];
  let trimmedAssociated = [...associatedKnowledge];

  function recomputeTokens() {
    return computeContextTokenEstimate(
      activeTurns, workingMemory, relevantKnowledge, trimmedSummaries,
      tokenEstimator, relevantPlaybooks, trimmedAssociated,
    );
  }

  let tokenEstimate = recomputeTokens();

  while (tokenEstimate > policy.tokenBudget && activeTurns.length > 0) {
    activeTurns = dropLowestPriorityTurn(activeTurns);
    tokenEstimate = recomputeTokens();
  }

  while (tokenEstimate > policy.tokenBudget && trimmedSummaries.length > 0) {
    trimmedSummaries = trimmedSummaries.slice(0, -1);
    tokenEstimate = recomputeTokens();
  }

  // Trim playbooks (procedural guidance) before associated knowledge or core
  // relevant knowledge. A few large playbooks can otherwise push the context
  // over budget after every other lower-priority category has been trimmed.
  // Drop the largest playbook first so we shed bytes aggressively rather
  // than dropping smaller playbooks that may still be useful alongside a
  // single outsized offender.
  while (tokenEstimate > policy.tokenBudget && relevantPlaybooks.length > 0) {
    const sizes = relevantPlaybooks.map((pb) => tokenEstimator(
      `${pb.title}\n${pb.description}\n${pb.instructions}`,
    ));
    let worstIdx = 0;
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i] > sizes[worstIdx]) worstIdx = i;
    }
    relevantPlaybooks = relevantPlaybooks.filter((_, i) => i !== worstIdx);
    tokenEstimate = recomputeTokens();
  }

  // Trim associated knowledge before core relevant knowledge
  while (tokenEstimate > policy.tokenBudget && trimmedAssociated.length > 0) {
    trimmedAssociated = trimmedAssociated.slice(0, -1);
    tokenEstimate = recomputeTokens();
  }

  while (tokenEstimate > policy.tokenBudget && relevantKnowledge.length > 0) {
    relevantKnowledge = relevantKnowledge.slice(0, -1);
    trustedCoreMemory = trustedCoreMemory.filter((item) => relevantKnowledge.some((entry) => entry.id === item.id));
    taskRelevantKnowledge = taskRelevantKnowledge.filter((item) =>
      relevantKnowledge.some((entry) => entry.id === item.id),
    );
    const retainedIds = new Set(relevantKnowledge.map((item) => item.id));
    knowledgeSelectionReasons = knowledgeSelectionReasons.filter((entry) =>
      retainedIds.has(entry.knowledgeMemoryId),
    );
    tokenEstimate = recomputeTokens();
  }

  if (policy.touchSelectedKnowledge) {
    for (const knowledge of relevantKnowledge) {
      await adapter.touchKnowledgeMemory(knowledge.id);
    }
  }

  const currentObjective = deriveCurrentObjective(workingMemory, activeTurns);
  const activeState = deriveActiveState(workingMemory, activeTurns);
  const unresolvedWork = deriveUnresolvedWork(
    workingMemory,
    activeTurns,
    relevantKnowledge,
    contextWorkItems,
  );

  emitMemoryEvent('context_assembly', normalizedScope, options, Date.now() - startedAt, {
    mode: policy.mode,
    activeTurnCount: activeTurns.length,
    workingMemoryId: workingMemory?.id ?? null,
    relevantKnowledgeCount: relevantKnowledge.length,
    recentSummaryCount: trimmedSummaries.length,
    tokenEstimate,
    relevanceQuery: options?.relevanceQuery ?? null,
    crossScopeLevel: options?.crossScopeLevel ?? 'scope',
    currentObjective,
    unresolvedWorkCount: unresolvedWork.length,
    selectionReasons: knowledgeSelectionReasons,
  });

  return {
    mode: policy.mode,
    activeTurns,
    workingMemory,
    trustedCoreMemory,
    taskRelevantKnowledge,
    provisionalKnowledge,
    disputedKnowledge,
    relevantKnowledge,
    durableKnowledge: trustedCoreMemory,
    recentSummaries: trimmedSummaries,
    currentObjective,
    activeObjectives,
    activeState,
    relevantPlaybooks,
    associatedKnowledge: trimmedAssociated,
    unresolvedWork,
    knowledgeSelectionReasons,
    tokenEstimate,
  };
}
