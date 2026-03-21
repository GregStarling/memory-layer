import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createRegexExtractor } from '../core/extractor.js';
import { makeScope } from './test-helpers.js';

describe('memory manager', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('processes turns and auto-compacts with extraction', async () => {
    const onEvent = vi.fn();
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: `The user prefers Rust after ${turns.length} turns.`,
        key_entities: ['Rust'],
        topic_tags: ['memory'],
      }),
      extractor: createRegexExtractor(),
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async (texts) => texts.map(() => new Float32Array([1, 0])),
      onEvent,
      monitorPolicy: {
        floorTurns: 2,
        floorTokens: 1,
        softTurnThreshold: 2,
        hardTurnThreshold: 4,
        softTokenThreshold: 10,
        hardTokenThreshold: 20,
      },
    });

    await manager.processTurn('user', 'I prefer Rust for memory systems.');
    await manager.processTurn('assistant', 'Understood.');

    expect(adapter.getActiveWorkingMemory(makeScope()).length).toBeGreaterThan(0);
    expect(adapter.getActiveKnowledgeMemory(makeScope()).length).toBeGreaterThan(0);
    expect(onEvent).toHaveBeenCalled();
    manager.close();
  });

  it('returns prompt-ready context', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    await manager.processTurn('user', 'hello');
    const context = manager.getContext();
    expect(context.activeTurns).toHaveLength(1);
    manager.close();
  });

  it('delegates lexical search', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    await manager.processTurn('user', 'remember postgres');
    expect(manager.search('postgres').turns).toHaveLength(1);
    manager.close();
  });

  it('can manually learn facts', () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
    });

    const fact = manager.learnFact('The project uses sqlite', 'reference');
    expect(fact.source).toBe('manual');
    manager.close();
  });
});
