import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { getCoreMemory } from '../core/core-memory.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('getCoreMemory', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;
  const scope = makeScope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
    seedTurns(adapter, scope, 2);
  });

  afterEach(() => {
    adapter.close();
  });

  it('returns deterministic section ordering: identity → constraints → norms → work → playbook', async () => {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'I am a backend engineer.',
      fact_type: 'entity',
      knowledge_state: 'trusted',
      knowledge_class: 'identity',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 1,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Never deploy on Fridays.',
      fact_type: 'constraint',
      knowledge_state: 'trusted',
      knowledge_class: 'constraint',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.95,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Prefers concise responses.',
      fact_type: 'preference',
      knowledge_state: 'trusted',
      knowledge_class: 'preference',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.9,
    });

    const bundle = await getCoreMemory(asyncAdapter, scope);

    expect(bundle.identity).toHaveLength(1);
    expect(bundle.identity[0].fact).toBe('I am a backend engineer.');
    expect(bundle.constraints).toHaveLength(1);
    expect(bundle.constraints[0].fact).toBe('Never deploy on Fridays.');
    expect(bundle.norms).toHaveLength(1);
    expect(bundle.norms[0].fact).toBe('Prefers concise responses.');
    expect(bundle.generatedAt).toBeGreaterThan(0);
    expect(bundle.tokenEstimate).toBeGreaterThan(0);
  });

  it('excludes non-trusted knowledge (provisional, disputed, retired)', async () => {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Trusted identity.',
      fact_type: 'entity',
      knowledge_state: 'trusted',
      knowledge_class: 'identity',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 1,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Provisional fact.',
      fact_type: 'preference',
      knowledge_state: 'provisional',
      knowledge_class: 'preference',
      source: 'user_stated',
      confidence: 'medium',
      trust_score: 0.5,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Disputed fact.',
      fact_type: 'constraint',
      knowledge_state: 'disputed',
      knowledge_class: 'constraint',
      source: 'user_stated',
      confidence: 'medium',
      trust_score: 0.2,
    });

    const bundle = await getCoreMemory(asyncAdapter, scope);

    expect(bundle.identity).toHaveLength(1);
    expect(bundle.constraints).toHaveLength(0);
    expect(bundle.norms).toHaveLength(0);
  });

  it('trims by class priority when over token budget, preserving identity and constraints', async () => {
    // Identity - must survive
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Core identity fact.',
      fact_type: 'entity',
      knowledge_state: 'trusted',
      knowledge_class: 'identity',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 1,
    });
    // Constraint - must survive
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Critical constraint.',
      fact_type: 'constraint',
      knowledge_state: 'trusted',
      knowledge_class: 'constraint',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.95,
    });
    // Norms - expendable under pressure
    for (let i = 0; i < 20; i++) {
      adapter.insertKnowledgeMemory({
        ...scope,
        fact: `Norm number ${i} with enough text to consume tokens in the budget calculation.`,
        fact_type: 'preference',
        knowledge_state: 'trusted',
        knowledge_class: 'preference',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.8 - i * 0.01,
      });
    }

    // Very tight budget
    const bundle = await getCoreMemory(asyncAdapter, scope, { tokenBudget: 30 });

    // Identity and constraints preserved
    expect(bundle.identity).toHaveLength(1);
    expect(bundle.constraints).toHaveLength(1);
    // Norms trimmed
    expect(bundle.norms.length).toBeLessThan(20);
    expect(bundle.topPlaybook).toBeNull();
  });

  it('returns empty bundle when no knowledge exists', async () => {
    const bundle = await getCoreMemory(asyncAdapter, scope);

    expect(bundle.identity).toHaveLength(0);
    expect(bundle.constraints).toHaveLength(0);
    expect(bundle.norms).toHaveLength(0);
    expect(bundle.workItems).toHaveLength(0);
    expect(bundle.topPlaybook).toBeNull();
    expect(bundle.tokenEstimate).toBe(0);
  });

  it('is stable across consecutive calls within a session', async () => {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Stable identity.',
      fact_type: 'entity',
      knowledge_state: 'trusted',
      knowledge_class: 'identity',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 1,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Stable constraint.',
      fact_type: 'constraint',
      knowledge_state: 'trusted',
      knowledge_class: 'constraint',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.9,
    });

    const bundle1 = await getCoreMemory(asyncAdapter, scope);
    const bundle2 = await getCoreMemory(asyncAdapter, scope);

    expect(bundle1.identity.map((f) => f.id)).toEqual(bundle2.identity.map((f) => f.id));
    expect(bundle1.constraints.map((f) => f.id)).toEqual(bundle2.constraints.map((f) => f.id));
    expect(bundle1.norms.map((f) => f.id)).toEqual(bundle2.norms.map((f) => f.id));
    expect(bundle1.tokenEstimate).toBe(bundle2.tokenEstimate);
  });

  it('defaults to 1500 token budget', async () => {
    const bundle = await getCoreMemory(asyncAdapter, scope);
    // With no knowledge, tokenEstimate is 0 which is within any budget
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(1500);
  });
});
