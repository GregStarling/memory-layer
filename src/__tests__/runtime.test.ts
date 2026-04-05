import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createMemoryRuntime } from '../core/runtime.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope } from './test-helpers.js';

describe('memory runtime helpers', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('prepares prompt-ready memory for a model call', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'Current objective is to ship memory.',
        key_entities: ['memory'],
        topic_tags: ['runtime'],
      }),
      autoCompact: false,
    });
    const runtime = createMemoryRuntime(manager);

    const payload = await runtime.beforeModelCall('ship memory');
    expect(payload.prompt).toContain('Current Objective');
    expect(payload.messages[0]?.role).toBe('system');
    await manager.close();
  });

  it('records exchanges and inferred work items after a model call', async () => {
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
    const runtime = createMemoryRuntime(manager, {
      inferWorkItems: () => [
        {
          title: 'Follow up on retrieval',
          kind: 'unresolved_work',
          status: 'open',
        },
      ],
    });

    const result = await runtime.afterModelCall({
      userInput: 'Please remember to follow up on retrieval.',
      assistantOutput: 'I will do that.',
    });
    expect(result.exchange.userTurn.role).toBe('user');
    expect(result.trackedWorkItems).toHaveLength(1);
    await manager.close();
  });

  it('uses historical bootstrap data when beforeModelCall is replayed asOf', async () => {
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
    const runtime = createMemoryRuntime(manager);
    const cutoff = 200;

    adapter.insertTurn({
      ...scope,
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'Need the rollback owner',
      created_at: 100,
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      title: 'Past blocker',
      kind: 'unresolved_work',
      status: 'blocked',
      created_at: 120,
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      title: 'Future blocker',
      kind: 'unresolved_work',
      status: 'blocked',
      created_at: 260,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Past profile fact',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
      created_at: 130,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Future profile fact',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
      created_at: 270,
    });

    const payload = await runtime.beforeModelCall({
      input: 'rollback',
      relevanceQuery: 'rollback',
      asOf: cutoff,
    });

    expect(payload.bootstrap.unresolvedWork.join(' ')).toContain('Past blocker');
    expect(payload.bootstrap.unresolvedWork.join(' ')).not.toContain('Future blocker');
    expect(payload.context.unresolvedWork.join(' ')).toContain('Past blocker');
    expect(payload.context.unresolvedWork.join(' ')).not.toContain('Future blocker');
    await manager.close();
  });

  describe('snapshot mode', () => {
    function makeManager() {
      return createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'snapshot summary',
          key_entities: [],
          topic_tags: [],
        }),
        autoCompact: false,
      });
    }

    it('captures a frozen snapshot on startSession when snapshotMode is true', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager, { snapshotMode: true });

      await manager.processTurn('user', 'hello world');
      await runtime.startSession('hello');

      const snapshot = runtime.getSnapshot();
      const latestCursor = await manager.resolveChangeStreamCursor();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.snapshotId).toMatch(/^snap-/);
      expect(snapshot!.frozenAt).toBeGreaterThan(0);
      expect(snapshot!.bootstrap).toBeDefined();
      expect(snapshot!.context).toBeDefined();
      expect(snapshot!.watermarkEventId).toBe(latestCursor === '0' ? null : latestCursor);
      await manager.close();
    });

    it('returns cached snapshot context from beforeModelCall instead of live state', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager, { snapshotMode: true });

      await manager.processTurn('user', 'original turn');
      await runtime.startSession('original');

      const snapshotBefore = runtime.getSnapshot();
      const activeTurnsAtSnapshot = snapshotBefore!.context.activeTurns.length;

      // Write new turns — these should persist durably but NOT affect the cached snapshot
      await manager.processTurn('user', 'new turn after snapshot');
      await manager.processTurn('assistant', 'another new turn');

      const payload = await runtime.beforeModelCall('original');
      // Context should come from cached snapshot
      expect(payload.context.activeTurns.length).toBe(activeTurnsAtSnapshot);
      await manager.close();
    });

    it('afterModelCall writes to durable storage even in snapshot mode', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager, { snapshotMode: true });

      await runtime.startSession('test');

      await runtime.afterModelCall({
        userInput: 'user message',
        assistantOutput: 'assistant reply',
      });

      // Durable storage should have the new turns
      const turns = adapter.getActiveTurns(makeScope(), 'session-1');
      expect(turns.length).toBe(2);
      expect(turns.some((t) => t.content === 'user message')).toBe(true);
      await manager.close();
    });

    it('refreshSnapshot re-captures and replaces the cached snapshot', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager, { snapshotMode: true });

      await manager.processTurn('user', 'first');
      await runtime.startSession('first');
      const firstSnapshot = runtime.getSnapshot();

      await manager.processTurn('user', 'second');
      const refreshed = await runtime.refreshSnapshot('first');
      expect(refreshed).not.toBeNull();
      expect(refreshed!.snapshotId).not.toBe(firstSnapshot!.snapshotId);

      const currentSnapshot = runtime.getSnapshot();
      expect(currentSnapshot!.snapshotId).toBe(refreshed!.snapshotId);
      // Refreshed snapshot should include both turns
      expect(currentSnapshot!.context.activeTurns.length).toBeGreaterThan(
        firstSnapshot!.context.activeTurns.length,
      );
      await manager.close();
    });

    it('does not freeze live in-memory storage when capturing snapshots', async () => {
      const memoryAdapter = createInMemoryAdapter();
      const manager = createMemoryManager({
        adapter: memoryAdapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'snapshot summary',
          key_entities: [],
          topic_tags: [],
        }),
        autoCompact: false,
      });
      const runtime = createMemoryRuntime(manager, { snapshotMode: true });

      const knowledge = memoryAdapter.insertKnowledgeMemory({
        ...makeScope(),
        fact: 'Rollback checklist lives in docs/runbooks/rollback.md',
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
      });

      await runtime.startSession('rollback');
      await expect(manager.getContext('rollback')).resolves.toBeTruthy();
      await expect(runtime.refreshSnapshot('rollback')).resolves.toBeTruthy();

      const refreshedKnowledge = memoryAdapter.getKnowledgeMemoryById(knowledge.id);
      expect(refreshedKnowledge?.access_count ?? 0).toBeGreaterThan(1);
      await manager.close();
      memoryAdapter.close();
    });

    it('getSnapshot returns null when snapshotMode is false', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager);

      await runtime.startSession('test');
      expect(runtime.getSnapshot()).toBeNull();
      await manager.close();
    });

    it('refreshSnapshot returns null when snapshotMode is false', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager);

      const result = await runtime.refreshSnapshot('test');
      expect(result).toBeNull();
      await manager.close();
    });

    it('default behavior unchanged when snapshotMode is false', async () => {
      const manager = makeManager();
      const runtime = createMemoryRuntime(manager);

      await manager.processTurn('user', 'first');
      await runtime.startSession('first');

      await manager.processTurn('user', 'second');
      const payload = await runtime.beforeModelCall('first');
      // Without snapshot mode, context should reflect latest state (2 turns)
      expect(payload.context.activeTurns.length).toBe(2);
      await manager.close();
    });
  });
});
