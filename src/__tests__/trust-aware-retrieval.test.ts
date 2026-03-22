import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { buildMemoryContext } from '../core/context.js';
import { createMemoryManager } from '../core/manager.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('trust-aware retrieval', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('trusted constraint outranks recent provisional fact', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    const trusted = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system must stay local-first.',
      fact_type: 'constraint',
      knowledge_state: 'trusted',
      knowledge_class: 'constraint',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.95,
      evidence_count: 2,
    });
    const provisional = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Maybe switch to a remote cache.',
      fact_type: 'reference',
      knowledge_state: 'provisional',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.5,
      evidence_count: 1,
    });
    adapter.touchKnowledgeMemory(provisional.id);
    adapter.touchKnowledgeMemory(provisional.id);

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'local cache strategy',
      crossScopeLevel: 'scope',
    });

    expect(context.relevantKnowledge[0]?.id).toBe(trusted.id);
    expect(context.relevantKnowledge.map((item) => item.id)).not.toContain(provisional.id);
    expect(context.provisionalKnowledge.map((item) => item.id)).toContain(provisional.id);
  });

  it('search filters provisional and disputed facts by default', async () => {
    const scope = makeScope();
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Trusted deploy window is Tuesday.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Provisional deploy window is Wednesday.',
      fact_type: 'reference',
      knowledge_state: 'provisional',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.55,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Disputed deploy window is Friday.',
      fact_type: 'reference',
      knowledge_state: 'disputed',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.2,
      contradiction_score: 1,
    });

    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'trust-search',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
    });

    const defaultResults = await manager.search('deploy window');
    const expandedResults = await manager.search('deploy window', {
      includeProvisional: true,
      includeDisputed: true,
    });

    expect(defaultResults.knowledge).toHaveLength(1);
    expect(defaultResults.knowledge[0]?.item.knowledge_state).toBe('trusted');
    expect(expandedResults.knowledge.map((item) => item.item.knowledge_state)).toEqual(
      expect.arrayContaining(['trusted', 'provisional', 'disputed']),
    );
    await manager.close();
  });
});
