import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { buildMemoryContext } from '../core/context.js';
import { createMemoryManager } from '../core/manager.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('cross-scope trust', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('local trusted memory outranks cross-scope memory when scores are close', async () => {
    const localScope = makeScope({ workspace_id: 'shared', scope_id: 'task/local' });
    const siblingScope = makeScope({ workspace_id: 'shared', scope_id: 'task/sibling' });
    seedTurns(adapter, localScope, 2);

    const localKnowledge = adapter.insertKnowledgeMemory({
      ...localScope,
      fact: 'Deploy window is Tuesday.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
    });
    adapter.insertKnowledgeMemory({
      ...siblingScope,
      fact: 'Deploy window is Tuesday for the sibling task.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
    });

    const context = await buildMemoryContext(asyncAdapter, localScope, {
      crossScopeLevel: 'workspace',
      relevanceQuery: 'deploy window',
    });

    expect(context.relevantKnowledge[0]?.id).toBe(localKnowledge.id);
  });

  it('prefers lineage memory over unrelated sibling memory in cross-scope search', async () => {
    const childScope = makeScope({ workspace_id: 'shared', scope_id: 'project/root/child' });
    const parentScope = makeScope({ workspace_id: 'shared', scope_id: 'project/root' });
    const siblingScope = makeScope({ workspace_id: 'shared', scope_id: 'project/other' });

    adapter.insertKnowledgeMemory({
      ...parentScope,
      fact: 'Parent deploy checklist must be reviewed.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
    });
    adapter.insertKnowledgeMemory({
      ...siblingScope,
      fact: 'Sibling deploy checklist uses a different region.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
    });

    const manager = createMemoryManager({
      adapter,
      scope: childScope,
      sessionId: 'lineage-search',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
      crossScopeLevel: 'workspace',
    });

    const results = await manager.searchCrossScope('deploy checklist', 'workspace', {
      limit: 1,
      preferLocalTrusted: true,
      preferLineageMemory: true,
    });

    expect(results.knowledge).toHaveLength(1);
    expect(results.knowledge[0]?.item.scope_id).toBe(parentScope.scope_id);
    await manager.close();
  });
});
