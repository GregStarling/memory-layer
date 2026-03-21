import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestMemoryDatabase,
  archiveTurn,
  createSessionId,
  estimateTokens,
  expireWorkingMemory,
  getActiveKnowledgeMemory,
  getActiveTurns,
  getActiveWorkingMemory,
  getCompactionLogById,
  getContextMonitor,
  getKnowledgeMemoryById,
  getLatestWorkingMemory,
  getRecentCompactionLogs,
  getTurnById,
  getWorkingMemoryById,
  getWorkingMemoryBySession,
  insertCompactionLog,
  insertKnowledgeMemory,
  insertTurn,
  insertWorkingMemory,
  markWorkingMemoryPromoted,
  supersedeKnowledgeMemory,
  touchKnowledgeMemory,
  upsertContextMonitor,
} from './db.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  _initTestMemoryDatabase();
});

// ---------------------------------------------------------------------------
// Utilities
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

describe('createSessionId', () => {
  it('embeds channel and groupJid', () => {
    const id = createSessionId('telegram', '-1001234567890');
    expect(id).toContain('telegram');
    expect(id).toContain('-1001234567890');
  });

  it('generates unique ids each call', () => {
    expect(createSessionId('telegram', 'g1')).not.toBe(
      createSessionId('telegram', 'g1'),
    );
  });

  it('throws on empty channel', () => {
    expect(() => createSessionId('', 'g1')).toThrow();
  });

  it('throws on empty groupJid', () => {
    expect(() => createSessionId('telegram', '')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function makeTurn(overrides?: Partial<Parameters<typeof insertTurn>[0]>) {
  return insertTurn({
    session_id: 'tg_g1_2026-03-20_abc123',
    channel: 'telegram',
    group_jid: '-100111',
    sender: 'Greg',
    role: 'user',
    content: 'Let us build a memory system.',
    ...overrides,
  });
}

describe('insertTurn', () => {
  it('stores a turn with all expected defaults', () => {
    const t = makeTurn();
    expect(t.id).toBeGreaterThan(0);
    expect(t.archived_at).toBeNull();
    expect(t.compaction_log_id).toBeNull();
    expect(t.schema_version).toBe(1);
  });

  it('auto-computes token_estimate when omitted', () => {
    const t = makeTurn({ content: 'a'.repeat(40) });
    expect(t.token_estimate).toBeGreaterThan(0);
  });

  it('respects explicit token_estimate', () => {
    expect(makeTurn({ token_estimate: 99 }).token_estimate).toBe(99);
  });

  it('throws on invalid role', () => {
    expect(() => makeTurn({ role: 'robot' as never })).toThrow();
  });

  it('throws on empty content', () => {
    expect(() => makeTurn({ content: '' })).toThrow();
  });

  it('throws on empty channel', () => {
    expect(() => makeTurn({ channel: '' })).toThrow();
  });
});

describe('getActiveTurns', () => {
  it('returns turns in insertion order', () => {
    const t1 = makeTurn({ content: 'alpha' });
    const t2 = makeTurn({ content: 'beta' });
    const turns = getActiveTurns('telegram', '-100111');
    expect(turns[0].id).toBe(t1.id);
    expect(turns[1].id).toBe(t2.id);
  });

  it('excludes archived turns', () => {
    const t = makeTurn();
    const wm = insertWorkingMemory({
      session_id: t.session_id,
      channel: 'telegram',
      group_jid: '-100111',
      summary: 'summary',
      key_entities: [],
      topic_tags: [],
      turn_id_start: t.id,
      turn_id_end: t.id,
      turn_count: 1,
      compaction_trigger: 'soft',
    });
    const cl = insertCompactionLog({
      session_id: t.session_id,
      channel: 'telegram',
      group_jid: '-100111',
      trigger_type: 'soft',
      turn_id_start: t.id,
      turn_id_end: t.id,
      turns_compacted: 1,
      tokens_compacted_estimate: t.token_estimate,
      working_memory_id: wm.id,
      active_turn_count_before: 1,
      active_turn_count_after: 0,
      duration_ms: 100,
    });
    archiveTurn(t.id, nowSec(), cl.id);
    expect(getActiveTurns('telegram', '-100111')).toHaveLength(0);
  });

  it('scopes by channel and group_jid', () => {
    makeTurn({ channel: 'telegram', group_jid: '-100111' });
    makeTurn({ channel: 'telegram', group_jid: '-100222' });
    expect(getActiveTurns('telegram', '-100111')).toHaveLength(1);
    expect(getActiveTurns('telegram', '-100222')).toHaveLength(1);
  });
});

describe('archiveTurn', () => {
  it('sets archived_at and compaction_log_id', () => {
    const t = makeTurn();
    const wm = insertWorkingMemory({
      session_id: t.session_id,
      channel: 'telegram',
      group_jid: '-100111',
      summary: 'summary',
      key_entities: [],
      topic_tags: [],
      turn_id_start: t.id,
      turn_id_end: t.id,
      turn_count: 1,
      compaction_trigger: 'soft',
    });
    const cl = insertCompactionLog({
      session_id: t.session_id,
      channel: 'telegram',
      group_jid: '-100111',
      trigger_type: 'soft',
      turn_id_start: t.id,
      turn_id_end: t.id,
      turns_compacted: 1,
      tokens_compacted_estimate: t.token_estimate,
      working_memory_id: wm.id,
      active_turn_count_before: 1,
      active_turn_count_after: 0,
      duration_ms: 50,
    });
    const ts = nowSec();
    archiveTurn(t.id, ts, cl.id);
    const archived = getTurnById(t.id)!;
    expect(archived.archived_at).toBe(ts);
    expect(archived.compaction_log_id).toBe(cl.id);
  });
});

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------

function makeWm(overrides?: Partial<Parameters<typeof insertWorkingMemory>[0]>) {
  return insertWorkingMemory({
    session_id: 'tg_g1_2026-03-20_abc123',
    channel: 'telegram',
    group_jid: '-100111',
    summary: 'Discussion about memory systems',
    key_entities: ['NanoClaw', 'SQLite'],
    topic_tags: ['architecture'],
    turn_id_start: 1,
    turn_id_end: 10,
    turn_count: 10,
    compaction_trigger: 'soft',
    ...overrides,
  });
}

describe('insertWorkingMemory', () => {
  it('stores with JSON arrays and defaults', () => {
    const wm = makeWm();
    expect(wm.id).toBeGreaterThan(0);
    expect(wm.key_entities).toEqual(['NanoClaw', 'SQLite']);
    expect(wm.topic_tags).toEqual(['architecture']);
    expect(wm.expires_at).toBeGreaterThan(0);
    expect(wm.promoted_to_knowledge_id).toBeNull();
    expect(wm.schema_version).toBe(1);
  });

  it('rejects > 5 topic_tags', () => {
    expect(() =>
      makeWm({ topic_tags: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toThrow();
  });

  it('rejects turn_id_end < turn_id_start', () => {
    expect(() =>
      makeWm({ turn_id_start: 10, turn_id_end: 5 }),
    ).toThrow();
  });

  it('rejects invalid compaction_trigger', () => {
    expect(() =>
      makeWm({ compaction_trigger: 'invalid' as never }),
    ).toThrow();
  });
});

describe('getActiveWorkingMemory', () => {
  it('excludes expired entries', () => {
    makeWm({ expires_at: nowSec() - 3600 }); // expired 1h ago
    expect(getActiveWorkingMemory('telegram', '-100111')).toHaveLength(0);
  });

  it('includes entries with null expires_at', () => {
    makeWm({ expires_at: null });
    expect(getActiveWorkingMemory('telegram', '-100111')).toHaveLength(1);
  });
});

describe('getLatestWorkingMemory', () => {
  it('returns the most recent non-expired WM', () => {
    const wm1 = makeWm({ summary: 'older' });
    const wm2 = makeWm({ summary: 'newer' });
    const latest = getLatestWorkingMemory('telegram', '-100111');
    expect(latest?.id).toBe(wm2.id);
  });

  it('returns null when all expired', () => {
    makeWm({ expires_at: nowSec() - 100 });
    expect(getLatestWorkingMemory('telegram', '-100111')).toBeNull();
  });
});

describe('expireWorkingMemory', () => {
  it('sets expires_at to now', () => {
    const wm = makeWm({ expires_at: null });
    expireWorkingMemory(wm.id);
    const updated = getWorkingMemoryById(wm.id)!;
    expect(updated.expires_at).toBeGreaterThan(0);
  });
});

describe('markWorkingMemoryPromoted', () => {
  it('sets promoted_to_knowledge_id', () => {
    const wm = makeWm();
    const km = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'Greg prefers TypeScript',
      fact_type: 'preference',
      source: 'promoted_from_working',
      confidence: 'high',
      source_working_memory_id: wm.id,
    });
    markWorkingMemoryPromoted(wm.id, km.id);
    expect(getWorkingMemoryById(wm.id)!.promoted_to_knowledge_id).toBe(km.id);
  });
});

// ---------------------------------------------------------------------------
// Knowledge Memory
// ---------------------------------------------------------------------------

describe('insertKnowledgeMemory', () => {
  it('stores a fact with defaults', () => {
    const km = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'Greg uses a Mac mini',
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
      insertKnowledgeMemory({
        channel: 'telegram',
        group_jid: '-100111',
        fact: 'test',
        fact_type: 'invalid' as never,
        source: 'user_stated',
        confidence: 'high',
      }),
    ).toThrow();
  });
});

describe('touchKnowledgeMemory', () => {
  it('increments access_count', () => {
    const km = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'test fact',
      fact_type: 'preference',
      source: 'user_stated',
      confidence: 'high',
    });
    touchKnowledgeMemory(km.id);
    touchKnowledgeMemory(km.id);
    expect(getKnowledgeMemoryById(km.id)!.access_count).toBe(3);
  });
});

describe('supersedeKnowledgeMemory', () => {
  it('marks old fact as superseded', () => {
    const old = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'Greg uses VSCode',
      fact_type: 'preference',
      source: 'user_stated',
      confidence: 'high',
    });
    const replacement = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'Greg uses Cursor',
      fact_type: 'preference',
      source: 'user_stated',
      confidence: 'high',
    });
    supersedeKnowledgeMemory(old.id, replacement.id);
    expect(getKnowledgeMemoryById(old.id)!.superseded_by_id).toBe(replacement.id);
  });

  it('excludes superseded facts from getActiveKnowledgeMemory', () => {
    const old = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'old fact',
      fact_type: 'entity',
      source: 'user_stated',
      confidence: 'high',
    });
    const replacement = insertKnowledgeMemory({
      channel: 'telegram',
      group_jid: '-100111',
      fact: 'new fact',
      fact_type: 'entity',
      source: 'user_stated',
      confidence: 'high',
    });
    supersedeKnowledgeMemory(old.id, replacement.id);
    const active = getActiveKnowledgeMemory('telegram', '-100111');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(replacement.id);
  });
});

// ---------------------------------------------------------------------------
// Context Monitor
// ---------------------------------------------------------------------------

describe('upsertContextMonitor', () => {
  it('creates on first call', () => {
    const cm = upsertContextMonitor({
      channel: 'telegram',
      group_jid: '-100111',
      compaction_state: 'idle',
      active_turn_count: 5,
      active_token_estimate: 1200,
      compaction_score: 2,
    });
    expect(cm.id).toBeGreaterThan(0);
    expect(cm.compaction_state).toBe('idle');
  });

  it('updates on second call (upsert)', () => {
    upsertContextMonitor({
      channel: 'telegram',
      group_jid: '-100111',
      compaction_state: 'idle',
      active_turn_count: 5,
      active_token_estimate: 1200,
      compaction_score: 2,
    });
    const updated = upsertContextMonitor({
      channel: 'telegram',
      group_jid: '-100111',
      compaction_state: 'soft_triggered',
      active_turn_count: 20,
      active_token_estimate: 4800,
      compaction_score: 5,
    });
    expect(updated.compaction_state).toBe('soft_triggered');
    expect(updated.compaction_score).toBe(5);
    // Still one row
    expect(getContextMonitor('telegram', '-100111')!.id).toBe(updated.id);
  });
});

// ---------------------------------------------------------------------------
// Compaction Log
// ---------------------------------------------------------------------------

describe('insertCompactionLog', () => {
  it('stores with boolean conversion for model_call_made', () => {
    const wm = makeWm();
    const cl = insertCompactionLog({
      session_id: 'tg_g1_2026-03-20_abc123',
      channel: 'telegram',
      group_jid: '-100111',
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
});

describe('getRecentCompactionLogs', () => {
  it('returns newest first', () => {
    const wm = makeWm();
    const cl1 = insertCompactionLog({
      session_id: 'tg_g1_2026-03-20_abc123',
      channel: 'telegram',
      group_jid: '-100111',
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
    const cl2 = insertCompactionLog({
      session_id: 'tg_g1_2026-03-20_abc123',
      channel: 'telegram',
      group_jid: '-100111',
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
    const logs = getRecentCompactionLogs('telegram', '-100111');
    expect(logs[0].id).toBe(cl2.id);
    expect(logs[1].id).toBe(cl1.id);
  });
});
