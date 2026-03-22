import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { buildMemoryContext } from '../core/context.js';
import { createMemoryManager } from '../core/manager.js';
import { makeScope } from './test-helpers.js';

describe('cross-scope learning', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('can read knowledge across a workspace boundary intentionally', async () => {
    const scopeA = makeScope({ scope_id: 'project/root' });
    const scopeB = makeScope({ scope_id: 'project/root/child' });
    const knowledge = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'Workspace shared fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const context = await buildMemoryContext(asyncAdapter, scopeB, {
      crossScopeLevel: 'workspace',
      relevanceQuery: 'shared',
    });
    expect(context.relevantKnowledge.map((item) => item.id)).toContain(knowledge.id);
  });

  it('manager can search across scopes when configured', async () => {
    const scopeA = makeScope({ scope_id: 'thread-1' });
    const scopeB = makeScope({ scope_id: 'thread-2' });
    const knowledge = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'Workspace shared fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const manager = createMemoryManager({
      adapter,
      scope: scopeB,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
      crossScopeLevel: 'workspace',
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([1, 0])],
    });

    const results = await manager.searchCrossScope('shared', 'workspace');
    expect(results.knowledge.map((item) => item.item.id)).toContain(knowledge.id);
    await manager.close();
  });
});
