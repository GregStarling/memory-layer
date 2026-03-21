import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
