import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMemoryContext } from '../core/context.js';
import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('buildMemoryContext', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('assembles active turns, latest working memory, knowledge, and recent summaries', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 4);
    const firstSummary = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'Older summary',
      key_entities: ['docker'],
      topic_tags: ['infra'],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'soft',
    });
    const latestSummary = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'Latest summary',
      key_entities: ['memory'],
      topic_tags: ['context'],
      turn_id_start: 3,
      turn_id_end: 4,
      turn_count: 2,
      compaction_trigger: 'manual',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers reusable memory layers',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });

    const context = await buildMemoryContext(asyncAdapter, scope);
    expect(context.activeTurns).toHaveLength(4);
    expect(context.workingMemory?.id).toBe(latestSummary.id);
    expect(context.recentSummaries.map((item) => item.id)).toContain(firstSummary.id);
    expect(context.relevantKnowledge).toHaveLength(1);
    expect(context.knowledgeSelectionReasons).toHaveLength(1);
    expect(context.tokenEstimate).toBeGreaterThan(0);
  });

  it('uses relevanceQuery to rank matching knowledge first', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    const postgres = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system uses postgres for durable storage',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The UI uses tailwind',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const context = await buildMemoryContext(asyncAdapter, scope, { relevanceQuery: 'postgres' });
    expect(context.relevantKnowledge[0].id).toBe(postgres.id);
  });

  it('reinforces knowledge selected into context', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system uses postgres for durable storage',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const before = adapter.getKnowledgeMemoryById(knowledge.id)?.access_count ?? 0;
    const context = await buildMemoryContext(asyncAdapter, scope, { relevanceQuery: 'postgres' });
    const after = adapter.getKnowledgeMemoryById(knowledge.id)?.access_count ?? 0;

    expect(context.relevantKnowledge[0].id).toBe(knowledge.id);
    expect(after).toBeGreaterThan(before);
  });

  it('trims oldest turns first to meet the token budget', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 5, { tokenEstimate: 500 });

    const context = await buildMemoryContext(asyncAdapter, scope, { tokenBudget: 1200 });
    expect(context.activeTurns.length).toBeLessThan(5);
    expect(context.tokenEstimate).toBeLessThanOrEqual(1200);
  });

  it('returns empty context gracefully', async () => {
    const context = await buildMemoryContext(asyncAdapter, makeScope());
    expect(context.activeTurns).toEqual([]);
    expect(context.workingMemory).toBeNull();
    expect(context.relevantKnowledge).toEqual([]);
    expect(context.recentSummaries).toEqual([]);
  });

  it('includes active objectives and unresolved work items', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'objective',
      title: 'Ship the memory layer',
      status: 'in_progress',
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'unresolved_work',
      title: 'Fix retrieval edge cases',
      status: 'blocked',
    });

    const context = await buildMemoryContext(asyncAdapter, scope);
    expect(context.activeObjectives).toHaveLength(1);
    expect(context.unresolvedWork).toContain('Fix retrieval edge cases');
  });
});
