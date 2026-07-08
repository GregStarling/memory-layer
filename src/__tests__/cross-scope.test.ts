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
      // P6: crossing a scope boundary is now an explicit opt-in — the fact must
      // be marked workspace-visible; a default 'private' fact stays in scopeA.
      visibility_class: 'workspace',
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
      // P6/F4: crossing a scope boundary via SEMANTIC search is also an explicit
      // opt-in — the fact must be workspace-visible or the base-visibility gate in
      // findSimilarCrossScope (and the manager's defensive hydration gate) keeps a
      // default 'private' fact inside scopeA.
      visibility_class: 'workspace',
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

  it('shares workspace memory across agent identities when collaboration matches', async () => {
    const scopeA = makeScope({
      system_id: 'planner-agent',
      collaboration_id: 'factory-1',
      scope_id: 'task-1',
    });
    const scopeB = makeScope({
      system_id: 'executor-agent',
      collaboration_id: 'factory-1',
      scope_id: 'task-2',
    });
    const knowledge = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'Shared collaboration memory',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
      // P6: shared across a collaboration only when explicitly marked as such;
      // the base visibility gate then admits it only inside the matching
      // (non-empty) collaboration_id ('factory-1').
      visibility_class: 'shared_collaboration',
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const context = await buildMemoryContext(asyncAdapter, scopeB, {
      crossScopeLevel: 'workspace',
      relevanceQuery: 'shared collaboration',
    });

    expect(context.relevantKnowledge.map((item) => item.id)).toContain(knowledge.id);
  });
});
