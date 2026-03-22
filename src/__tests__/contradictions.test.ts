import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { extractKnowledge } from '../core/orchestrator.js';
import { createSessionId } from '../core/tokens.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'contradiction-thread',
    ...overrides,
  };
}

describe('knowledge contradictions', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  async function extractFact(
    memoryScope: MemoryScope,
    contents: string[],
    fact: string,
    factType: 'constraint' | 'preference' = 'constraint',
  ) {
    const sessionId = createSessionId(memoryScope);
    const turns = adapter.insertTurns(
      contents.map((content, index) => ({
        ...memoryScope,
        session_id: sessionId,
        actor: `user-${index + 1}`,
        role: 'user',
        content,
      })),
    );
    const workingMemory = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: fact,
      key_entities: [],
      topic_tags: [],
      turn_id_start: turns[0]!.id,
      turn_id_end: turns.at(-1)!.id,
      turn_count: turns.length,
      compaction_trigger: 'manual',
    });
    return extractKnowledge(asyncAdapter, workingMemory.id, memoryScope, async () => [
      {
        fact,
        factType,
        confidence: 'high',
      },
    ]);
  }

  it('marks prior contradictory fact disputed when new evidence is weak', async () => {
    const memoryScope = scope({ scope_id: 'dispute-prior' });
    const initial = await extractFact(memoryScope, ['The system must use Docker.', 'The system must use Docker.'], 'The system must use Docker.');
    const original = initial[0]!;

    const next = await extractFact(memoryScope, ['The system must not use Docker.'], 'The system must not use Docker.');
    const originalAfter = adapter.getKnowledgeMemoryById(original.id);

    expect(next).toHaveLength(0);
    expect(originalAfter?.knowledge_state).toBe('disputed');
    expect(originalAfter?.disputed_at).not.toBeNull();
  });

  it('supersedes prior knowledge when stronger replacement evidence arrives', async () => {
    const memoryScope = scope({ scope_id: 'supersede-prior' });
    const initial = await extractFact(
      memoryScope,
      ['The user prefers TypeScript.', 'The user prefers TypeScript.'],
      'The user prefers TypeScript.',
      'preference',
    );
    const original = initial[0]!;

    const sessionId = createSessionId(memoryScope);
    const turns = adapter.insertTurns([
      {
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'The user prefers Go.',
      },
      {
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-2',
        role: 'user',
        content: 'Yes, the user prefers Go now.',
      },
    ]);
    const workingMemory = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'The user prefers Go.',
      key_entities: [],
      topic_tags: [],
      turn_id_start: turns[0]!.id,
      turn_id_end: turns.at(-1)!.id,
      turn_count: turns.length,
      compaction_trigger: 'manual',
    });

    const replacement = await extractKnowledge(asyncAdapter, workingMemory.id, memoryScope, async () => [
      {
        fact: 'The user prefers Go.',
        factType: 'preference',
        confidence: 'high',
      },
    ]);

    const originalAfter = adapter.getKnowledgeMemoryById(original.id);
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.knowledge_state).toBe('trusted');
    expect(originalAfter?.superseded_by_id).toBe(replacement[0]?.id);
    expect(originalAfter?.knowledge_state).toBe('superseded');
  });
});
