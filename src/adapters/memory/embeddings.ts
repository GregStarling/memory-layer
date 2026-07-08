import type {
  EmbeddingAdapter,
  EmbeddingCoverage,
  EmbeddingMetadata,
  EmbeddingQueryFilter,
  EmbeddingVector,
  SimilarEmbeddingResult,
} from '../../contracts/embedding.js';
import type { MemoryScope, ScopeLevel } from '../../contracts/identity.js';
import type { StorageAdapter } from '../../contracts/storage.js';

interface StoredVector {
  vector: EmbeddingVector;
  model: string;
  dimensions: number;
}

function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A stored vector participates in a similarity query only when its metadata
 * matches the active provider filter (Phase 2.4, D2). `dimensions` must match
 * when the filter supplies it. Model filtering applies ONLY when the ACTIVE
 * (filter) model is KNOWN — a filter model of `'unknown'`/absent means the
 * manager has no configured model, so we filter by dimensions alone (otherwise
 * a real-model vector would be wrongly excluded, killing semantic search). When
 * the filter model is known, a stored vector is excluded if its own model is
 * known and differs; a stored `'unknown'` vector still surfaces if dimensions
 * agree so pre-versioning data isn't lost. This mirrors the SQL
 * `WHERE dimensions = ? [AND (model = ? OR model = 'unknown')]` contract.
 */
function matchesFilter(stored: StoredVector, filter?: EmbeddingQueryFilter): boolean {
  if (!filter) return true;
  if (filter.dimensions != null && stored.dimensions !== filter.dimensions) return false;
  if (
    filter.model != null &&
    filter.model !== 'unknown' &&
    stored.model !== 'unknown' &&
    stored.model !== filter.model
  ) {
    return false;
  }
  return true;
}

export function createInMemoryEmbeddingAdapter(adapter: StorageAdapter): EmbeddingAdapter {
  const vectors = new Map<number, StoredVector>();

  function scoreKnowledge(
    knowledgeIds: number[],
    queryVector: EmbeddingVector,
    limit: number,
    minSimilarity: number,
    filter?: EmbeddingQueryFilter,
  ): SimilarEmbeddingResult[] {
    return knowledgeIds
      .map((knowledgeMemoryId) => ({ knowledgeMemoryId, stored: vectors.get(knowledgeMemoryId) }))
      // Exclude mismatched vectors BEFORE any distance comparison.
      .filter((entry) => entry.stored != null && matchesFilter(entry.stored, filter))
      .map((entry) => ({
        knowledgeMemoryId: entry.knowledgeMemoryId,
        similarity: cosineSimilarity(queryVector, entry.stored!.vector),
      }))
      .filter((result) => result.similarity >= minSimilarity)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit);
  }

  return {
    storeEmbedding(knowledgeMemoryId, vector, metadata?: EmbeddingMetadata): void {
      vectors.set(knowledgeMemoryId, {
        vector: new Float32Array(vector),
        model: metadata?.model ?? 'unknown',
        dimensions: metadata?.dimensions ?? vector.length,
      });
    },

    getEmbedding(knowledgeMemoryId): EmbeddingVector | null {
      const stored = vectors.get(knowledgeMemoryId);
      return stored ? new Float32Array(stored.vector) : null;
    },

    getEmbeddingMetadata(knowledgeMemoryId): EmbeddingMetadata | null {
      const stored = vectors.get(knowledgeMemoryId);
      return stored ? { model: stored.model, dimensions: stored.dimensions } : null;
    },

    findSimilar(
      scope: MemoryScope,
      queryVector: EmbeddingVector,
      options?: { limit?: number; minSimilarity?: number; filter?: EmbeddingQueryFilter },
    ): SimilarEmbeddingResult[] {
      const limit = options?.limit ?? 10;
      const minSimilarity = options?.minSimilarity ?? 0;
      const ids = adapter.getActiveKnowledgeMemory(scope).map((item) => item.id);
      return scoreKnowledge(ids, queryVector, limit, minSimilarity, options?.filter);
    },

    findSimilarCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      queryVector: EmbeddingVector,
      options?: { limit?: number; minSimilarity?: number; filter?: EmbeddingQueryFilter },
    ): SimilarEmbeddingResult[] {
      const limit = options?.limit ?? 10;
      const minSimilarity = options?.minSimilarity ?? 0;
      const ids = adapter.getActiveKnowledgeCrossScope(scope, level).map((item) => item.id);
      return scoreKnowledge(ids, queryVector, limit, minSimilarity, options?.filter);
    },

    deleteEmbedding(knowledgeMemoryId, scope): void {
      if (scope) {
        const knowledge = adapter.getKnowledgeMemoryById(knowledgeMemoryId);
        if (
          !knowledge ||
          knowledge.tenant_id !== scope.tenant_id ||
          knowledge.system_id !== scope.system_id ||
          (knowledge.workspace_id ?? '') !== (scope.workspace_id ?? 'default') ||
          (knowledge.collaboration_id ?? '') !== (scope.collaboration_id ?? '') ||
          knowledge.scope_id !== scope.scope_id
        ) {
          return;
        }
      }
      vectors.delete(knowledgeMemoryId);
    },

    getEmbeddingCoverage(scope: MemoryScope, filter: EmbeddingQueryFilter): EmbeddingCoverage {
      const ids = adapter.getActiveKnowledgeMemory(scope).map((item) => item.id);
      let total = 0;
      let matching = 0;
      for (const id of ids) {
        const stored = vectors.get(id);
        if (!stored) continue;
        total += 1;
        if (matchesFilter(stored, filter)) matching += 1;
      }
      return { total, matching, mismatched: total - matching };
    },
  };
}
