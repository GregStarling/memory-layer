import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import {
  commitCompaction,
  compactTurns,
  promoteToKnowledge,
} from '../core/orchestrator.js';
import { createSessionId } from '../core/tokens.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { Turn } from '../contracts/types.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

describe('orchestrator workflows', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  function seedTurns(memoryScope: MemoryScope, count: number): { sessionId: string; turns: Turn[] } {
    const sessionId = createSessionId(memoryScope);
    const turns: Turn[] = [];
    for (let i = 0; i < count; i += 1) {
      turns.push(
        adapter.insertTurn({
          ...memoryScope,
          session_id: sessionId,
          actor: i % 2 === 0 ? 'user-1' : 'assistant-1',
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `turn-${i}`,
          token_estimate: 100,
          created_at: 1_700_000_000 + i,
        }),
      );
    }
    return { sessionId, turns };
  }

  it('compacts older turns and retains the requested tail', async () => {
    const memoryScope = scope();
    const { sessionId, turns } = seedTurns(memoryScope, 6);

    const result = await compactTurns(
      asyncAdapter,
      memoryScope,
      sessionId,
      turns,
      async (turnsToSummarize) => ({
        summary: `summarized ${turnsToSummarize.length} turns`,
        key_entities: ['memory'],
        topic_tags: ['compaction'],
      }),
      'soft',
      2,
    );

    expect(result.archivedTurnIds).toEqual(turns.slice(0, 4).map((turn) => turn.id));
    expect(adapter.getActiveTurns(memoryScope)).toHaveLength(2);
    expect(result.compactionLog.turns_compacted).toBe(4);
    expect(result.workingMemory.turn_count).toBe(4);
  });

  it('promotes working memory into knowledge memory and links it back', async () => {
    const memoryScope = scope();
    const { sessionId } = seedTurns(memoryScope, 2);
    const workingMemory = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'A useful summary',
      key_entities: ['cursor'],
      topic_tags: ['memory'],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });

    const knowledge = await promoteToKnowledge(asyncAdapter, workingMemory.id, {
      scope: memoryScope,
      fact: 'The user likes reusable memory packages',
      factType: 'preference',
      confidence: 'high',
    });

    expect(knowledge.source).toBe('promoted_from_working');
    expect(adapter.getWorkingMemoryById(workingMemory.id)?.promoted_to_knowledge_id).toBe(
      knowledge.id,
    );
  });

  it('propagates errors from transaction operations', async () => {
    const memoryScope = scope();
    const { sessionId, turns } = seedTurns(memoryScope, 3);
    let archiveCalls = 0;

    const unstableAsyncAdapter: AsyncStorageAdapter = {
      ...asyncAdapter,
      async archiveTurn(id, archivedAt, compactionLogId) {
        archiveCalls += 1;
        if (archiveCalls === 1) {
          throw new Error('simulated archive failure');
        }
        adapter.archiveTurn(id, archivedAt, compactionLogId);
      },
    };

    await expect(
      commitCompaction(unstableAsyncAdapter, {
        scope: memoryScope,
        sessionId,
        summary: 'rollback me',
        keyEntities: ['memory'],
        topicTags: ['rollback'],
        turnsToArchive: turns.slice(0, 2),
        activeTurnCountBefore: 3,
        activeTurnCountAfter: 1,
        trigger: 'soft',
        durationMs: 5,
        modelCallMade: false,
      }),
    ).rejects.toThrow('simulated archive failure');
  });
});
