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
});
