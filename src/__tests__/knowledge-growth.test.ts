import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { createRegexExtractor } from '../core/extractor.js';
import { extractKnowledge } from '../core/orchestrator.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { makeScope } from './test-helpers.js';

describe('knowledge growth', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  function insertTurns(scope: ReturnType<typeof makeScope>, contents: string[]): string {
    const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`;
    adapter.insertTurns(
      contents.map((content, index) => ({
        ...scope,
        session_id: sessionId,
        actor: `actor-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content,
      })),
    );
    return sessionId;
  }

  it('extracts knowledge from working memory', async () => {
    const scope = makeScope();
    const sessionId = insertTurns(scope, [
      'The user prefers Rust.',
      'The system must keep this local.',
    ]);
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

    const created = await extractKnowledge(asyncAdapter, wm.id, scope, createRegexExtractor());
    expect(created.length).toBeGreaterThan(0);
    expect(created.some((fact) => fact.fact_type === 'preference')).toBe(true);
    expect(created.every((fact) => fact.source_turn_ids.length > 0)).toBe(true);
    expect(created.some((fact) => fact.verification_status === 'corroborated')).toBe(true);
    expect(adapter.getRecentKnowledgeMemoryAudits(scope)).not.toHaveLength(0);
  });

  it('skips duplicate facts and touches the existing record', async () => {
    const scope = makeScope();
    const sessionId = insertTurns(scope, ['The user prefers Rust.', 'The user prefers Rust.']);
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

    const created = await extractKnowledge(asyncAdapter, wm.id, scope, createRegexExtractor());
    expect(created).toEqual([]);
    expect(adapter.getKnowledgeMemoryById(existing.id)?.access_count).toBeGreaterThan(1);
  });

  it('supersedes conflicting preference facts', async () => {
    const scope = makeScope();
    const sessionId = insertTurns(scope, ['The user prefers Neovim.', 'The user prefers Neovim.']);
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

    const created = await extractKnowledge(asyncAdapter, wm.id, scope, createRegexExtractor());
    expect(created).toHaveLength(1);
    expect(adapter.getKnowledgeMemoryById(oldFact.id)?.superseded_by_id).toBe(created[0].id);
    expect(adapter.getRecentKnowledgeMemoryAudits(scope)[0]?.decision).toBe('updated');
  });

  it('keeps unrelated preferences without superseding them', async () => {
    const scope = makeScope();
    const sessionId = insertTurns(scope, ['The user prefers TypeScript.', 'The user prefers TypeScript.']);
    const oldFact = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers dark mode',
      fact_type: 'preference',
      fact_subject: 'user',
      fact_attribute: 'preference',
      fact_value: 'dark mode',
      normalized_fact: 'the user prefers dark mode',
      slot_key: 'user:preference:theme',
      is_negated: false,
      source: 'manual',
      confidence: 'high',
    });
    const wm = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'The user prefers TypeScript.',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'manual',
    });

    const created = await extractKnowledge(asyncAdapter, wm.id, scope, createRegexExtractor());
    expect(created).toHaveLength(1);
    expect(adapter.getKnowledgeMemoryById(oldFact.id)?.superseded_by_id).toBeNull();
  });

  it('can skip low-confidence facts via policy', async () => {
    const scope = makeScope();
    const sessionId = insertTurns(scope, ['The user prefers Rust.', 'The user prefers Rust.']);
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

    const created = await extractKnowledge(asyncAdapter, wm.id, scope, createRegexExtractor(), {
      policy: {
        minConfidenceForPromotion: 'high',
      },
    });
    expect(created).toEqual([]);
    expect(adapter.getRecentKnowledgeMemoryAudits(scope)[0]?.decision).toBe('skipped_low_confidence');
  });

  it('validates working memory scope', async () => {
    const scope = makeScope();
    const otherScope = makeScope({ scope_id: 'other' });
    const sessionId = insertTurns(scope, ['The user prefers Rust.', 'The user prefers Rust.']);
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
      extractKnowledge(asyncAdapter, wm.id, otherScope, createRegexExtractor()),
    ).rejects.toThrow('does not belong');
  });
});
