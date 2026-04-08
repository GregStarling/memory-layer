import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { MemoryContext } from '../core/context.js';
import { getFactsAt } from '../core/temporal.js';
import { makeScope } from './test-helpers.js';

function makeKnowledge(
  adapter: StorageAdapter,
  scope: ReturnType<typeof makeScope>,
  overrides: Partial<Parameters<StorageAdapter['insertKnowledgeMemory']>[0]> = {},
): KnowledgeMemory {
  return adapter.insertKnowledgeMemory({
    ...scope,
    fact: 'test fact',
    fact_type: 'reference',
    source: 'manual',
    confidence: 'high',
    ...overrides,
  });
}

function emptyContext(): MemoryContext {
  return {
    mode: 'full',
    activeTurns: [],
    workingMemory: null,
    trustedCoreMemory: [],
    taskRelevantKnowledge: [],
    provisionalKnowledge: [],
    disputedKnowledge: [],
    relevantKnowledge: [],
    durableKnowledge: [],
    recentSummaries: [],
    currentObjective: null,
    sessionState: {
      currentObjective: null,
      blockers: [],
      assumptions: [],
      pendingDecisions: [],
      activeTools: [],
      recentOutputs: [],
    },
    activeObjectives: [],
    activeState: [],
    unresolvedWork: [],
    openWorkItems: [],
    activePlaybooks: [],
    associationGraph: { nodes: [], edges: [] },
    debugTrace: null,
  };
}

describe('getFactsAt', () => {
  let syncAdapter: StorageAdapter;
  let adapter: AsyncStorageAdapter;
  const scope = makeScope();

  beforeEach(() => {
    syncAdapter = createSQLiteAdapter(':memory:');
    adapter = wrapSyncAdapter(syncAdapter);
  });

  afterEach(() => {
    syncAdapter.close();
  });

  it('returns windowed facts matching the timestamp (fast path)', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'Q1 target is 100 users',
      valid_from: 100,
      valid_until: 200,
    });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 150,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(true);
    expect(result.queryTimestamp).toBe(150);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].fact).toBe('Q1 target is 100 users');
  });

  it('excludes windowed facts outside the timestamp range', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'Expired policy',
      valid_from: 100,
      valid_until: 200,
    });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 300,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(true);
    expect(result.facts).toHaveLength(0);
  });

  it('includes facts with only valid_from set when timestamp is after', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'Open-ended fact',
      valid_from: 100,
    });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 500,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(true);
    expect(result.facts).toHaveLength(1);
  });

  it('excludes facts with valid_from in the future', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'Future fact',
      valid_from: 1000,
    });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 500,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(true);
    expect(result.facts).toHaveLength(0);
  });

  it('returns non-windowed facts as-is when fallback is disabled', async () => {
    makeKnowledge(syncAdapter, scope, { fact: 'No window fact' });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 150,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(false);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].fact).toBe('No window fact');
  });

  it('delegates to getContextAt for non-windowed facts when fallback is enabled', async () => {
    const noWindowFact = makeKnowledge(syncAdapter, scope, {
      fact: 'No window fact',
    });
    makeKnowledge(syncAdapter, scope, {
      fact: 'Windowed fact',
      valid_from: 100,
      valid_until: 200,
    });

    const mockContext = emptyContext();
    mockContext.trustedCoreMemory = [{ ...noWindowFact } as KnowledgeMemory];

    const mockGetContextAt = vi.fn().mockResolvedValue(mockContext);

    const result = await getFactsAt(adapter, mockGetContextAt, {
      timestamp: 150,
      scope,
      fallbackToReplay: true,
    });

    expect(result.usedFastPath).toBe(false);
    expect(mockGetContextAt).toHaveBeenCalledWith(150);
    expect(result.facts).toHaveLength(2);
    const factTexts = result.facts.map((f) => f.fact).sort();
    expect(factTexts).toEqual(['No window fact', 'Windowed fact']);
  });

  it('filters by knowledgeClass when specified', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'Identity fact',
      knowledge_class: 'identity',
      valid_from: 100,
      valid_until: 200,
    });

    makeKnowledge(syncAdapter, scope, {
      fact: 'Preference fact',
      knowledge_class: 'preference',
      valid_from: 100,
      valid_until: 200,
    });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 150,
      scope,
      knowledgeClass: 'identity',
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(true);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].fact).toBe('Identity fact');
  });

  it('handles mixed windowed and non-windowed facts', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'Windowed fact',
      valid_from: 100,
      valid_until: 300,
    });

    makeKnowledge(syncAdapter, scope, { fact: 'No window fact' });

    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 150,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(false);
    expect(result.facts).toHaveLength(2);
  });

  it('returns empty facts when no knowledge exists', async () => {
    const result = await getFactsAt(adapter, vi.fn(), {
      timestamp: 150,
      scope,
      fallbackToReplay: false,
    });

    expect(result.usedFastPath).toBe(true);
    expect(result.facts).toHaveLength(0);
    expect(result.queryTimestamp).toBe(150);
  });

  it('does not call getContextAt when all facts have windows', async () => {
    makeKnowledge(syncAdapter, scope, {
      fact: 'All windowed',
      valid_from: 100,
      valid_until: 200,
    });

    const mockGetContextAt = vi.fn();

    const result = await getFactsAt(adapter, mockGetContextAt, {
      timestamp: 150,
      scope,
      fallbackToReplay: true,
    });

    expect(result.usedFastPath).toBe(true);
    expect(mockGetContextAt).not.toHaveBeenCalled();
  });
});
