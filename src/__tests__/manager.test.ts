import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryEventEmitter } from '../core/events.js';
import { createMemoryManager } from '../core/manager.js';
import { createClaudeMemoryManager } from '../core/provider-managers.js';
import { createRegexExtractor } from '../core/extractor.js';
import { makeScope } from './test-helpers.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';

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
        softTurnThreshold: 10,
        hardTurnThreshold: 2,
        softTokenThreshold: 5000,
        hardTokenThreshold: 10,
      },
    });

    await manager.processTurn('user', 'I prefer Rust for memory systems.');
    await manager.processTurn('assistant', 'Understood.');

    expect(adapter.getActiveWorkingMemory(makeScope()).length).toBeGreaterThan(0);
    expect(adapter.getActiveKnowledgeMemory(makeScope()).length).toBeGreaterThan(0);
    expect(onEvent).toHaveBeenCalled();
    await manager.close();
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
    const context = await manager.getContext();
    expect(context.activeTurns).toHaveLength(1);
    await manager.close();
  });

  it('can build temporal snapshots with getContextAt', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    await manager.processTurn('user', 'first');
    const cutoff = Math.floor(Date.now() / 1000);
    await manager.processTurn('assistant', 'second');

    const context = await manager.getContextAt(cutoff);
    expect(context.activeTurns.map((turn) => turn.content)).toContain('first');
    await manager.close();
  });

  it('returns hybrid search results', async () => {
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
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([1, 0])],
    });

    await manager.processTurn('user', 'remember postgres');
    const knowledge = adapter.insertKnowledgeMemory({
      ...makeScope(),
      fact: 'The project uses postgres',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const results = await manager.search('postgres');
    expect(results.turns).toHaveLength(1);
    expect(results.knowledge.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('uses semantic retrieval in getContext when embeddings are configured', async () => {
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
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([1, 0])],
    });

    const knowledge = adapter.insertKnowledgeMemory({
      ...makeScope(),
      fact: 'The project uses sqlite for local-first storage',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const context = await manager.getContext('local-first');
    expect(context.relevantKnowledge.map((item) => item.id)).toContain(knowledge.id);
    await manager.close();
  });

  it('can manually learn facts', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([0.5, 0.5])],
    });

    const fact = await manager.learnFact('The project uses sqlite', 'reference');
    expect(fact.source).toBe('manual');
    expect(adapter.embeddings.getEmbedding(fact.id)).not.toBeNull();
    await manager.close();
  });

  it('rejects reverification for knowledge outside the manager scope', async () => {
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

    const foreign = adapter.insertKnowledgeMemory({
      ...makeScope({ scope_id: 'other-thread' }),
      fact: 'Foreign knowledge',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    await expect(manager.reverifyKnowledge(foreign.id)).rejects.toThrow(
      'does not belong to the requested scope',
    );
    await manager.close();
  });

  it('can process an exchange in one memory cycle', async () => {
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

    const result = await manager.processExchange('hello', 'hi there');
    expect(result.userTurn.role).toBe('user');
    expect(result.assistantTurn.role).toBe('assistant');
    await manager.close();
  });

  it('builds session bootstrap from prior memory', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'Need to finish memory work. The project uses sqlite.',
        key_entities: ['sqlite'],
        topic_tags: ['memory'],
      }),
      autoCompact: false,
    });

    adapter.insertWorkingMemory({
      ...makeScope(),
      session_id: 'prior-session',
      summary: 'Need to finish memory work.',
      key_entities: ['memory'],
      topic_tags: ['continuity'],
      turn_id_start: 1,
      turn_id_end: 1,
      turn_count: 1,
      compaction_trigger: 'manual',
    });
    adapter.insertKnowledgeMemory({
      ...makeScope(),
      fact: 'The project uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const bootstrap = await manager.getSessionBootstrap('sqlite');
    expect(bootstrap.workingMemory).toBeNull();
    expect(bootstrap.relevantKnowledge.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('keeps active turns and working memory isolated to the current session', async () => {
    const scope = makeScope();
    const managerA = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-a',
      summarizer: async () => ({
        summary: 'session a summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });
    const managerB = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-b',
      summarizer: async () => ({
        summary: 'session b summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await managerA.processTurn('user', 'alpha one');
    await managerA.processTurn('assistant', 'alpha two');
    await managerB.processTurn('user', 'beta one');
    await managerB.processTurn('assistant', 'beta two');

    const contextA = await managerA.getContext();
    const contextB = await managerB.getContext();

    expect(contextA.activeTurns.map((turn) => turn.content)).toEqual(['alpha two']);
    expect(contextB.activeTurns.map((turn) => turn.content)).toEqual(['beta two']);
    expect(contextA.workingMemory?.summary).toBe('session a summary');
    expect(contextB.workingMemory?.summary).toBe('session b summary');

    await managerA.close();
    await managerB.close();
  });

  it('persists monitor state and defers soft compaction until forced', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 2,
        hardTurnThreshold: 10,
        softTokenThreshold: 5,
        hardTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'This should trigger soft compaction.');
    await manager.processTurn('assistant', 'Acknowledged.');

    expect(adapter.getContextMonitor(scope)?.compaction_state).toBe('soft_triggered');
    expect(adapter.getActiveWorkingMemory(scope)).toHaveLength(0);

    await manager.forceCompact();
    expect(adapter.getActiveWorkingMemory(scope).length).toBeGreaterThan(0);
    expect(adapter.getContextMonitor(scope)?.compaction_state).toBe('idle');
    await manager.close();
  });

  it('supports typed event subscriptions', async () => {
    const emitter = createMemoryEventEmitter();
    const managerEvents = vi.fn();
    emitter.on('manager', managerEvents);
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
      eventEmitter: emitter,
    });

    await manager.processTurn('user', 'hello');
    expect(managerEvents).toHaveBeenCalled();
    await manager.close();
  });

  it('can disable auto extract after extractor failure', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: `summary ${turns.length}`,
        key_entities: [],
        topic_tags: [],
      }),
      extractor: async () => {
        throw new Error('extract failed');
      },
      failurePolicy: {
        extractor: 'disable_auto_extract',
      },
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'The project uses sqlite.');
    await manager.processTurn('user', 'The project uses sqlite.');
    await manager.processTurn('user', 'three');
    await manager.processTurn('assistant', 'four');

    expect(adapter.getActiveWorkingMemory(makeScope()).length).toBeGreaterThan(0);
    expect(adapter.getActiveKnowledgeMemory(makeScope())).toEqual([]);
    await manager.close();
  });

  it('resets monitor state when summarizer falls back to log_and_continue', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => {
        throw new Error('summary failed');
      },
      failurePolicy: {
        summarizer: 'log_and_continue',
      },
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'one');
    await manager.processTurn('assistant', 'two');

    expect(adapter.getContextMonitor(scope)?.compaction_state).toBe('idle');
    expect(adapter.getActiveWorkingMemory(scope)).toHaveLength(0);
    await manager.close();
  });

  it('tracks work items and recalls by time range', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    await manager.trackWorkItem('Ship the memory layer', 'objective', 'in_progress');
    const recall = await manager.recall({ start_at: 0, end_at: Math.floor(Date.now() / 1000) + 10 });
    expect(recall.workItems).toHaveLength(1);
    await manager.close();
  });

  it('creates a provider-backed memory manager with default wiring', async () => {
    const manager = createClaudeMemoryManager({
      dbPath: ':memory:',
      scope: makeScope(),
      summarizer: {
        client: {
          async generate(request) {
            if (request.expectedFormat === 'object') {
              return '{"summary":"Provider summary","key_entities":["memory"],"topic_tags":["sdk"]}';
            }
            return '[{"fact":"The project uses sqlite","factType":"reference","confidence":"high"}]';
          },
        },
      },
      extractor: {
        client: {
          async generate(request) {
            if (request.expectedFormat === 'object') {
              return '{"summary":"Provider summary","key_entities":["memory"],"topic_tags":["sdk"]}';
            }
            return '[{"fact":"The project uses sqlite","factType":"reference","confidence":"high"}]';
          },
        },
      },
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'The project uses sqlite.');
    await manager.processTurn('user', 'The project uses sqlite.');
    const context = await manager.getContext('sqlite');
    expect(
      context.relevantKnowledge.some((item) => item.fact.includes('sqlite')) ||
        context.provisionalKnowledge.some((item) => item.fact.includes('sqlite')),
    ).toBe(true);
    await manager.close();
  });

  it('treats a long intra-session gap as a compaction boundary', async () => {
    const scope = makeScope();
    adapter.insertTurn({
      ...scope,
      session_id: 'session-gap',
      actor: 'user',
      role: 'user',
      content: 'old turn',
      created_at: 1,
    });

    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-gap',
      summarizer: async () => ({
        summary: 'session gap summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 50,
        hardTurnThreshold: 100,
        softTokenThreshold: 50_000,
        hardTokenThreshold: 100_000,
        intraSessionGapSeconds: 10,
      },
    });

    await manager.processTurn('assistant', 'new turn after a long gap');
    expect(adapter.getActiveWorkingMemory(scope).length).toBeGreaterThan(0);
    await manager.close();
  });

  describe('episodic and cognitive methods', () => {
    function createMockStructuredClient(): StructuredGenerationClient {
      return {
        async generate(req) {
          if (req.systemPrompt.includes('episodic recaps')) {
            return JSON.stringify({
              objective: 'Discussed Rust preferences',
              actions: ['stated preference for Rust'],
              outcomes: ['preference recorded'],
              artifacts: [],
              unresolvedItems: [],
              sourceType: 'episodic',
              sources: [{ type: 'turn', id: 1, excerpt: 'I prefer Rust' }],
            });
          }
          return JSON.stringify({
            synthesis: 'The user prefers Rust for memory systems.',
            sourceType: 'mixed',
            sources: [
              { type: 'turn', id: 1, excerpt: 'I prefer Rust' },
              { type: 'knowledge', id: 1, excerpt: 'prefers Rust' },
            ],
            episodes: [],
            detailLevel: 'overview',
          });
        },
      };
    }

    it('searchEpisodes returns episode summaries', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
        structuredClient: createMockStructuredClient(),
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');
      await manager.processTurn('assistant', 'Understood, Rust is a great choice.');

      const episodes = await manager.searchEpisodes({ query: 'Rust' });
      expect(episodes.length).toBeGreaterThanOrEqual(1);
      expect(episodes[0].recap.objective).toBeTruthy();
      expect(episodes[0].sessionId).toBeTruthy();
      await manager.close();
    });

    it('summarizeEpisode returns a summary for a session', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
        structuredClient: createMockStructuredClient(),
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');

      const summary = await manager.summarizeEpisode('session-1', { detailLevel: 'abstract' });
      expect(summary.detailLevel).toBe('abstract');
      expect(summary.sessionId).toBe('session-1');
      expect(summary.recap.objective).toBeTruthy();
      await manager.close();
    });

    it('reflect synthesizes across memory types', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
        structuredClient: createMockStructuredClient(),
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');
      await manager.learnFact('User prefers Rust', 'preference', 'high');

      const result = await manager.reflect({ query: 'Rust' });
      expect(result.synthesis).toBeTruthy();
      expect(result.sourceType).toBeTruthy();
      expect(result.detailLevel).toBe('overview');
      await manager.close();
    });

    it('searchCognitive groups results by cognitive type', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');
      await manager.learnFact('User prefers Rust', 'preference', 'high');

      const result = await manager.searchCognitive({ query: 'Rust' });
      expect(result.byType).toBeDefined();
      expect(result.all.length).toBeGreaterThan(0);
      expect(['episodic', 'semantic', 'procedural', 'working']).toContain(result.all[0].item.type);
      await manager.close();
    });

    it('searchEpisodes throws without structuredClient', async () => {
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

      await expect(manager.searchEpisodes({ query: 'test' })).rejects.toThrow('structuredClient');
      await manager.close();
    });
  });
});
