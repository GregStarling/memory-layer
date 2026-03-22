import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createSessionId, estimateTokens } from '../core/tokens.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe('SQLite storage adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns at least 1 for any non-empty string', () => {
      expect(estimateTokens('hi')).toBeGreaterThanOrEqual(1);
    });

    it('scales with length', () => {
      expect(estimateTokens('hello'.repeat(100))).toBeGreaterThan(
        estimateTokens('hello'),
      );
    });

    it('applies conservative multiplier: 100 chars => 29 tokens', () => {
      expect(estimateTokens('a'.repeat(100))).toBe(29);
    });
  });

  // ---------------------------------------------------------------------------
  // Session IDs
  // ---------------------------------------------------------------------------

  describe('createSessionId', () => {
    it('embeds all scope fields', () => {
      const id = createSessionId(scope());
      expect(id).toContain('acme');
      expect(id).toContain('assistant');
      expect(id).toContain('default');
      expect(id).toContain('thread-1');
    });

    it('generates unique ids each call', () => {
      expect(createSessionId(scope())).not.toBe(createSessionId(scope()));
    });

    it('throws on empty tenant_id', () => {
      expect(() => createSessionId(scope({ tenant_id: '' }))).toThrow();
    });

    it('throws on empty scope_id', () => {
      expect(() => createSessionId(scope({ scope_id: '' }))).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  describe('insertTurn', () => {
    it('stores a turn with all expected defaults', () => {
      const turn = adapter.insertTurn({
        ...scope(),
        session_id: createSessionId(scope()),
        actor: 'user-1',
        role: 'user',
        content: 'Hello memory layer',
      });

      expect(turn.id).toBeGreaterThan(0);
      expect(turn.workspace_id).toBe('default');
      expect(turn.token_estimate).toBe(estimateTokens('Hello memory layer'));
      expect(turn.archived_at).toBeNull();
      expect(turn.compaction_log_id).toBeNull();
      expect(turn.schema_version).toBe(1);
    });

    it('respects explicit token_estimate', () => {
      const turn = adapter.insertTurn({
        ...scope(),
        session_id: createSessionId(scope()),
        actor: 'user-1',
        role: 'user',
        content: 'test',
        token_estimate: 99,
      });
      expect(turn.token_estimate).toBe(99);
    });

    it('throws on invalid role', () => {
      expect(() =>
        adapter.insertTurn({
          ...scope(),
          session_id: createSessionId(scope()),
          actor: 'user-1',
          role: 'robot' as never,
          content: 'test',
        }),
      ).toThrow();
    });

    it('throws on empty content', () => {
      expect(() =>
        adapter.insertTurn({
          ...scope(),
          session_id: createSessionId(scope()),
          actor: 'user-1',
          role: 'user',
          content: '',
        }),
      ).toThrow();
    });

    it('throws on empty tenant_id', () => {
      expect(() =>
        adapter.insertTurn({
          ...scope({ tenant_id: '' }),
          session_id: 'sid',
          actor: 'user-1',
          role: 'user',
          content: 'test',
        }),
      ).toThrow();
    });

    it('throws on empty actor', () => {
      expect(() =>
        adapter.insertTurn({
          ...scope(),
          session_id: createSessionId(scope()),
          actor: '',
          role: 'user',
          content: 'test',
        }),
      ).toThrow();
    });
  });

  describe('insertTurns', () => {
    it('stores multiple turns in a single call', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const turns = adapter.insertTurns([
        {
          ...memoryScope,
          session_id: sessionId,
          actor: 'user-1',
          role: 'user',
          content: 'alpha',
        },
        {
          ...memoryScope,
          session_id: sessionId,
          actor: 'assistant-1',
          role: 'assistant',
          content: 'beta',
        },
      ]);

      expect(turns).toHaveLength(2);
      expect(adapter.getActiveTurns(memoryScope)).toHaveLength(2);
    });
  });

  describe('getActiveTurns', () => {
    it('returns turns in insertion order', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const t1 = adapter.insertTurn({
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'alpha',
      });
      const t2 = adapter.insertTurn({
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'beta',
      });
      const turns = adapter.getActiveTurns(memoryScope);
      expect(turns[0].id).toBe(t1.id);
      expect(turns[1].id).toBe(t2.id);
    });

    it('scopes by MemoryScope', () => {
      const s1 = scope();
      const s2 = scope({ scope_id: 'thread-2' });
      adapter.insertTurn({
        ...s1,
        session_id: createSessionId(s1),
        actor: 'user-1',
        role: 'user',
        content: 'alpha',
      });
      adapter.insertTurn({
        ...s2,
        session_id: createSessionId(s2),
        actor: 'user-2',
        role: 'user',
        content: 'beta',
      });

      expect(adapter.getActiveTurns(s1)).toHaveLength(1);
      expect(adapter.getActiveTurns(s2)).toHaveLength(1);
    });

    it('excludes archived turns', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const turn = adapter.insertTurn({
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'archive me',
      });
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
        turn_id_start: turn.id,
        turn_id_end: turn.id,
        turn_count: 1,
        compaction_trigger: 'soft',
      });
      const cl = adapter.insertCompactionLog({
        ...memoryScope,
        session_id: sessionId,
        trigger_type: 'soft',
        turn_id_start: turn.id,
        turn_id_end: turn.id,
        turns_compacted: 1,
        tokens_compacted_estimate: turn.token_estimate,
        working_memory_id: wm.id,
        active_turn_count_before: 1,
        active_turn_count_after: 0,
        duration_ms: 50,
      });
      adapter.archiveTurn(turn.id, nowSec(), cl.id);
      expect(adapter.getActiveTurns(memoryScope)).toHaveLength(0);
    });
  });

  describe('getActiveTurnsPaginated', () => {
    it('supports cursor pagination', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      for (const content of ['a', 'b', 'c']) {
        adapter.insertTurn({
          ...memoryScope,
          session_id: sessionId,
          actor: 'user-1',
          role: 'user',
          content,
        });
      }

      const firstPage = adapter.getActiveTurnsPaginated(memoryScope, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).toBe(firstPage.items[1].id);

      const secondPage = adapter.getActiveTurnsPaginated(memoryScope, {
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);
    });
  });

  describe('session-scoped safety', () => {
    it('filters working memory by scope when requested', () => {
      const sessionId = 'shared-session';
      const scopeA = scope();
      const scopeB = scope({ scope_id: 'thread-2' });
      adapter.insertWorkingMemory({
        ...scopeA,
        session_id: sessionId,
        summary: 'scope A summary',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 1,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      adapter.insertWorkingMemory({
        ...scopeB,
        session_id: sessionId,
        summary: 'scope B summary',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 1,
        turn_count: 1,
        compaction_trigger: 'manual',
      });

      expect(adapter.getWorkingMemoryBySession(sessionId)).toHaveLength(2);
      expect(adapter.getWorkingMemoryBySession(sessionId, scopeA)).toHaveLength(1);
      expect(adapter.getWorkingMemoryBySession(sessionId, scopeB)).toHaveLength(1);
    });

    it('filters archived turn ranges by scope when requested', () => {
      const sessionId = 'shared-session';
      const scopeA = scope();
      const scopeB = scope({ scope_id: 'thread-2' });
      const turnA = adapter.insertTurn({
        ...scopeA,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'scope A archived',
      });
      const turnB = adapter.insertTurn({
        ...scopeB,
        session_id: sessionId,
        actor: 'user-2',
        role: 'user',
        content: 'scope B archived',
      });
      const wmA = adapter.insertWorkingMemory({
        ...scopeA,
        session_id: sessionId,
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
        turn_id_start: turnA.id,
        turn_id_end: turnA.id,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      const logA = adapter.insertCompactionLog({
        ...scopeA,
        session_id: sessionId,
        trigger_type: 'manual',
        turn_id_start: turnA.id,
        turn_id_end: turnA.id,
        turns_compacted: 1,
        tokens_compacted_estimate: turnA.token_estimate,
        working_memory_id: wmA.id,
        active_turn_count_before: 1,
        active_turn_count_after: 0,
        duration_ms: 1,
      });
      const wmB = adapter.insertWorkingMemory({
        ...scopeB,
        session_id: sessionId,
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
        turn_id_start: turnB.id,
        turn_id_end: turnB.id,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      const logB = adapter.insertCompactionLog({
        ...scopeB,
        session_id: sessionId,
        trigger_type: 'manual',
        turn_id_start: turnB.id,
        turn_id_end: turnB.id,
        turns_compacted: 1,
        tokens_compacted_estimate: turnB.token_estimate,
        working_memory_id: wmB.id,
        active_turn_count_before: 1,
        active_turn_count_after: 0,
        duration_ms: 1,
      });
      adapter.archiveTurn(turnA.id, nowSec(), logA.id);
      adapter.archiveTurn(turnB.id, nowSec(), logB.id);

      expect(adapter.getArchivedTurnRange(sessionId, turnA.id, turnB.id)).toHaveLength(2);
      expect(adapter.getArchivedTurnRange(sessionId, turnA.id, turnB.id, scopeA)).toHaveLength(1);
      expect(adapter.getArchivedTurnRange(sessionId, turnA.id, turnB.id, scopeB)).toHaveLength(1);
    });
  });

  describe('archiveTurn', () => {
    it('sets archived_at and compaction_log_id', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const turn = adapter.insertTurn({
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'archive me',
      });
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
        turn_id_start: turn.id,
        turn_id_end: turn.id,
        turn_count: 1,
        compaction_trigger: 'soft',
      });
      const cl = adapter.insertCompactionLog({
        ...memoryScope,
        session_id: sessionId,
        trigger_type: 'soft',
        turn_id_start: turn.id,
        turn_id_end: turn.id,
        turns_compacted: 1,
        tokens_compacted_estimate: turn.token_estimate,
        working_memory_id: wm.id,
        active_turn_count_before: 1,
        active_turn_count_after: 0,
        duration_ms: 50,
      });
      const ts = nowSec();
      adapter.archiveTurn(turn.id, ts, cl.id);
      const archived = adapter.getTurnById(turn.id)!;
      expect(archived.archived_at).toBe(ts);
      expect(archived.compaction_log_id).toBe(cl.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Working Memory
  // ---------------------------------------------------------------------------

  describe('insertWorkingMemory', () => {
    it('stores with JSON arrays and defaults', () => {
      const memoryScope = scope();
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        summary: 'Discussion about memory',
        key_entities: ['SQLite', 'Memory'],
        topic_tags: ['architecture'],
        turn_id_start: 1,
        turn_id_end: 10,
        turn_count: 10,
        compaction_trigger: 'soft',
      });
      expect(wm.id).toBeGreaterThan(0);
      expect(wm.key_entities).toEqual(['SQLite', 'Memory']);
      expect(wm.topic_tags).toEqual(['architecture']);
      expect(wm.expires_at).toBeGreaterThan(0);
      expect(wm.promoted_to_knowledge_id).toBeNull();
      expect(wm.schema_version).toBe(1);
    });

    it('rejects > 5 topic_tags', () => {
      const memoryScope = scope();
      expect(() =>
        adapter.insertWorkingMemory({
          ...memoryScope,
          session_id: createSessionId(memoryScope),
          summary: 'test',
          key_entities: [],
          topic_tags: ['a', 'b', 'c', 'd', 'e', 'f'],
          turn_id_start: 1,
          turn_id_end: 5,
          turn_count: 5,
          compaction_trigger: 'soft',
        }),
      ).toThrow();
    });

    it('rejects turn_id_end < turn_id_start', () => {
      const memoryScope = scope();
      expect(() =>
        adapter.insertWorkingMemory({
          ...memoryScope,
          session_id: createSessionId(memoryScope),
          summary: 'test',
          key_entities: [],
          topic_tags: [],
          turn_id_start: 10,
          turn_id_end: 5,
          turn_count: 5,
          compaction_trigger: 'soft',
        }),
      ).toThrow();
    });

    it('rejects invalid compaction_trigger', () => {
      const memoryScope = scope();
      expect(() =>
        adapter.insertWorkingMemory({
          ...memoryScope,
          session_id: createSessionId(memoryScope),
          summary: 'test',
          key_entities: [],
          topic_tags: [],
          turn_id_start: 1,
          turn_id_end: 5,
          turn_count: 5,
          compaction_trigger: 'invalid' as never,
        }),
      ).toThrow();
    });
  });

  describe('getActiveWorkingMemory', () => {
    it('excludes expired entries', () => {
      const memoryScope = scope();
      adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        summary: 'expired',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
        expires_at: nowSec() - 3600,
      });
      expect(adapter.getActiveWorkingMemory(memoryScope)).toHaveLength(0);
    });

    it('includes entries with null expires_at', () => {
      const memoryScope = scope();
      adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        summary: 'never expires',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
        expires_at: null,
      });
      expect(adapter.getActiveWorkingMemory(memoryScope)).toHaveLength(1);
    });
  });

  describe('getLatestWorkingMemory', () => {
    it('returns the most recent non-expired WM', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'older',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
      });
      const wm2 = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'newer',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 6,
        turn_id_end: 10,
        turn_count: 5,
        compaction_trigger: 'soft',
      });
      expect(adapter.getLatestWorkingMemory(memoryScope)?.id).toBe(wm2.id);
    });

    it('returns null when all expired', () => {
      const memoryScope = scope();
      adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        summary: 'expired',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
        expires_at: nowSec() - 100,
      });
      expect(adapter.getLatestWorkingMemory(memoryScope)).toBeNull();
    });
  });

  describe('getWorkingMemoryBySession', () => {
    it('returns working memories for a session in order', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const wm1 = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'first',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
      });
      const wm2 = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'second',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 6,
        turn_id_end: 10,
        turn_count: 5,
        compaction_trigger: 'hard',
      });
      const results = adapter.getWorkingMemoryBySession(sessionId);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(wm1.id);
      expect(results[1].id).toBe(wm2.id);
    });
  });

  describe('expireWorkingMemory', () => {
    it('sets expires_at to now', () => {
      const memoryScope = scope();
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        summary: 'test',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
        expires_at: null,
      });
      adapter.expireWorkingMemory(wm.id);
      const updated = adapter.getWorkingMemoryById(wm.id)!;
      expect(updated.expires_at).toBeGreaterThan(0);
    });
  });

  describe('markWorkingMemoryPromoted', () => {
    it('sets promoted_to_knowledge_id', () => {
      const memoryScope = scope();
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: createSessionId(memoryScope),
        summary: 'test',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 5,
        turn_count: 5,
        compaction_trigger: 'soft',
      });
      const km = adapter.insertKnowledgeMemory({
        ...memoryScope,
        fact: 'User prefers TypeScript',
        fact_type: 'preference',
        source: 'promoted_from_working',
        confidence: 'high',
        source_working_memory_id: wm.id,
      });
      adapter.markWorkingMemoryPromoted(wm.id, km.id);
      expect(adapter.getWorkingMemoryById(wm.id)!.promoted_to_knowledge_id).toBe(km.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Knowledge Memory
  // ---------------------------------------------------------------------------

  describe('insertKnowledgeMemory', () => {
    it('stores a fact with defaults', () => {
      const km = adapter.insertKnowledgeMemory({
        ...scope(),
        fact: 'User uses a Mac mini',
        fact_type: 'entity',
        source: 'user_stated',
        confidence: 'high',
      });
      expect(km.id).toBeGreaterThan(0);
      expect(km.access_count).toBe(1);
      expect(km.superseded_by_id).toBeNull();
    });

    it('rejects invalid fact_type', () => {
      expect(() =>
        adapter.insertKnowledgeMemory({
          ...scope(),
          fact: 'test',
          fact_type: 'invalid' as never,
          source: 'user_stated',
          confidence: 'high',
        }),
      ).toThrow();
    });

    it('rejects invalid source', () => {
      expect(() =>
        adapter.insertKnowledgeMemory({
          ...scope(),
          fact: 'test',
          fact_type: 'entity',
          source: 'invalid' as never,
          confidence: 'high',
        }),
      ).toThrow();
    });

    it('rejects invalid confidence', () => {
      expect(() =>
        adapter.insertKnowledgeMemory({
          ...scope(),
          fact: 'test',
          fact_type: 'entity',
          source: 'user_stated',
          confidence: 'invalid' as never,
        }),
      ).toThrow();
    });

    it('rejects empty fact', () => {
      expect(() =>
        adapter.insertKnowledgeMemory({
          ...scope(),
          fact: '',
          fact_type: 'entity',
          source: 'user_stated',
          confidence: 'high',
        }),
      ).toThrow();
    });
  });

  describe('insertKnowledgeMemories', () => {
    it('stores multiple knowledge records in a single call', () => {
      const inserted = adapter.insertKnowledgeMemories([
        {
          ...scope(),
          fact: 'The user prefers dark mode',
          fact_type: 'preference',
          source: 'user_stated',
          confidence: 'high',
        },
        {
          ...scope(),
          fact: 'The project uses sqlite',
          fact_type: 'reference',
          source: 'user_stated',
          confidence: 'medium',
        },
      ]);

      expect(inserted).toHaveLength(2);
      expect(adapter.getActiveKnowledgeMemory(scope())).toHaveLength(2);
    });
  });

  describe('getActiveKnowledgeMemoryPaginated', () => {
    it('supports cursor pagination', () => {
      const memoryScope = scope();
      for (const fact of ['fact one', 'fact two', 'fact three']) {
        adapter.insertKnowledgeMemory({
          ...memoryScope,
          fact,
          fact_type: 'entity',
          source: 'user_stated',
          confidence: 'high',
        });
      }

      const firstPage = adapter.getActiveKnowledgeMemoryPaginated(memoryScope, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);

      const secondPage = adapter.getActiveKnowledgeMemoryPaginated(memoryScope, {
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);
    });
  });

  describe('touchKnowledgeMemory', () => {
    it('increments access_count', () => {
      const km = adapter.insertKnowledgeMemory({
        ...scope(),
        fact: 'test fact',
        fact_type: 'preference',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.touchKnowledgeMemory(km.id);
      adapter.touchKnowledgeMemory(km.id);
      expect(adapter.getKnowledgeMemoryById(km.id)!.access_count).toBe(3);
    });
  });

  describe('supersedeKnowledgeMemory', () => {
    it('marks old fact as superseded', () => {
      const memoryScope = scope();
      const old = adapter.insertKnowledgeMemory({
        ...memoryScope,
        fact: 'User uses VSCode',
        fact_type: 'preference',
        source: 'user_stated',
        confidence: 'high',
      });
      const replacement = adapter.insertKnowledgeMemory({
        ...memoryScope,
        fact: 'User uses Cursor',
        fact_type: 'preference',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.supersedeKnowledgeMemory(old.id, replacement.id);
      expect(adapter.getKnowledgeMemoryById(old.id)!.superseded_by_id).toBe(replacement.id);
    });

    it('excludes superseded facts from getActiveKnowledgeMemory', () => {
      const memoryScope = scope();
      const old = adapter.insertKnowledgeMemory({
        ...memoryScope,
        fact: 'old fact',
        fact_type: 'entity',
        source: 'user_stated',
        confidence: 'high',
      });
      const replacement = adapter.insertKnowledgeMemory({
        ...memoryScope,
        fact: 'new fact',
        fact_type: 'entity',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.supersedeKnowledgeMemory(old.id, replacement.id);
      const active = adapter.getActiveKnowledgeMemory(memoryScope);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(replacement.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Context Monitor
  // ---------------------------------------------------------------------------

  describe('upsertContextMonitor', () => {
    it('creates on first call', () => {
      const cm = adapter.upsertContextMonitor({
        ...scope(),
        compaction_state: 'idle',
        active_turn_count: 5,
        active_token_estimate: 1200,
        compaction_score: 2,
      });
      expect(cm.id).toBeGreaterThan(0);
      expect(cm.compaction_state).toBe('idle');
    });

    it('updates on second call (upsert)', () => {
      const memoryScope = scope();
      adapter.upsertContextMonitor({
        ...memoryScope,
        compaction_state: 'idle',
        active_turn_count: 5,
        active_token_estimate: 1200,
        compaction_score: 2,
      });
      const updated = adapter.upsertContextMonitor({
        ...memoryScope,
        compaction_state: 'soft_triggered',
        active_turn_count: 20,
        active_token_estimate: 4800,
        compaction_score: 5,
      });
      expect(updated.compaction_state).toBe('soft_triggered');
      expect(updated.compaction_score).toBe(5);
      expect(adapter.getContextMonitor(memoryScope)!.id).toBe(updated.id);
    });

    it('rejects invalid compaction_state', () => {
      expect(() =>
        adapter.upsertContextMonitor({
          ...scope(),
          compaction_state: 'invalid' as never,
          active_turn_count: 0,
          active_token_estimate: 0,
          compaction_score: 0,
        }),
      ).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Compaction Log
  // ---------------------------------------------------------------------------

  describe('insertCompactionLog', () => {
    it('stores with boolean conversion for model_call_made', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'test',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 10,
        turn_count: 10,
        compaction_trigger: 'soft',
      });
      const cl = adapter.insertCompactionLog({
        ...memoryScope,
        session_id: sessionId,
        trigger_type: 'soft',
        turn_id_start: 1,
        turn_id_end: 10,
        turns_compacted: 10,
        tokens_compacted_estimate: 3000,
        working_memory_id: wm.id,
        active_turn_count_before: 20,
        active_turn_count_after: 12,
        duration_ms: 450,
        model_call_made: true,
      });
      expect(cl.model_call_made).toBe(true);
      expect(cl.error).toBeNull();
    });

    it('rejects invalid trigger_type', () => {
      expect(() =>
        adapter.insertCompactionLog({
          ...scope(),
          session_id: 'sid',
          trigger_type: 'invalid' as never,
          turn_id_start: 1,
          turn_id_end: 5,
          turns_compacted: 5,
          tokens_compacted_estimate: 1000,
          working_memory_id: 1,
          active_turn_count_before: 10,
          active_turn_count_after: 5,
          duration_ms: 100,
        }),
      ).toThrow();
    });
  });

  describe('getRecentCompactionLogs', () => {
    it('returns newest first', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      const wm = adapter.insertWorkingMemory({
        ...memoryScope,
        session_id: sessionId,
        summary: 'test',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 10,
        turn_count: 10,
        compaction_trigger: 'soft',
      });
      const cl1 = adapter.insertCompactionLog({
        ...memoryScope,
        session_id: sessionId,
        trigger_type: 'soft',
        turn_id_start: 1,
        turn_id_end: 5,
        turns_compacted: 5,
        tokens_compacted_estimate: 1500,
        working_memory_id: wm.id,
        active_turn_count_before: 15,
        active_turn_count_after: 12,
        duration_ms: 200,
      });
      const cl2 = adapter.insertCompactionLog({
        ...memoryScope,
        session_id: sessionId,
        trigger_type: 'hard',
        turn_id_start: 6,
        turn_id_end: 20,
        turns_compacted: 15,
        tokens_compacted_estimate: 4500,
        working_memory_id: wm.id,
        active_turn_count_before: 25,
        active_turn_count_after: 8,
        duration_ms: 600,
      });
      const logs = adapter.getRecentCompactionLogs(memoryScope);
      expect(logs[0].id).toBe(cl2.id);
      expect(logs[1].id).toBe(cl1.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Adapter isolation
  // ---------------------------------------------------------------------------

  describe('adapter isolation', () => {
    it('isolates multiple adapter instances', () => {
      const otherAdapter = createSQLiteAdapter(':memory:');
      const memoryScope = scope();
      try {
        adapter.insertTurn({
          ...memoryScope,
          session_id: createSessionId(memoryScope),
          actor: 'user-1',
          role: 'user',
          content: 'primary',
        });
        otherAdapter.insertTurn({
          ...memoryScope,
          session_id: createSessionId(memoryScope),
          actor: 'user-2',
          role: 'user',
          content: 'secondary',
        });

        expect(adapter.getActiveTurns(memoryScope)).toHaveLength(1);
        expect(otherAdapter.getActiveTurns(memoryScope)).toHaveLength(1);
        expect(adapter.getActiveTurns(memoryScope)[0].content).toBe('primary');
        expect(otherAdapter.getActiveTurns(memoryScope)[0].content).toBe('secondary');
      } finally {
        otherAdapter.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------------

  describe('transaction', () => {
    it('commits on success', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      adapter.transaction(() => {
        adapter.insertTurn({
          ...memoryScope,
          session_id: sessionId,
          actor: 'user-1',
          role: 'user',
          content: 'inside transaction',
        });
      });
      expect(adapter.getActiveTurns(memoryScope)).toHaveLength(1);
    });

    it('rolls back on error', () => {
      const memoryScope = scope();
      const sessionId = createSessionId(memoryScope);
      try {
        adapter.transaction(() => {
          adapter.insertTurn({
            ...memoryScope,
            session_id: sessionId,
            actor: 'user-1',
            role: 'user',
            content: 'should be rolled back',
          });
          throw new Error('boom');
        });
      } catch {
        // expected
      }
      expect(adapter.getActiveTurns(memoryScope)).toHaveLength(0);
    });
  });
});
