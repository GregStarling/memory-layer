import { afterEach, describe, expect, it } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createMemorySync } from '../core/sync.js';
import { makeScope } from './test-helpers.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('knowledge sync', () => {
  const managers: Array<ReturnType<typeof createMemoryManager>> = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
  });

  it('pollForChanges returns collaboration-scoped knowledge updates', async () => {
    const adapter = createInMemoryAdapter();
    const writerScope = makeScope({
      system_id: 'planner',
      collaboration_id: 'factory-2',
      scope_id: 'planner-task',
    });
    const readerScope = makeScope({
      system_id: 'executor',
      collaboration_id: 'factory-2',
      scope_id: 'executor-task',
    });

    const writer = createMemoryManager({
      adapter,
      scope: writerScope,
      sessionId: 'writer',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
    });
    const reader = createMemoryManager({
      adapter,
      scope: readerScope,
      sessionId: 'reader',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
      crossScopeLevel: 'workspace',
    });
    managers.push(writer, reader);

    const since = new Date();
    await writer.learnFact('Shared deploy checklist lives here.', 'reference', 'high');

    const changes = await reader.pollForChanges(since, { scopeLevel: 'workspace' });
    expect(changes.some((item) => item.fact.includes('deploy checklist'))).toBe(true);
  });

  it('createMemorySync emits discovered collaboration changes while polling', async () => {
    const adapter = createInMemoryAdapter();
    const writer = createMemoryManager({
      adapter,
      scope: makeScope({
        system_id: 'planner',
        collaboration_id: 'factory-3',
        scope_id: 'planner-task',
      }),
      sessionId: 'writer',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
    });
    const reader = createMemoryManager({
      adapter,
      scope: makeScope({
        system_id: 'executor',
        collaboration_id: 'factory-3',
        scope_id: 'executor-task',
      }),
      sessionId: 'reader',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
      crossScopeLevel: 'workspace',
    });
    managers.push(writer, reader);

    const sync = createMemorySync({
      manager: reader,
      scopeLevel: 'workspace',
      pollIntervalMs: 10,
    });

    const batches: string[][] = [];
    sync.onKnowledgeChange((knowledge) => {
      batches.push(knowledge.map((item) => item.fact));
    });
    sync.startPolling();
    await writer.learnFact('Use the shared rollout checklist.', 'reference', 'high');
    await wait(30);
    sync.stopPolling();

    expect(batches.flat()).toContain('Use the shared rollout checklist.');
  });

  it('listKnowledgeChanges advances by cursor without duplicating the boundary item and includes retirements', async () => {
    const adapter = createInMemoryAdapter();
    const writer = createMemoryManager({
      adapter,
      scope: makeScope({
        system_id: 'planner',
        collaboration_id: 'factory-4',
        scope_id: 'planner-task',
      }),
      sessionId: 'writer',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
    });
    const reader = createMemoryManager({
      adapter,
      scope: makeScope({
        system_id: 'executor',
        collaboration_id: 'factory-4',
        scope_id: 'executor-task',
      }),
      sessionId: 'reader',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
      crossScopeLevel: 'workspace',
    });
    managers.push(writer, reader);

    const startCursor = await reader.resolveChangeStreamCursor();
    const created = await writer.learnFact('Shared runbook lives here.', 'reference', 'high');

    const createdPage = await reader.listKnowledgeChanges({
      cursor: startCursor,
      scopeLevel: 'workspace',
    });
    expect(createdPage.changes).toHaveLength(1);
    expect(createdPage.changes[0].event_type).toBe('knowledge.created');
    expect(createdPage.changes[0].knowledge.id).toBe(created.id);

    const emptyPage = await reader.listKnowledgeChanges({
      cursor: createdPage.nextCursor,
      scopeLevel: 'workspace',
    });
    expect(emptyPage.changes).toHaveLength(0);

    adapter.retireKnowledgeMemory(created.id);
    const retiredPage = await reader.listKnowledgeChanges({
      cursor: createdPage.nextCursor,
      scopeLevel: 'workspace',
    });
    expect(retiredPage.changes).toHaveLength(1);
    expect(retiredPage.changes[0].event_type).toBe('knowledge.retired');
    expect(retiredPage.changes[0].knowledge.retired_at).not.toBeNull();
  });
});
