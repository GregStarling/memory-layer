import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope } from './test-helpers.js';

describe('search', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('searches turns by keyword within scope', () => {
    const scope = makeScope();
    adapter.insertTurn({
      ...scope,
      session_id: 's1',
      actor: 'user-1',
      role: 'user',
      content: 'remember the postgres migration',
    });
    adapter.insertTurn({
      ...scope,
      session_id: 's1',
      actor: 'assistant-1',
      role: 'assistant',
      content: 'unrelated output',
    });

    const results = adapter.searchTurns(scope, 'postgres');
    expect(results).toHaveLength(1);
    expect(results[0].item.content).toContain('postgres');
    expect(results[0].rank).toBeGreaterThan(0);
  });

  it('keeps turn search isolated by scope', () => {
    const scopeA = makeScope();
    const scopeB = makeScope({ scope_id: 'thread-2' });
    adapter.insertTurn({
      ...scopeA,
      session_id: 'a',
      actor: 'user-1',
      role: 'user',
      content: 'shared keyword docker',
    });
    adapter.insertTurn({
      ...scopeB,
      session_id: 'b',
      actor: 'user-2',
      role: 'user',
      content: 'shared keyword docker',
    });

    expect(adapter.searchTurns(scopeA, 'docker')).toHaveLength(1);
    expect(adapter.searchTurns(scopeB, 'docker')).toHaveLength(1);
  });

  it('filters archived turns when activeOnly is true', () => {
    const scope = makeScope();
    const turn = adapter.insertTurn({
      ...scope,
      session_id: 's1',
      actor: 'user-1',
      role: 'user',
      content: 'archive postgres turn',
    });
    const wm = adapter.insertWorkingMemory({
      ...scope,
      session_id: 's1',
      summary: 'postgres summary',
      key_entities: [],
      topic_tags: [],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'manual',
    });
    const log = adapter.insertCompactionLog({
      ...scope,
      session_id: 's1',
      trigger_type: 'manual',
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turns_compacted: 1,
      tokens_compacted_estimate: turn.token_estimate,
      working_memory_id: wm.id,
      active_turn_count_before: 1,
      active_turn_count_after: 0,
      duration_ms: 1,
    });
    adapter.archiveTurn(turn.id, 1_700_000_100, log.id);

    expect(adapter.searchTurns(scope, 'postgres')).toHaveLength(0);
    expect(adapter.searchTurns(scope, 'postgres', { activeOnly: false })).toHaveLength(1);
  });

  it('searches active knowledge and excludes superseded facts by default', () => {
    const scope = makeScope();
    const oldFact = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers vim',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });
    const newFact = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers neovim',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.supersedeKnowledgeMemory(oldFact.id, newFact.id);

    const active = adapter.searchKnowledge(scope, 'prefers');
    expect(active).toHaveLength(1);
    expect(active[0].item.id).toBe(newFact.id);

    const all = adapter.searchKnowledge(scope, 'prefers', { activeOnly: false });
    expect(all).toHaveLength(2);
  });

  it('returns an empty array for invalid FTS syntax', () => {
    const scope = makeScope();
    adapter.insertTurn({
      ...scope,
      session_id: 's1',
      actor: 'user-1',
      role: 'user',
      content: 'The project uses sqlite',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The project uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    expect(adapter.searchTurns(scope, '"sqlite')).toHaveLength(1);
    expect(adapter.searchKnowledge(scope, '"unterminated')).toEqual([]);
  });

  it('respects search limits', () => {
    const scope = makeScope();
    for (let i = 0; i < 4; i += 1) {
      adapter.insertKnowledgeMemory({
        ...scope,
        fact: `memory fact ${i}`,
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
      });
    }

    expect(adapter.searchKnowledge(scope, 'memory', { limit: 2 })).toHaveLength(2);
  });
});
