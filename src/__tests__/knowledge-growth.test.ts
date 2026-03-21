import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createRegexExtractor } from '../core/extractor.js';
import { extractKnowledge } from '../core/orchestrator.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('knowledge growth', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('extracts knowledge from working memory', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 2);
    const wm = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'The user prefers Rust and must keep this local.',
      key_entities: ['Rust'],
      topic_tags: ['memory'],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });

    const created = await extractKnowledge(adapter, wm.id, scope, createRegexExtractor());
    expect(created.length).toBeGreaterThan(0);
    expect(created.some((fact) => fact.fact_type === 'preference')).toBe(true);
  });

  it('skips duplicate facts and touches the existing record', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 2);
    const existing = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers Rust',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });
    const wm = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'The user prefers Rust.',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });

    const created = await extractKnowledge(adapter, wm.id, scope, createRegexExtractor());
    expect(created).toEqual([]);
    expect(adapter.getKnowledgeMemoryById(existing.id)?.access_count).toBeGreaterThan(1);
  });

  it('supersedes conflicting preference facts', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 2);
    const oldFact = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers Vim',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });
    const wm = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'The user prefers Neovim.',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });

    const created = await extractKnowledge(adapter, wm.id, scope, createRegexExtractor());
    expect(created).toHaveLength(1);
    expect(adapter.getKnowledgeMemoryById(oldFact.id)?.superseded_by_id).toBe(created[0].id);
  });

  it('validates working memory scope', async () => {
    const scope = makeScope();
    const otherScope = makeScope({ scope_id: 'other' });
    const { sessionId } = seedTurns(adapter, scope, 2);
    const wm = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'The user prefers Rust.',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });

    await expect(
      extractKnowledge(adapter, wm.id, otherScope, createRegexExtractor()),
    ).rejects.toThrow('does not belong');
  });
});
