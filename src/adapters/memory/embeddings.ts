import type { EmbeddingAdapter, EmbeddingVector, SimilarEmbeddingResult } from '../../contracts/embedding.js';
import type { MemoryScope, ScopeLevel } from '../../contracts/identity.js';
import type { StorageAdapter } from '../../contracts/storage.js';

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

export function createInMemoryEmbeddingAdapter(adapter: StorageAdapter): EmbeddingAdapter {
  const vectors = new Map<number, EmbeddingVector>();

  function scoreKnowledge(
    knowledgeIds: number[],
    queryVector: EmbeddingVector,
    limit: number,
    minSimilarity: number,
  ): SimilarEmbeddingResult[] {
    return knowledgeIds
      .map((knowledgeMemoryId) => ({
        knowledgeMemoryId,
        similarity: cosineSimilarity(queryVector, vectors.get(knowledgeMemoryId) ?? new Float32Array()),
      }))
      .filter((result) => result.similarity >= minSimilarity)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit);
  }

  return {
    storeEmbedding(knowledgeMemoryId, vector): void {
      vectors.set(knowledgeMemoryId, new Float32Array(vector));
    },

    getEmbedding(knowledgeMemoryId): EmbeddingVector | null {
      const vector = vectors.get(knowledgeMemoryId);
      return vector ? new Float32Array(vector) : null;
    },

    findSimilar(
      scope: MemoryScope,
      queryVector: EmbeddingVector,
      options?: { limit?: number; minSimilarity?: number },
    ): SimilarEmbeddingResult[] {
      const limit = options?.limit ?? 10;
      const minSimilarity = options?.minSimilarity ?? 0;
      const ids = adapter.getActiveKnowledgeMemory(scope).map((item) => item.id);
      return scoreKnowledge(ids, queryVector, limit, minSimilarity);
    },

    findSimilarCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      queryVector: EmbeddingVector,
      options?: { limit?: number; minSimilarity?: number },
    ): SimilarEmbeddingResult[] {
      const limit = options?.limit ?? 10;
      const minSimilarity = options?.minSimilarity ?? 0;
      const ids = adapter.getActiveKnowledgeCrossScope(scope, level).map((item) => item.id);
      return scoreKnowledge(ids, queryVector, limit, minSimilarity);
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
  };
}
