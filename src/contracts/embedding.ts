import type { MemoryScope, ScopeLevel } from './identity.js';

export type EmbeddingVector = Float32Array;
export type EmbeddingGenerator = (texts: string[]) => Promise<EmbeddingVector[]>;
export type MaybePromise<T> = T | Promise<T>;

/**
 * Provenance for a stored embedding vector (Phase 2.4).
 *
 * `model` identifies the embedding provider/model that produced the vector so
 * that vectors from a different model are never distance-compared against a
 * query vector. `dimensions` is the vector length; queries filter on it in the
 * storage layer BEFORE any distance operator runs. `'unknown'` is the default
 * `model` when the active provider does not expose an identifier.
 */
export interface EmbeddingMetadata {
  model: string;
  dimensions: number;
}

/**
 * Filter applied to similarity queries so that only vectors matching the ACTIVE
 * provider's `dimensions` (and `model`, when known) participate in the search.
 * When omitted, adapters fall back to legacy behaviour (compare all vectors);
 * callers that have a configured provider SHOULD always pass it.
 */
export interface EmbeddingQueryFilter {
  /** Required query-vector dimensionality; adapters exclude mismatched rows in-store. */
  dimensions?: number;
  /** Provider model id; when set, adapters additionally exclude other models. */
  model?: string;
}

export interface SimilarEmbeddingResult {
  knowledgeMemoryId: number;
  similarity: number;
}

/**
 * Diagnostic counts describing how stored embeddings compare to the active
 * provider (Phase 2.4). Used by the manager to detect silently-degraded
 * semantic search (all stored vectors mismatch the active model/dimensions).
 */
export interface EmbeddingCoverage {
  total: number;
  matching: number;
  mismatched: number;
}

export interface EmbeddingAdapter {
  /**
   * Store a vector. `metadata` records the model+dimensions that produced it;
   * omitting it defaults to `{ model: 'unknown', dimensions: vector.length }`
   * for backward compatibility.
   */
  storeEmbedding(
    knowledgeMemoryId: number,
    vector: EmbeddingVector,
    metadata?: EmbeddingMetadata,
  ): MaybePromise<void>;
  getEmbedding(knowledgeMemoryId: number): MaybePromise<EmbeddingVector | null>;
  /**
   * Return the provenance ({@link EmbeddingMetadata}) of a stored vector, or
   * null when no vector is stored (Phase 2.4). Unlike {@link getEmbedding} this
   * exposes the stored `model`, so callers (e.g. `reembedKnowledge`) can detect
   * a model change at an unchanged dimensionality — the staleness class that a
   * length-only check misses. Optional: adapters that predate metadata storage
   * may omit it, in which case callers fall back to a length-only check.
   */
  getEmbeddingMetadata?(knowledgeMemoryId: number): MaybePromise<EmbeddingMetadata | null>;
  findSimilar(
    scope: MemoryScope,
    queryVector: EmbeddingVector,
    options?: { limit?: number; minSimilarity?: number; filter?: EmbeddingQueryFilter },
  ): MaybePromise<SimilarEmbeddingResult[]>;
  findSimilarCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    queryVector: EmbeddingVector,
    options?: { limit?: number; minSimilarity?: number; filter?: EmbeddingQueryFilter },
  ): MaybePromise<SimilarEmbeddingResult[]>;
  deleteEmbedding(knowledgeMemoryId: number, scope?: MemoryScope): MaybePromise<void>;
  /**
   * Report coverage of stored embeddings for a scope against the active
   * provider (Phase 2.4). Optional: adapters that cannot cheaply compute it may
   * omit it. Used to emit degraded-mode diagnostics and to drive `reembed`.
   */
  getEmbeddingCoverage?(
    scope: MemoryScope,
    filter: EmbeddingQueryFilter,
  ): MaybePromise<EmbeddingCoverage>;
}
