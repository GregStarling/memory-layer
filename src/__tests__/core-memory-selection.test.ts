import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { buildMemoryContext } from '../core/context.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('core memory selection', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('separates trusted core, task-relevant, provisional, and disputed knowledge', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    const trustedConstraint = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system must stay local-first.',
      fact_type: 'constraint',
      knowledge_state: 'trusted',
      knowledge_class: 'constraint',
      source: 'manual',
      confidence: 'high',
      trust_score: 1,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers TypeScript.',
      fact_type: 'preference',
      knowledge_state: 'trusted',
      knowledge_class: 'preference',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.95,
    });
    const trustedReference = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Deploy to staging before production.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
    });
    const provisional = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Retry with smaller batches.',
      fact_type: 'decision',
      knowledge_state: 'provisional',
      knowledge_class: 'strategy',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.55,
    });
    const disputed = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Always use Docker.',
      fact_type: 'constraint',
      knowledge_state: 'disputed',
      knowledge_class: 'constraint',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.2,
    });

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'deploy staging',
    });

    expect(context.trustedCoreMemory.map((item) => item.id)).toContain(trustedConstraint.id);
    expect(context.taskRelevantKnowledge.map((item) => item.id)).toContain(trustedReference.id);
    expect(context.provisionalKnowledge.map((item) => item.id)).toContain(provisional.id);
    expect(context.disputedKnowledge.map((item) => item.id)).toContain(disputed.id);
    expect(context.durableKnowledge.map((item) => item.id)).toEqual(
      context.trustedCoreMemory.map((item) => item.id),
    );
    expect(context.relevantKnowledge.map((item) => item.id)).not.toContain(provisional.id);
    expect(context.relevantKnowledge.map((item) => item.id)).not.toContain(disputed.id);
  });
});
