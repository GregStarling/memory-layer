import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createMemoryRuntime } from '../core/runtime.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope } from './test-helpers.js';

describe('memory runtime helpers', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('prepares prompt-ready memory for a model call', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'Current objective is to ship memory.',
        key_entities: ['memory'],
        topic_tags: ['runtime'],
      }),
      autoCompact: false,
    });
    const runtime = createMemoryRuntime(manager);

    const payload = await runtime.beforeModelCall('ship memory');
    expect(payload.prompt).toContain('Current Objective');
    expect(payload.messages[0]?.role).toBe('system');
    await manager.close();
  });

  it('records exchanges and inferred work items after a model call', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
    const runtime = createMemoryRuntime(manager, {
      inferWorkItems: () => [
        {
          title: 'Follow up on retrieval',
          kind: 'unresolved_work',
          status: 'open',
        },
      ],
    });

    const result = await runtime.afterModelCall({
      userInput: 'Please remember to follow up on retrieval.',
      assistantOutput: 'I will do that.',
    });
    expect(result.exchange.userTurn.role).toBe('user');
    expect(result.trackedWorkItems).toHaveLength(1);
    await manager.close();
  });
});
