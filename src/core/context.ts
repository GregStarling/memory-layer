import type { EmbeddingAdapter, EmbeddingVector } from '../contracts/embedding.js';
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type { ContextMode, ContextPolicy } from '../contracts/policy.js';
import { DEFAULT_CONTEXT_POLICY } from '../contracts/policy.js';
import type {
  KnowledgeMemory,
  SearchResult,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../contracts/types.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { estimateTokens, type TokenEstimator } from './tokens.js';
import { emitMemoryEvent } from './telemetry.js';

export interface ContextAssemblyOptions {
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
}

export interface KnowledgeSelectionReason {
  knowledgeMemoryId: number;
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  importanceScore: number;
  diversityPenalty: number;
  finalScore: number;
}

export interface MemoryContext {
  mode: ContextMode;
  activeTurns: Turn[];
  workingMemory: WorkingMemory | null;
  relevantKnowledge: KnowledgeMemory[];
  durableKnowledge: KnowledgeMemory[];
  recentSummaries: WorkingMemory[];
  currentObjective: string | null;
  activeObjectives: WorkItem[];
  activeState: string[];
  unresolvedWork: string[];
  knowledgeSelectionReasons: KnowledgeSelectionReason[];
  tokenEstimate: number;
}

interface CandidateKnowledge {
  item: KnowledgeMemory;
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  importanceScore: number;
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

function computeContextTokenEstimate(
  activeTurns: Turn[],
  workingMemory: WorkingMemory | null,
  relevantKnowledge: KnowledgeMemory[],
  recentSummaries: WorkingMemory[],
  tokenEstimator: TokenEstimator = estimateTokens,
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

  return turnTokens + workingTokens + knowledgeTokens + summaryTokens;
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
    return {
      item,
      lexicalScore,
      semanticScore,
      recencyScore,
      importanceScore,
      baseScore:
        lexicalScore * policy.lexicalWeight +
        semanticScore * policy.semanticWeight +
        recencyScore * policy.recencyWeight +
        importanceScore * policy.importanceWeight,
    };
  });
}

function selectKnowledge(
  candidates: CandidateKnowledge[],
  policy: Required<ContextPolicy>,
): {
  relevantKnowledge: KnowledgeMemory[];
  knowledgeSelectionReasons: KnowledgeSelectionReason[];
} {
  const remaining = [...candidates];
  const selected: CandidateKnowledge[] = [];
  const reasons: KnowledgeSelectionReason[] = [];
  const perTypeCount = new Map<string, number>();

  while (remaining.length > 0 && selected.length < policy.maxKnowledgeItems) {
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
      lexicalScore: winner.lexicalScore,
      semanticScore: winner.semanticScore,
      recencyScore: winner.recencyScore,
      importanceScore: winner.importanceScore,
      diversityPenalty: bestPenalty,
      finalScore: bestScore,
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

  let activeTurns = await adapter.getActiveTurns(normalizedScope);
  if (asOf != null) {
    activeTurns = activeTurns.filter((turn) => turn.created_at <= asOf);
  }
  const activeObjectives = (await adapter.getActiveWorkItems(normalizedScope)).filter(
    (item) => item.kind === 'objective',
  );
  const workingMemoryCandidates = await adapter.getActiveWorkingMemory(normalizedScope);
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
  const semanticRanks =
    options?.embeddingAdapter && options.queryVector
      ? normalizeSemanticRanks(
          options.crossScopeLevel
            ? options.embeddingAdapter.findSimilarCrossScope(
                normalizedScope,
                options.crossScopeLevel,
                options.queryVector,
                {
                  limit: policy.maxKnowledgeItems * 2,
                  minSimilarity: 0,
                },
              )
            : options.embeddingAdapter.findSimilar(normalizedScope, options.queryVector, {
                limit: policy.maxKnowledgeItems * 2,
                minSimilarity: 0,
              }),
        )
      : new Map<number, number>();

  let { relevantKnowledge, knowledgeSelectionReasons } = selectKnowledge(
    buildCandidates(temporalKnowledge, lexicalRanks, semanticRanks, policy),
    policy,
  );

  let trimmedSummaries = [...recentSummaries];
  let tokenEstimate = computeContextTokenEstimate(
    activeTurns,
    workingMemory,
    relevantKnowledge,
    trimmedSummaries,
    tokenEstimator,
  );

  while (tokenEstimate > policy.tokenBudget && activeTurns.length > 0) {
    activeTurns = dropLowestPriorityTurn(activeTurns);
    tokenEstimate = computeContextTokenEstimate(
      activeTurns,
      workingMemory,
      relevantKnowledge,
      trimmedSummaries,
      tokenEstimator,
    );
  }

  while (tokenEstimate > policy.tokenBudget && trimmedSummaries.length > 0) {
    trimmedSummaries = trimmedSummaries.slice(0, -1);
    tokenEstimate = computeContextTokenEstimate(
      activeTurns,
      workingMemory,
      relevantKnowledge,
      trimmedSummaries,
      tokenEstimator,
    );
  }

  while (tokenEstimate > policy.tokenBudget && relevantKnowledge.length > 0) {
    relevantKnowledge = relevantKnowledge.slice(0, -1);
    const retainedIds = new Set(relevantKnowledge.map((item) => item.id));
    knowledgeSelectionReasons = knowledgeSelectionReasons.filter((entry) =>
      retainedIds.has(entry.knowledgeMemoryId),
    );
    tokenEstimate = computeContextTokenEstimate(
      activeTurns,
      workingMemory,
      relevantKnowledge,
      trimmedSummaries,
      tokenEstimator,
    );
  }

  if (policy.touchSelectedKnowledge) {
    for (const knowledge of relevantKnowledge) {
      await adapter.touchKnowledgeMemory(knowledge.id);
    }
  }

  const currentObjective = deriveCurrentObjective(workingMemory, activeTurns);
  const activeState = deriveActiveState(workingMemory, activeTurns);
  const allWorkItems = await adapter.getActiveWorkItems(normalizedScope);
  const unresolvedWork = deriveUnresolvedWork(
    workingMemory,
    activeTurns,
    relevantKnowledge,
    allWorkItems,
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
    relevantKnowledge,
    durableKnowledge: relevantKnowledge,
    recentSummaries: trimmedSummaries,
    currentObjective,
    activeObjectives,
    activeState,
    unresolvedWork,
    knowledgeSelectionReasons,
    tokenEstimate,
  };
}
