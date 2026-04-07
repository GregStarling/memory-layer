import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { ScopeMismatchError } from '../contracts/errors.js';
import { makeScope } from './test-helpers.js';

describe('scope isolation', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function makeManager(scopeId: string) {
    return createMemoryManager({
      adapter,
      scope: makeScope({ scope_id: scopeId }),
      sessionId: `session-${scopeId}`,
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
  }

  it('work item created in scope A is not visible in scope B', async () => {
    const managerA = makeManager('scope-a');
    const managerB = makeManager('scope-b');

    const workItem = await managerA.trackWorkItem('Build feature X', 'objective', 'open');

    const scopeA = makeScope({ scope_id: 'scope-a' });
    const scopeB = makeScope({ scope_id: 'scope-b' });

    // Scope A should see the work item
    const itemsA = adapter.getActiveWorkItems(scopeA);
    expect(itemsA.map((w) => w.id)).toContain(workItem.id);

    // Scope B should NOT see the work item
    const itemsB = adapter.getActiveWorkItems(scopeB);
    expect(itemsB.map((w) => w.id)).not.toContain(workItem.id);

    await managerA.close();
    await managerB.close();
  });

  it('work item created in scope A cannot be claimed from scope B', async () => {
    const managerA = makeManager('scope-a');
    const managerB = makeManager('scope-b');

    const workItem = await managerA.trackWorkItem('Deploy service', 'objective', 'open');

    const actor = {
      kind: 'human' as const,
      actor_id: 'user-1',
      system_id: null,
      display_name: 'Test User',
      metadata: null,
    };

    // Attempting to claim a work item from a different scope should throw
    await expect(
      managerB.claimWorkItem({
        workItemId: workItem.id,
        actor,
        leaseSeconds: 300,
      }),
    ).rejects.toThrow(ScopeMismatchError);

    await managerA.close();
    await managerB.close();
  });

  it('knowledge created in scope A cannot be read via adapter from scope B', async () => {
    const scopeA = makeScope({ scope_id: 'scope-a' });
    const scopeB = makeScope({ scope_id: 'scope-b' });

    adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'Scope-A secret configuration value',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    // Active knowledge query for scope B should not include scope A's knowledge
    const knowledgeB = adapter.getActiveKnowledgeMemory(scopeB);
    expect(knowledgeB.map((k) => k.fact)).not.toContain('Scope-A secret configuration value');
  });

  it('knowledge created in scope A does not appear in scope B context', async () => {
    const managerA = makeManager('scope-a');
    const managerB = makeManager('scope-b');

    await managerA.learnFact('The API key rotates every 90 days', 'reference', 'high');

    const context = await managerB.getContext('API key rotation');
    const knowledgeFacts = context.relevantKnowledge.map((k) => k.fact);
    expect(knowledgeFacts).not.toContain('The API key rotates every 90 days');

    await managerA.close();
    await managerB.close();
  });
});
