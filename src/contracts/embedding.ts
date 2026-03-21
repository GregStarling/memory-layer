import type { MemoryScope } from './identity.js';

export type EmbeddingVector = Float32Array;
export type EmbeddingGenerator = (texts: string[]) => Promise<EmbeddingVector[]>;

export interface SimilarEmbeddingResult {
  knowledgeMemoryId: number;
  similarity: number;
}

export interface EmbeddingAdapter {
  storeEmbedding(knowledgeMemoryId: number, vector: EmbeddingVector): void;
  getEmbedding(knowledgeMemoryId: number): EmbeddingVector | null;
  findSimilar(
    scope: MemoryScope,
    queryVector: EmbeddingVector,
    options?: { limit?: number; minSimilarity?: number },
  ): SimilarEmbeddingResult[];
  deleteEmbedding(knowledgeMemoryId: number): void;
}
