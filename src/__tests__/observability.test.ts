import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { buildMemoryContext } from '../core/context.js';
import { compactTurns } from '../core/orchestrator.js';
import { noopLogger } from '../contracts/observability.js';
import type { MemoryEvent } from '../contracts/observability.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('observability', () => {
  let events: MemoryEvent[];
  let adapter: StorageAdapter;

  beforeEach(() => {
    events = [];
    adapter = createSQLiteAdapter(':memory:', {
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    });
  });

  afterEach(() => {
    adapter.close();
  });

  it('noopLogger does not throw', () => {
    expect(() => noopLogger.debug('msg')).not.toThrow();
    expect(() => noopLogger.info('msg')).not.toThrow();
  });

  it('emits search events from the adapter', () => {
    const scope = makeScope();
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The project uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    adapter.searchKnowledge(scope, 'sqlite');
    expect(events.some((event) => event.type === 'search')).toBe(true);
  });

  it('emits compaction events', async () => {
    const scope = makeScope();
    const { sessionId, turns } = seedTurns(adapter, scope, 4);

    await compactTurns(
      adapter,
      scope,
      sessionId,
      turns,
      async () => ({
        summary: 'summary',
        key_entities: ['memory'],
        topic_tags: ['compaction'],
      }),
      'soft',
      1,
      {
        logger: noopLogger,
        onEvent: (event) => events.push(event),
      },
    );

    expect(events.some((event) => event.type === 'compaction')).toBe(true);
  });

  it('emits context assembly events', () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);

    buildMemoryContext(adapter, scope, {
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    });

    const event = events.find((entry) => entry.type === 'context_assembly');
    expect(event?.meta.activeTurnCount).toBe(2);
  });

  it('passes logger metadata through telemetry calls', () => {
    const debug = vi.fn();
    const scope = makeScope();
    const observedAdapter = createSQLiteAdapter(':memory:', {
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    observedAdapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    observedAdapter.searchKnowledge(scope, 'sqlite');

    expect(debug).toHaveBeenCalled();
    observedAdapter.close();
  });
});
