import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('temporal recall', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('returns turns, working memory, knowledge, and work items by time range', () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 2, { baseTime: 100 });
    adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'summary',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The project uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: sessionId,
      kind: 'objective',
      title: 'Ship the memory layer',
      status: 'open',
      created_at: 100,
    });

    expect(adapter.getTurnsByTimeRange(scope, { start_at: 100, end_at: 200 })).toHaveLength(2);
    expect(adapter.getWorkingMemoryByTimeRange(scope, { start_at: 0 })).toHaveLength(1);
    expect(adapter.getKnowledgeByTimeRange(scope, { start_at: 0 })).toHaveLength(1);
    expect(adapter.getWorkItemsByTimeRange(scope, { start_at: 100, end_at: 200 })).toHaveLength(1);
  });
});
