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

  it('consolidates duplicate slot groups when enabled', async () => {
    const scope = makeScope();
    const older = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers Vim',
      fact_type: 'preference',
      fact_subject: 'user',
      fact_attribute: 'preference',
      fact_value: 'vim',
      normalized_fact: 'the user prefers vim',
      slot_key: 'user:preference:editor',
      source: 'manual',
      confidence: 'medium',
      confidence_score: 0.6,
    });
    const newer = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers Neovim',
      fact_type: 'preference',
      fact_subject: 'user',
      fact_attribute: 'preference',
      fact_value: 'neovim',
      normalized_fact: 'the user prefers neovim',
      slot_key: 'user:preference:editor',
      source: 'manual',
      confidence: 'high',
      confidence_score: 0.9,
    });

    const report = await runMaintenance(asyncAdapter, scope, {
      consolidateKnowledge: true,
      knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
      maxActiveKnowledgeItems: 10,
    });

    expect(report.retiredKnowledgeIds).toContain(older.id);
    expect(adapter.getKnowledgeMemoryById(newer.id)?.retired_at).toBeNull();
  });

  it('preserves lineage associations to retired knowledge that still exists', async () => {
    const scope = makeScope();
    const parent = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Deploy with manual verification',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const replacement = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Deploy with automated verification',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const association = adapter.insertAssociation({
      ...scope,
      source_kind: 'knowledge',
      source_id: replacement.id,
      target_kind: 'knowledge',
      target_id: parent.id,
      association_type: 'supersedes',
      confidence: 0.9,
    });
    adapter.retireKnowledgeMemory(parent.id, Math.floor(Date.now() / 1000));

    const report = await runMaintenance(asyncAdapter, scope, {
      knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
      maxActiveKnowledgeItems: 10,
    });

    expect(report.deletedAssociationIds).not.toContain(association.id);
    expect(adapter.getAssociationById(association.id)).not.toBeNull();
  });
});
