import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemory } from '../core/quick.js';

describe('createMemory quick factory', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('works with zero config', async () => {
    const memory = createMemory();
    await memory.processTurn('user', 'Remember that local-first matters.');
    const context = await memory.getContext('local-first');
    expect(context.activeTurns).toHaveLength(1);
    await memory.close();
  });

  it('uses the local semantic tier by default for manual facts on sqlite', async () => {
    const memory = createMemory();
    await memory.learnFact('The project relies on PostgreSQL for analytics', 'reference');
    const context = await memory.getContext('analytics postgres');
    expect(context.relevantKnowledge.some((item) => item.fact.includes('PostgreSQL'))).toBe(true);
    await memory.close();
  });

  it('maps string scope shorthand to scope_id for the quick path', async () => {
    const memory = createMemory({
      adapter: 'memory',
      scope: 'my-agent',
      autoCompact: false,
    });
    await memory.processExchange('hello', 'hi');
    const recall = await memory.recall({ start_at: 0 });
    expect(recall.turns).toHaveLength(2);
    expect(recall.turns[0]?.scope_id).toBe('my-agent');
    expect(recall.turns[0]?.system_id).toBe('default');
    await memory.close();
  });

  it('supports provider summarizer selection through a custom client', async () => {
    const memory = createMemory({
      adapter: 'memory',
      summarizer: 'claude',
      extractor: false,
      summarizerOptions: {
        client: {
          async generate() {
            return '{"summary":"provider summary","key_entities":["memory"],"topic_tags":["tests"]}';
          },
        },
      },
      policies: {
        monitor: {
          floorTurns: 1,
          floorTokens: 1,
          softTurnThreshold: 10,
          hardTurnThreshold: 2,
          softTokenThreshold: 5000,
          hardTokenThreshold: 5,
        },
      },
    });

    await memory.processTurn('user', 'one');
    await memory.processTurn('assistant', 'two');
    const bootstrap = await memory.getSessionBootstrap();
    expect(bootstrap.workingMemory?.summary).toBe('provider summary');
    await memory.close();
  });

  it('auto-detects provider embedding credentials when available', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        async json() {
          return {
            data: [{ embedding: [1, 0, 0] }],
          };
        },
      })),
    );

    const memory = createMemory({
      adapter: 'sqlite',
      path: ':memory:',
      autoCompact: false,
      autoExtract: false,
    });

    await memory.learnFact('The project relies on PostgreSQL for analytics', 'reference');
    const context = await memory.getContext('analytics postgres');

    expect(context.relevantKnowledge.some((item) => item.fact.includes('PostgreSQL'))).toBe(true);
    expect(fetch).toHaveBeenCalled();
    await memory.close();
  });

  it('emits a capability report for the selected local tier', async () => {
    const events: Array<{ type: string; meta: Record<string, unknown> }> = [];
    const memory = createMemory({
      onEvent: (event) => events.push(event),
    });

    const capabilityEvent = events.find((event) => event.type === 'capability');
    expect(capabilityEvent?.meta.storageKind).toBe('memory');
    expect(capabilityEvent?.meta.extractorTier).toBe('local_heuristic');
    expect(capabilityEvent?.meta.embeddingTier).toBe('local_semantic');

    await memory.close();
  });
});
