import { describe, it, expect, afterEach } from 'vitest';
import { createStreamCollector, processStreamingTurn } from '../core/streaming.js';
import { createMemory } from '../composition/quick.js';
import type { MemoryManager } from '../core/manager.js';

describe('streaming support', () => {
  let manager: MemoryManager;

  afterEach(async () => {
    if (manager) await manager.close();
  });

  it('collects chunks and commits as a single turn', async () => {
    manager = createMemory({ adapter: 'memory', scope: 'stream-test' });

    const collector = createStreamCollector(manager, 'assistant');
    collector.write('Hello ');
    collector.write('world');
    collector.write('!');

    expect(collector.getText()).toBe('Hello world!');

    const turn = await collector.finalize();
    expect(turn.content).toBe('Hello world!');
    expect(turn.role).toBe('assistant');
  });

  it('throws when writing after finalize', async () => {
    manager = createMemory({ adapter: 'memory', scope: 'stream-test' });

    const collector = createStreamCollector(manager, 'assistant');
    collector.write('data');
    await collector.finalize();

    expect(() => collector.write('more')).toThrow('cannot write after finalize');
  });

  it('throws when finalizing twice', async () => {
    manager = createMemory({ adapter: 'memory', scope: 'stream-test' });

    const collector = createStreamCollector(manager, 'assistant');
    collector.write('data');
    await collector.finalize();

    await expect(collector.finalize()).rejects.toThrow('already finalized');
  });

  it('processes async iterable streams', async () => {
    manager = createMemory({ adapter: 'memory', scope: 'stream-test' });

    async function* mockStream() {
      yield 'Part 1. ';
      yield 'Part 2. ';
      yield 'Part 3.';
    }

    const turn = await processStreamingTurn(manager, 'assistant', mockStream());
    expect(turn.content).toBe('Part 1. Part 2. Part 3.');
    expect(turn.role).toBe('assistant');
  });
});
