import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createSessionId, estimateTokens } from '../core/tokens.js';
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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe('SQLite storage adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('creates session ids from normalized scope', () => {
    const id = createSessionId(scope());
    expect(id).toContain('acme');
    expect(id).toContain('assistant');
    expect(id).toContain('default');
    expect(id).toContain('thread-1');
  });

  it('stores turns with normalized workspace and computed token estimate', () => {
    const turn = adapter.insertTurn({
      ...scope(),
      session_id: createSessionId(scope()),
      actor: 'user-1',
      role: 'user',
      content: 'Hello memory layer',
    });

    expect(turn.workspace_id).toBe('default');
    expect(turn.token_estimate).toBe(estimateTokens('Hello memory layer'));
    expect(turn.archived_at).toBeNull();
  });

  it('scopes active turns by MemoryScope', () => {
    const baseScope = scope();
    adapter.insertTurn({
      ...baseScope,
      session_id: createSessionId(baseScope),
      actor: 'user-1',
      role: 'user',
      content: 'alpha',
    });
    adapter.insertTurn({
      ...scope({ scope_id: 'thread-2' }),
      session_id: createSessionId(scope({ scope_id: 'thread-2' })),
      actor: 'user-2',
      role: 'user',
      content: 'beta',
    });

    expect(adapter.getActiveTurns(baseScope)).toHaveLength(1);
    expect(adapter.getActiveTurns(scope({ scope_id: 'thread-2' }))).toHaveLength(1);
  });

  it('archives turns through compaction log linkage', () => {
    const memoryScope = scope();
    const sessionId = createSessionId(memoryScope);
    const turn = adapter.insertTurn({
      ...memoryScope,
      session_id: sessionId,
      actor: 'user-1',
      role: 'user',
      content: 'archive me',
    });
    const workingMemory = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'Archived the first turn',
      key_entities: ['memory'],
      topic_tags: ['compaction'],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'soft',
    });
    const compactionLog = adapter.insertCompactionLog({
      ...memoryScope,
      session_id: sessionId,
      trigger_type: 'soft',
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turns_compacted: 1,
      tokens_compacted_estimate: turn.token_estimate,
      working_memory_id: workingMemory.id,
      active_turn_count_before: 1,
      active_turn_count_after: 0,
      duration_ms: 25,
      model_call_made: true,
    });

    adapter.archiveTurn(turn.id, nowSec(), compactionLog.id);

    expect(adapter.getActiveTurns(memoryScope)).toHaveLength(0);
    expect(adapter.getArchivedTurnRange(sessionId, turn.id, turn.id)).toHaveLength(1);
  });

  it('stores and reads working memory arrays and expiry', () => {
    const memoryScope = scope();
    const sessionId = createSessionId(memoryScope);
    const wm = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'Discussion summary',
      key_entities: ['SQLite', 'Memory'],
      topic_tags: ['architecture'],
      turn_id_start: 1,
      turn_id_end: 5,
      turn_count: 5,
      compaction_trigger: 'soft',
      expires_at: null,
    });

    expect(wm.key_entities).toEqual(['SQLite', 'Memory']);
    expect(adapter.getLatestWorkingMemory(memoryScope)?.id).toBe(wm.id);
    adapter.expireWorkingMemory(wm.id);
    expect(adapter.getActiveWorkingMemory(memoryScope)).toHaveLength(0);
  });

  it('tracks knowledge memory access and supersession', () => {
    const memoryScope = scope();
    const first = adapter.insertKnowledgeMemory({
      ...memoryScope,
      fact: 'User prefers dark mode',
      fact_type: 'preference',
      source: 'user_stated',
      confidence: 'high',
    });
    const second = adapter.insertKnowledgeMemory({
      ...memoryScope,
      fact: 'User now prefers light mode',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'medium',
    });

    adapter.touchKnowledgeMemory(first.id);
    adapter.supersedeKnowledgeMemory(first.id, second.id);

    expect(adapter.getKnowledgeMemoryById(first.id)?.access_count).toBe(2);
    expect(adapter.getActiveKnowledgeMemory(memoryScope)).toHaveLength(1);
    expect(adapter.getActiveKnowledgeMemory(memoryScope)[0].id).toBe(second.id);
  });

  it('upserts context monitor on the normalized scope key', () => {
    const memoryScope = scope();
    const first = adapter.upsertContextMonitor({
      ...memoryScope,
      compaction_state: 'idle',
      active_turn_count: 2,
      active_token_estimate: 200,
      compaction_score: 1,
    });
    const second = adapter.upsertContextMonitor({
      ...memoryScope,
      compaction_state: 'soft_triggered',
      active_turn_count: 16,
      active_token_estimate: 3200,
      compaction_score: 4,
    });

    expect(first.id).toBe(second.id);
    expect(adapter.getContextMonitor(memoryScope)?.compaction_state).toBe('soft_triggered');
  });

  it('isolates multiple adapter instances', () => {
    const otherAdapter = createSQLiteAdapter(':memory:');
    const memoryScope = scope();
    try {
      adapter.insertTurn({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        actor: 'user-1',
        role: 'user',
        content: 'primary',
      });
      otherAdapter.insertTurn({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        actor: 'user-2',
        role: 'user',
        content: 'secondary',
      });

      expect(adapter.getActiveTurns(memoryScope)).toHaveLength(1);
      expect(otherAdapter.getActiveTurns(memoryScope)).toHaveLength(1);
      expect(adapter.getActiveTurns(memoryScope)[0].content).toBe('primary');
      expect(otherAdapter.getActiveTurns(memoryScope)[0].content).toBe('secondary');
    } finally {
      otherAdapter.close();
    }
  });
});
