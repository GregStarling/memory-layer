import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMemoryContext } from '../core/context.js';
import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('buildMemoryContext', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('assembles active turns, latest working memory, knowledge, and recent summaries', () => {
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

    const context = buildMemoryContext(adapter, scope);
    expect(context.activeTurns).toHaveLength(4);
    expect(context.workingMemory?.id).toBe(latestSummary.id);
    expect(context.recentSummaries.map((item) => item.id)).toContain(firstSummary.id);
    expect(context.relevantKnowledge).toHaveLength(1);
    expect(context.tokenEstimate).toBeGreaterThan(0);
  });

  it('uses relevanceQuery to rank matching knowledge first', () => {
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

    const context = buildMemoryContext(adapter, scope, { relevanceQuery: 'postgres' });
    expect(context.relevantKnowledge[0].id).toBe(postgres.id);
  });

  it('trims oldest turns first to meet the token budget', () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 5, { tokenEstimate: 500 });

    const context = buildMemoryContext(adapter, scope, { tokenBudget: 1200 });
    expect(context.activeTurns.length).toBeLessThan(5);
    expect(context.tokenEstimate).toBeLessThanOrEqual(1200);
  });

  it('returns empty context gracefully', () => {
    const context = buildMemoryContext(adapter, makeScope());
    expect(context.activeTurns).toEqual([]);
    expect(context.workingMemory).toBeNull();
    expect(context.relevantKnowledge).toEqual([]);
    expect(context.recentSummaries).toEqual([]);
  });
});
