import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { makeScope } from './test-helpers.js';

describe('sqlite embeddings', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('stores and retrieves embeddings', () => {
    const scope = makeScope();
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0, 0]));
    expect(Array.from(adapter.embeddings.getEmbedding(knowledge.id) ?? [])).toEqual([1, 0, 0]);
  });

  it('returns similar results ordered by cosine similarity', () => {
    const scope = makeScope();
    const a = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'A',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const b = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'B',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(a.id, new Float32Array([1, 0]));
    adapter.embeddings.storeEmbedding(b.id, new Float32Array([0, 1]));

    const results = adapter.embeddings.findSimilar(scope, new Float32Array([0.9, 0.1]));
    expect(results[0].knowledgeMemoryId).toBe(a.id);
  });

  it('keeps semantic search isolated by scope', () => {
    const scopeA = makeScope();
    const scopeB = makeScope({ scope_id: 'thread-2' });
    const a = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'A',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const b = adapter.insertKnowledgeMemory({
      ...scopeB,
      fact: 'B',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(a.id, new Float32Array([1, 0]));
    adapter.embeddings.storeEmbedding(b.id, new Float32Array([1, 0]));

    const results = adapter.embeddings.findSimilar(scopeA, new Float32Array([1, 0]));
    expect(results).toHaveLength(1);
    expect(results[0].knowledgeMemoryId).toBe(a.id);
  });

  it('deletes embeddings', () => {
    const scope = makeScope();
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0, 0]));
    adapter.embeddings.deleteEmbedding(knowledge.id);
    expect(adapter.embeddings.getEmbedding(knowledge.id)).toBeNull();
  });

  it('requires a matching scope when deleting embeddings with a scope guard', () => {
    const scope = makeScope();
    const otherScope = makeScope({ scope_id: 'thread-2' });
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Scoped embedding',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0, 0]));
    adapter.embeddings.deleteEmbedding(knowledge.id, otherScope);
    expect(adapter.embeddings.getEmbedding(knowledge.id)).not.toBeNull();

    adapter.embeddings.deleteEmbedding(knowledge.id, scope);
    expect(adapter.embeddings.getEmbedding(knowledge.id)).toBeNull();
  });

  it('supports cross-scope semantic search when requested', () => {
    const scopeA = makeScope({ scope_id: 'thread-1' });
    const scopeB = makeScope({ scope_id: 'thread-2' });
    const knowledge = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'shared workspace fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const results = adapter.embeddings.findSimilarCrossScope(
      scopeB,
      'workspace',
      new Float32Array([1, 0]),
    );
    expect(results[0]?.knowledgeMemoryId).toBe(knowledge.id);
  });

  it('supports workspace-level cross-scope semantic search inside a collaboration', () => {
    const scopeA = makeScope({
      system_id: 'planner',
      workspace_id: 'factory',
      collaboration_id: 'incident-123',
      scope_id: 'thread-1',
    });
    const scopeB = makeScope({
      system_id: 'executor',
      workspace_id: 'factory',
      collaboration_id: 'incident-123',
      scope_id: 'thread-2',
    });
    const knowledge = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'Shared collaboration memory',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const results = adapter.embeddings.findSimilarCrossScope(
      scopeB,
      'workspace',
      new Float32Array([1, 0]),
    );
    expect(results[0]?.knowledgeMemoryId).toBe(knowledge.id);
  });

  it('excludes retired knowledge from semantic search (plan 0.6)', () => {
    const scope = makeScope();
    const kept = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'kept fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const retired = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'retired fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(kept.id, new Float32Array([1, 0]));
    adapter.embeddings.storeEmbedding(retired.id, new Float32Array([1, 0]));

    // Before retirement both match.
    expect(adapter.embeddings.findSimilar(scope, new Float32Array([1, 0]))).toHaveLength(2);

    adapter.retireKnowledgeMemory(retired.id);

    const results = adapter.embeddings.findSimilar(scope, new Float32Array([1, 0]));
    expect(results.map((r) => r.knowledgeMemoryId)).toEqual([kept.id]);
  });

  it('excludes retired knowledge from cross-scope semantic search (plan 0.6)', () => {
    const scopeA = makeScope({ scope_id: 'thread-1' });
    const scopeB = makeScope({ scope_id: 'thread-2' });
    const retired = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'retired cross-scope fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(retired.id, new Float32Array([1, 0]));
    adapter.retireKnowledgeMemory(retired.id);

    const results = adapter.embeddings.findSimilarCrossScope(
      scopeB,
      'workspace',
      new Float32Array([1, 0]),
    );
    expect(results).toHaveLength(0);
  });

  it('warns when stored embedding dimensions do not match the query vector', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    adapter.close();
    adapter = createSQLiteAdapterWithEmbeddings(':memory:', { logger });

    const scope = makeScope();
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Mismatched vector fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0, 0]));

    const results = adapter.embeddings.findSimilar(scope, new Float32Array([1, 0]), {
      minSimilarity: 0.01,
    });
    expect(results).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'memory.embeddings.dimension_mismatch',
      expect.objectContaining({
        knowledgeMemoryId: knowledge.id,
        queryDimensions: 2,
        storedDimensions: 3,
      }),
    );
  });

  // ---- 2.4 dimension/model versioning: SQL-side filtering ----
  it('excludes vectors whose dimensions mismatch the active provider filter (2.4)', () => {
    const scope = makeScope();
    const a = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'A',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const b = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'B',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    // Old 2-dim vectors from a previous provider.
    adapter.embeddings.storeEmbedding(a.id, new Float32Array([1, 0]), {
      model: 'old-model',
      dimensions: 2,
    });
    adapter.embeddings.storeEmbedding(b.id, new Float32Array([0, 1]), {
      model: 'old-model',
      dimensions: 2,
    });

    // Active provider now emits 3-dim vectors: every stored vector mismatches and
    // must be excluded IN SQL (never distance-compared).
    const query = new Float32Array([1, 0, 0]);
    const filter = { model: 'new-model', dimensions: 3 };
    expect(adapter.embeddings.findSimilar(scope, query, { filter })).toEqual([]);
    const coverage = adapter.embeddings.getEmbeddingCoverage!(scope, filter);
    expect(coverage).toEqual({ total: 2, matching: 0, mismatched: 2 });
  });

  it('surfaces legacy unknown-model vectors when dimensions agree (2.4)', () => {
    const scope = makeScope();
    const k = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'legacy',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    // Stored without metadata => model 'unknown', dimensions 3.
    adapter.embeddings.storeEmbedding(k.id, new Float32Array([1, 0, 0]));
    // Active provider is a NAMED model at the same dimensionality. 'unknown' is
    // not excluded on model grounds, so the vector still participates.
    const filter = { model: 'new-model', dimensions: 3 };
    const results = adapter.embeddings.findSimilar(scope, new Float32Array([1, 0, 0]), { filter });
    expect(results.map((r) => r.knowledgeMemoryId)).toEqual([k.id]);
    expect(adapter.embeddings.getEmbeddingCoverage!(scope, filter)).toEqual({
      total: 1,
      matching: 1,
      mismatched: 0,
    });
  });

  it('does NOT exclude known-model vectors when the QUERY model is unknown (D2)', () => {
    const scope = makeScope();
    const k = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'real',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    // A vector stored under a KNOWN, named model at the active dimensionality.
    adapter.embeddings.storeEmbedding(k.id, new Float32Array([1, 0, 0]), {
      model: 'v1',
      dimensions: 3,
    });
    // The active provider has NO configured model (model: 'unknown') — filter by
    // dimensions ALONE. The buggy `(model='unknown' OR model=?)` form with an
    // 'unknown' query model degenerates to `(model='unknown' OR model='unknown')`,
    // which wrongly excludes the real 'v1' vector and kills semantic search.
    const filter = { model: 'unknown', dimensions: 3 };
    const results = adapter.embeddings.findSimilar(scope, new Float32Array([1, 0, 0]), { filter });
    expect(results.map((r) => r.knowledgeMemoryId)).toEqual([k.id]);
    expect(adapter.embeddings.getEmbeddingCoverage!(scope, filter)).toEqual({
      total: 1,
      matching: 1,
      mismatched: 0,
    });
    // Sanity: with a KNOWN, DIFFERENT active model the same vector is excluded.
    const wrongModel = { model: 'v2', dimensions: 3 };
    expect(
      adapter.embeddings.findSimilar(scope, new Float32Array([1, 0, 0]), { filter: wrongModel }),
    ).toEqual([]);
  });

  it('restores coverage once vectors are re-embedded at the active dimensions (2.4)', () => {
    const scope = makeScope();
    const a = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'A',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(a.id, new Float32Array([1, 0]), {
      model: 'old-model',
      dimensions: 2,
    });
    const filter = { model: 'new-model', dimensions: 3 };
    expect(adapter.embeddings.getEmbeddingCoverage!(scope, filter).matching).toBe(0);

    // Re-embed with the active provider's model + dimensions.
    adapter.embeddings.storeEmbedding(a.id, new Float32Array([1, 0, 0]), {
      model: 'new-model',
      dimensions: 3,
    });
    expect(adapter.embeddings.getEmbeddingCoverage!(scope, filter)).toEqual({
      total: 1,
      matching: 1,
      mismatched: 0,
    });
    const results = adapter.embeddings.findSimilar(scope, new Float32Array([1, 0, 0]), { filter });
    expect(results.map((r) => r.knowledgeMemoryId)).toEqual([a.id]);
  });

  it('applies the dimensions filter to cross-scope similarity too (2.4)', () => {
    const scopeA = makeScope({ scope_id: 'thread-1' });
    const scopeB = makeScope({ scope_id: 'thread-2' });
    const k = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'shared',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(k.id, new Float32Array([1, 0]), {
      model: 'old-model',
      dimensions: 2,
    });
    // 3-dim active provider: the 2-dim stored vector is excluded in SQL.
    const results = adapter.embeddings.findSimilarCrossScope(
      scopeB,
      'workspace',
      new Float32Array([1, 0, 0]),
      { filter: { model: 'new-model', dimensions: 3 } },
    );
    expect(results).toEqual([]);
  });
});
