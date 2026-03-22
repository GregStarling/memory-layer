import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { runMaintenance } from '../core/maintenance.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { makeScope } from './test-helpers.js';

describe('maintenance workflow', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
    vi.useRealTimers();
  });

  it('expires working memory, retires stale knowledge, and deletes completed work items', async () => {
    const scope = makeScope();
    adapter.insertWorkingMemory({
      ...scope,
      session_id: 'session-1',
      summary: 'old summary',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
      expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Obsolete preference',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });
    const retained = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Important reference',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.touchKnowledgeMemory(retained.id);
    const workItem = adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      title: 'Completed task',
      kind: 'objective',
      status: 'done',
    });

    vi.setSystemTime(new Date('2024-01-10T00:00:00Z'));

    const report = await runMaintenance(asyncAdapter, scope, {
      workingMemoryTtlSeconds: 1,
      knowledgeStaleAfterSeconds: 1,
      minKnowledgeAccessCount: 1,
      maxActiveKnowledgeItems: 1,
      completedWorkItemTtlSeconds: 1,
    });

    expect(report.expiredWorkingMemoryIds).toHaveLength(1);
    expect(report.retiredKnowledgeIds.length).toBeGreaterThan(0);
    expect(report.deletedWorkItemIds).toContain(workItem.id);
    expect(
      adapter.getWorkItemsByTimeRange(scope, {
        start_at: 0,
        end_at: Math.floor(Date.now() / 1000),
      }),
    ).toHaveLength(0);
    expect(adapter.getActiveKnowledgeMemory(scope).map((item) => item.id)).toEqual([retained.id]);
  });
});
