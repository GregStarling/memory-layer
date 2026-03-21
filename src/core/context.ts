import type { EmbeddingAdapter, EmbeddingVector } from '../contracts/embedding.js';
import { normalizeScope, type MemoryScope } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type { ContextPolicy } from '../contracts/policy.js';
import { DEFAULT_CONTEXT_POLICY } from '../contracts/policy.js';
import type {
  KnowledgeMemory,
  SearchResult,
  WorkingMemory,
  Turn,
} from '../contracts/types.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { estimateTokens } from './tokens.js';
import { emitMemoryEvent } from './telemetry.js';

export interface ContextAssemblyOptions {
  maxKnowledgeItems?: number;
  maxRecentSummaries?: number;
  relevanceQuery?: string;
  tokenBudget?: number;
  queryVector?: EmbeddingVector;
  embeddingAdapter?: EmbeddingAdapter;
  policy?: ContextPolicy;
  logger?: Logger;
  onEvent?: EventHook;
}

export interface MemoryContext {
  activeTurns: Turn[];
  workingMemory: WorkingMemory | null;
  relevantKnowledge: KnowledgeMemory[];
  recentSummaries: WorkingMemory[];
  tokenEstimate: number;
}

interface RankedKnowledge {
  item: KnowledgeMemory;
  score: number;
}

function resolveContextPolicy(options?: ContextAssemblyOptions): Required<ContextPolicy> {
  return {
    ...DEFAULT_CONTEXT_POLICY,
    ...options?.policy,
    maxKnowledgeItems: options?.maxKnowledgeItems ?? options?.policy?.maxKnowledgeItems ?? DEFAULT_CONTEXT_POLICY.maxKnowledgeItems,
    maxRecentSummaries: options?.maxRecentSummaries ?? options?.policy?.maxRecentSummaries ?? DEFAULT_CONTEXT_POLICY.maxRecentSummaries,
    tokenBudget: options?.tokenBudget ?? options?.policy?.tokenBudget ?? DEFAULT_CONTEXT_POLICY.tokenBudget,
  };
}

function computeContextTokenEstimate(
  activeTurns: Turn[],
  workingMemory: WorkingMemory | null,
  relevantKnowledge: KnowledgeMemory[],
  recentSummaries: WorkingMemory[],
): number {
  const turnTokens = activeTurns.reduce((acc, turn) => acc + turn.token_estimate, 0);
  const workingTokens = workingMemory
    ? estimateTokens(workingMemory.summary) +
      workingMemory.key_entities.reduce((acc, entity) => acc + estimateTokens(entity), 0) +
      workingMemory.topic_tags.reduce((acc, tag) => acc + estimateTokens(tag), 0)
    : 0;
  const knowledgeTokens = relevantKnowledge.reduce(
    (acc, knowledge) => acc + estimateTokens(knowledge.fact),
    0,
  );
  const summaryTokens = recentSummaries.reduce(
    (acc, summary) => acc + estimateTokens(summary.summary),
    0,
  );

  return turnTokens + workingTokens + knowledgeTokens + summaryTokens;
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
  return new Map(results.map((result) => [result.knowledgeMemoryId, result.similarity / maxSimilarity]));
}

function scoreKnowledge(
  items: KnowledgeMemory[],
  lexicalRanks: Map<number, number>,
  semanticRanks: Map<number, number>,
  policy: Required<ContextPolicy>,
): RankedKnowledge[] {
  const now = Math.floor(Date.now() / 1000);
  return items.map((item) => {
    const lexical = lexicalRanks.get(item.id) ?? 0;
    const semantic = semanticRanks.get(item.id) ?? 0;
    const recency = item.last_accessed_at > 0 ? 1 / (1 + Math.max(0, now - item.last_accessed_at) / 86400) : 0;
    const importance = Math.min(1, item.access_count / 10);
    return {
      item,
      score:
        lexical * policy.lexicalWeight +
        semantic * policy.semanticWeight +
        recency * policy.recencyWeight +
        importance * policy.importanceWeight,
    };
  });
}

export function buildMemoryContext(
  adapter: StorageAdapter,
  scope: MemoryScope,
  options?: ContextAssemblyOptions,
): MemoryContext {
  const startedAt = Date.now();
  const normalizedScope = normalizeScope(scope);
  const policy = resolveContextPolicy(options);

  let activeTurns = adapter.getActiveTurns(normalizedScope);
  const workingMemory = adapter.getLatestWorkingMemory(normalizedScope);
  const recentSummaries = adapter
    .getActiveWorkingMemory(normalizedScope)
    .filter((summary) => summary.id !== workingMemory?.id)
    .slice(0, policy.maxRecentSummaries);

  const activeKnowledge = adapter.getActiveKnowledgeMemory(normalizedScope);
  const lexicalRanks = options?.relevanceQuery
    ? normalizeLexicalRanks(
        adapter.searchKnowledge(normalizedScope, options.relevanceQuery, {
          limit: policy.maxKnowledgeItems * 2,
          activeOnly: true,
        }),
      )
    : new Map<number, number>();
  const semanticRanks =
    options?.embeddingAdapter && options.queryVector
      ? normalizeSemanticRanks(
          options.embeddingAdapter.findSimilar(normalizedScope, options.queryVector, {
            limit: policy.maxKnowledgeItems * 2,
            minSimilarity: 0,
          }),
        )
      : new Map<number, number>();

  let relevantKnowledge = scoreKnowledge(activeKnowledge, lexicalRanks, semanticRanks, policy)
    .sort((a, b) => b.score - a.score || b.item.last_accessed_at - a.item.last_accessed_at)
    .slice(0, policy.maxKnowledgeItems)
    .map((entry) => entry.item);

  let trimmedSummaries = [...recentSummaries];
  let tokenEstimate = computeContextTokenEstimate(
    activeTurns,
    workingMemory,
    relevantKnowledge,
    trimmedSummaries,
  );

  while (tokenEstimate > policy.tokenBudget && activeTurns.length > 0) {
    activeTurns = activeTurns.slice(1);
    tokenEstimate = computeContextTokenEstimate(
      activeTurns,
      workingMemory,
      relevantKnowledge,
      trimmedSummaries,
    );
  }

  while (tokenEstimate > policy.tokenBudget && trimmedSummaries.length > 0) {
    trimmedSummaries = trimmedSummaries.slice(0, -1);
    tokenEstimate = computeContextTokenEstimate(
      activeTurns,
      workingMemory,
      relevantKnowledge,
      trimmedSummaries,
    );
  }

  while (tokenEstimate > policy.tokenBudget && relevantKnowledge.length > 0) {
    relevantKnowledge = relevantKnowledge.slice(0, -1);
    tokenEstimate = computeContextTokenEstimate(
      activeTurns,
      workingMemory,
      relevantKnowledge,
      trimmedSummaries,
    );
  }

  emitMemoryEvent('context_assembly', normalizedScope, options, Date.now() - startedAt, {
    activeTurnCount: activeTurns.length,
    workingMemoryId: workingMemory?.id ?? null,
    relevantKnowledgeCount: relevantKnowledge.length,
    recentSummaryCount: trimmedSummaries.length,
    tokenEstimate,
    relevanceQuery: options?.relevanceQuery ?? null,
  });

  return {
    activeTurns,
    workingMemory,
    relevantKnowledge,
    recentSummaries: trimmedSummaries,
    tokenEstimate,
  };
}
