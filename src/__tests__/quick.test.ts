import { describe, expect, it } from 'vitest';

import { createMemory } from '../core/quick.js';

describe('createMemory quick factory', () => {
  it('works with zero config', async () => {
    const memory = createMemory();
    await memory.processTurn('user', 'Remember that local-first matters.');
    const context = await memory.getContext('local-first');
    expect(context.activeTurns).toHaveLength(1);
    await memory.close();
  });

  it('supports string scope shorthand and in-memory adapter', async () => {
    const memory = createMemory({
      adapter: 'memory',
      scope: 'my-agent',
      autoCompact: false,
    });
    await memory.processExchange('hello', 'hi');
    const recall = await memory.recall({ start_at: 0 });
    expect(recall.turns).toHaveLength(2);
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
});
