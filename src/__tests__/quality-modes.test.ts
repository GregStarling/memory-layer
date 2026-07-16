import { afterEach, describe, expect, it } from 'vitest';

import { createMemory } from '../composition/quick.js';

async function buildExtractedMemory(options: {
  qualityMode?: 'fast_adoption' | 'balanced_memory' | 'high_fidelity_memory';
  qualityTier?: 'offline_default' | 'local_semantic' | 'provider_backed';
  turn: string;
  summary: string;
  fact: { fact: string; factType: 'constraint' | 'decision' | 'reference'; confidence: 'high' | 'medium' };
}) {
  const memory = createMemory({
    adapter: 'memory',
    qualityMode: options.qualityMode,
    qualityTier: options.qualityTier,
    summarizer: async () => ({
      summary: options.summary,
      key_entities: [],
      topic_tags: [],
    }),
    extractor: async () => [options.fact],
    policies: {
      monitor: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 1,
        hardTurnThreshold: 1,
        softTokenThreshold: 1,
        hardTokenThreshold: 1,
      },
    },
  });

  await memory.processTurn('user', options.turn);
  await memory.forceCompact();
  return memory;
}

describe('quality modes', () => {
  const created: Array<Awaited<ReturnType<typeof buildExtractedMemory>>> = [];

  afterEach(async () => {
    await Promise.all(created.splice(0).map((memory) => memory.close()));
  });

  it('yields different trust outcomes across quality modes for the same session', async () => {
    const fast = await buildExtractedMemory({
      qualityMode: 'fast_adoption',
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    const balanced = await buildExtractedMemory({
      qualityMode: 'balanced_memory',
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    const high = await buildExtractedMemory({
      qualityMode: 'high_fidelity_memory',
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    created.push(fast, balanced, high);

    const fastKnowledge = (await fast.recall({ start_at: 0 })).knowledge;
    const balancedKnowledge = (await balanced.recall({ start_at: 0 })).knowledge;
    const highKnowledge = (await high.recall({ start_at: 0 })).knowledge;

    expect(fastKnowledge[0]?.knowledge_state).toBe('trusted');
    expect(balancedKnowledge[0]?.knowledge_state).toBe('provisional');
    expect(highKnowledge[0]?.knowledge_state).toBe('provisional');
  });

  it('the recommended default is safer than fast adoption for weakly grounded memory', async () => {
    const fast = await buildExtractedMemory({
      qualityMode: 'fast_adoption',
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    const recommended = await buildExtractedMemory({
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    created.push(fast, recommended);

    const fastKnowledge = (await fast.recall({ start_at: 0 })).knowledge;
    const recommendedKnowledge = (await recommended.recall({ start_at: 0 })).knowledge;

    expect(fastKnowledge[0]?.knowledge_state).toBe('trusted');
    expect(recommendedKnowledge[0]?.knowledge_state).toBe('provisional');
  });

  it('high-fidelity mode retains constraints more safely than fast adoption', async () => {
    const fast = createMemory({
      adapter: 'memory',
      qualityMode: 'fast_adoption',
      autoCompact: false,
      autoExtract: false,
    });
    const high = createMemory({
      adapter: 'memory',
      qualityMode: 'high_fidelity_memory',
      autoCompact: false,
      autoExtract: false,
    });
    created.push(fast, high);

    const originalNow = Date.now;
    Date.now = () => new Date('2024-01-01T00:00:00Z').valueOf();
    try {
      await fast.learnFact('The system must remain local-first.', 'constraint', 'high');
      await high.learnFact('The system must remain local-first.', 'constraint', 'high');
      Date.now = () => new Date('2024-06-01T00:00:00Z').valueOf();
      await fast.runMaintenance({
        knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
        maxActiveKnowledgeItems: 20,
      });
      await high.runMaintenance({
        knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
        maxActiveKnowledgeItems: 20,
      });
    } finally {
      Date.now = originalNow;
    }

    const fastKnowledge = (await fast.recall({ start_at: 0 })).knowledge;
    const highKnowledge = (await high.recall({ start_at: 0 })).knowledge;

    expect(fastKnowledge[0]?.knowledge_state).not.toBe('trusted');
    expect(highKnowledge[0]?.knowledge_state).toBe('trusted');
  });

  it('maps legacy quality tiers onto the new quality modes', async () => {
    const legacy = await buildExtractedMemory({
      qualityTier: 'offline_default',
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    const modern = await buildExtractedMemory({
      qualityMode: 'balanced_memory',
      turn: 'Use smaller batches for the migration.',
      summary: 'Use smaller batches for the migration.',
      fact: { fact: 'Use smaller batches for the migration.', factType: 'decision', confidence: 'high' },
    });
    created.push(legacy, modern);

    const legacyState = (await legacy.recall({ start_at: 0 })).knowledge[0]?.knowledge_state;
    const modernState = (await modern.recall({ start_at: 0 })).knowledge[0]?.knowledge_state;

    expect(legacyState).toBe(modernState);
  });
});
