import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createRegexExtractor } from '../core/extractor.js';
import { makeScope } from './test-helpers.js';

describe('promoteResponse', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function makeManager(overrides = {}) {
    return createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: turns.map((t) => t.content).join(' '),
        key_entities: [],
        topic_tags: [],
      }),
      extractor: createRegexExtractor(),
      ...overrides,
    });
  }

  it('promotes an assistant turn and creates knowledge', async () => {
    const manager = makeManager();
    await manager.processTurn('user', 'What do you recommend?');
    const assistantTurn = await manager.processTurn(
      'assistant',
      'The user prefers TypeScript for backend development.',
    );

    const knowledge = await manager.promoteResponse(assistantTurn.id);
    expect(knowledge.length).toBeGreaterThan(0);
    expect(knowledge[0].fact).toBeTruthy();

    // Verify knowledge is persisted
    const listed = await manager.listKnowledge();
    expect(listed.items.length).toBeGreaterThanOrEqual(knowledge.length);
    await manager.close();
  });

  it('rejects non-assistant turns', async () => {
    const manager = makeManager();
    const userTurn = await manager.processTurn('user', 'I prefer Rust.');

    await expect(manager.promoteResponse(userTurn.id)).rejects.toThrow(
      /only assistant turns/,
    );
    await manager.close();
  });

  it('rejects non-existent turn IDs', async () => {
    const manager = makeManager();

    await expect(manager.promoteResponse(9999)).rejects.toThrow(/not found/);
    await manager.close();
  });

  it('rejects turns from a different scope', async () => {
    const otherScope = makeScope({ scope_id: 'other-thread' });
    const turn = adapter.insertTurn({
      ...otherScope,
      session_id: 'other-session',
      role: 'assistant',
      content: 'The user prefers Python.',
      actor: 'assistant',
      token_estimate: 10,
    });

    const manager = makeManager();
    await expect(manager.promoteResponse(turn.id)).rejects.toThrow(
      /does not belong to the current scope/,
    );
    await manager.close();
  });

  it('returns empty array when no facts are extractable', async () => {
    const manager = makeManager();
    await manager.processTurn('user', 'Hello');
    const assistantTurn = await manager.processTurn('assistant', 'Hello there!');

    const knowledge = await manager.promoteResponse(assistantTurn.id);
    expect(knowledge).toEqual([]);
    await manager.close();
  });

  it('throws when no extractor is configured', async () => {
    const manager = makeManager({ extractor: undefined });
    await manager.processTurn('user', 'Hello');
    const assistantTurn = await manager.processTurn('assistant', 'The user prefers TypeScript.');

    await expect(manager.promoteResponse(assistantTurn.id)).rejects.toThrow(
      /extractor is required/,
    );
    await manager.close();
  });

  it('filters by minConfidence option', async () => {
    const manager = makeManager();
    await manager.processTurn('user', 'What do you recommend?');
    const assistantTurn = await manager.processTurn(
      'assistant',
      'The user prefers TypeScript for backend development.',
    );

    // The regex extractor produces 'medium' confidence facts.
    // Filtering for 'high' should exclude them.
    const highOnly = await manager.promoteResponse(assistantTurn.id, {
      minConfidence: 'high',
    });
    expect(highOnly).toEqual([]);
    await manager.close();
  });
});
