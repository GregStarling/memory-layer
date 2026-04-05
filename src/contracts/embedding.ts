import type { MemoryScope, ScopeLevel } from './identity.js';

export type EmbeddingVector = Float32Array;
export type EmbeddingGenerator = (texts: string[]) => Promise<EmbeddingVector[]>;
export type MaybePromise<T> = T | Promise<T>;

export interface SimilarEmbeddingResult {
  knowledgeMemoryId: number;
  similarity: number;
}

export interface EmbeddingAdapter {
  storeEmbedding(knowledgeMemoryId: number, vector: EmbeddingVector): MaybePromise<void>;
  getEmbedding(knowledgeMemoryId: number): MaybePromise<EmbeddingVector | null>;
  findSimilar(
    scope: MemoryScope,
    queryVector: EmbeddingVector,
    options?: { limit?: number; minSimilarity?: number },
  ): MaybePromise<SimilarEmbeddingResult[]>;
  findSimilarCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    queryVector: EmbeddingVector,
    options?: { limit?: number; minSimilarity?: number },
  ): MaybePromise<SimilarEmbeddingResult[]>;
  deleteEmbedding(knowledgeMemoryId: number, scope?: MemoryScope): MaybePromise<void>;
}
