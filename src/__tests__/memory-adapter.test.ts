import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { createSessionId } from '../core/tokens.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

describe('in-memory adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  afterEach(() => {
    adapter.close();
  });

  it('stores and searches turns', () => {
    const memoryScope = scope();
    const sessionId = createSessionId(memoryScope);
    adapter.insertTurn({
      ...memoryScope,
      session_id: sessionId,
      actor: 'user',
      role: 'user',
      content: 'remember local first sqlite',
    });

    const results = adapter.searchTurns(memoryScope, 'sqlite local');
    expect(results[0]?.item.content).toContain('sqlite');
  });

  it('supports cross-scope knowledge search', () => {
    const workspaceScope = scope({ workspace_id: 'shared', scope_id: 'a' });
    adapter.insertKnowledgeMemory({
      ...workspaceScope,
      fact: 'Use shared workspace memory',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const results = adapter.searchKnowledgeCrossScope(
      scope({ workspace_id: 'shared', scope_id: 'b' }),
      'workspace',
      'shared memory',
    );
    expect(results).toHaveLength(1);
  });

  it('tracks work items and context monitors', () => {
    const memoryScope = scope();
    const item = adapter.insertWorkItem({
      ...memoryScope,
      kind: 'objective',
      title: 'Ship memory layer',
    });
    adapter.upsertContextMonitor({
      ...memoryScope,
      compaction_state: 'idle',
      active_turn_count: 1,
      active_token_estimate: 10,
      compaction_score: 0,
    });

    expect(adapter.getActiveWorkItems(memoryScope)[0]?.id).toBe(item.id);
    expect(adapter.getContextMonitor(memoryScope)?.compaction_state).toBe('idle');
  });
});
