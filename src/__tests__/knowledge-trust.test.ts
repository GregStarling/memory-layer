import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { createMemoryManager } from '../core/manager.js';
import { extractKnowledge } from '../core/orchestrator.js';
import { createSessionId } from '../core/tokens.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'trust-thread',
    ...overrides,
  };
}

describe('knowledge trust', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  async function extractFromTurns(input: {
    memoryScope?: MemoryScope;
    contents: Array<{ role: 'user' | 'assistant'; actor: string; content: string }>;
    summary: string;
    fact: string;
    factType: 'preference' | 'decision' | 'constraint';
  }) {
    const memoryScope = input.memoryScope ?? scope();
    const sessionId = createSessionId(memoryScope);
    const turns = adapter.insertTurns(
      input.contents.map((item) => ({
        ...memoryScope,
        session_id: sessionId,
        actor: item.actor,
        role: item.role,
        content: item.content,
      })),
    );
    const workingMemory = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: input.summary,
      key_entities: [],
      topic_tags: [],
      turn_id_start: turns[0]!.id,
      turn_id_end: turns.at(-1)!.id,
      turn_count: turns.length,
      compaction_trigger: 'manual',
    });
    const created = await extractKnowledge(asyncAdapter, workingMemory.id, memoryScope, async () => [
      {
        fact: input.fact,
        factType: input.factType,
        confidence: 'high',
      },
    ]);
    return { memoryScope, turns, workingMemory, created };
  }

  it('keeps a weak single statement provisional', async () => {
    const { created } = await extractFromTurns({
      contents: [{ role: 'user', actor: 'user-1', content: 'The user prefers TypeScript.' }],
      summary: 'The user prefers TypeScript.',
      fact: 'The user prefers TypeScript.',
      factType: 'preference',
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.knowledge_state).toBe('provisional');
  });

  it('promotes repeated explicit preference to trusted', async () => {
    const { created } = await extractFromTurns({
      contents: [
        { role: 'user', actor: 'user-1', content: 'The user prefers TypeScript.' },
        { role: 'user', actor: 'user-1', content: 'Yes, the user prefers TypeScript for backend work.' },
      ],
      summary: 'The user prefers TypeScript.',
      fact: 'The user prefers TypeScript.',
      factType: 'preference',
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.knowledge_state).toBe('trusted');
    expect(created[0]?.trust_score).toBeGreaterThanOrEqual(0.7);
  });

  it('does not treat unsupported assistant claims as trusted', async () => {
    const { created } = await extractFromTurns({
      contents: [{ role: 'assistant', actor: 'assistant-1', content: 'The user prefers Go.' }],
      summary: 'The user prefers Go.',
      fact: 'The user prefers Go.',
      factType: 'preference',
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.knowledge_state).not.toBe('trusted');
  });

  it('reverifies successful strategy memory into trusted strategy knowledge', async () => {
    const memoryScope = scope({ scope_id: 'strategy-success' });
    const sessionId = createSessionId(memoryScope);
    const turn = adapter.insertTurn({
      ...memoryScope,
      session_id: sessionId,
      actor: 'user-1',
      role: 'user',
      content: 'Use smaller batches for migrations.',
    });
    const knowledge = adapter.insertKnowledgeMemory({
      ...memoryScope,
      fact: 'Use smaller batches for migrations.',
      fact_type: 'decision',
      knowledge_state: 'provisional',
      knowledge_class: 'procedure',
      source: 'manual',
      confidence: 'high',
      grounding_strength: 'strong',
      evidence_count: 2,
      trust_score: 0.65,
      source_turn_ids: [turn.id],
    });
    adapter.insertKnowledgeEvidenceBatch([
      {
        ...memoryScope,
        knowledge_memory_id: knowledge.id,
        turn_id: turn.id,
        source_type: 'execution_result',
        support_polarity: 'supports',
        excerpt: 'Use smaller batches for migrations.',
        is_explicit: true,
        explicitness_score: 1,
        outcome: 'success',
      },
      {
        ...memoryScope,
        knowledge_memory_id: knowledge.id,
        turn_id: turn.id,
        source_type: 'human_feedback',
        support_polarity: 'supports',
        excerpt: 'This strategy worked well.',
        is_explicit: true,
        explicitness_score: 1,
        outcome: 'success',
      },
    ]);

    const manager = createMemoryManager({
      adapter,
      scope: memoryScope,
      sessionId,
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    });

    const assessment = await manager.reverifyKnowledge(knowledge.id);
    const inspected = await manager.inspectKnowledge(knowledge.id);

    expect(assessment.state).toBe('trusted');
    expect(inspected.knowledge?.knowledge_class).toBe('strategy');
    expect(inspected.knowledge?.knowledge_state).toBe('trusted');
  });

  it('turns failed procedural knowledge into an anti-pattern and exposes evidence via inspect', async () => {
    const memoryScope = scope({ scope_id: 'strategy-failure' });
    const sessionId = createSessionId(memoryScope);
    const knowledge = adapter.insertKnowledgeMemory({
      ...memoryScope,
      fact: 'Use aggressive caching during deploys.',
      fact_type: 'decision',
      knowledge_state: 'provisional',
      knowledge_class: 'procedure',
      source: 'manual',
      confidence: 'medium',
      grounding_strength: 'moderate',
      evidence_count: 1,
      trust_score: 0.55,
      source_turn_ids: [],
    });
    adapter.insertKnowledgeEvidence({
      ...memoryScope,
      knowledge_memory_id: knowledge.id,
      source_type: 'execution_result',
      support_polarity: 'supports',
      excerpt: 'Aggressive caching caused stale reads.',
      is_explicit: true,
      explicitness_score: 1,
      outcome: 'failure',
    });
    adapter.insertKnowledgeMemoryAudit({
      ...memoryScope,
      fact: knowledge.fact,
      fact_type: knowledge.fact_type,
      confidence: knowledge.confidence,
      decision: 'created',
      created_knowledge_id: knowledge.id,
      detail: 'Created for trust inspection',
    });

    const manager = createMemoryManager({
      adapter,
      scope: memoryScope,
      sessionId,
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    });

    await manager.reverifyKnowledge(knowledge.id);
    const inspected = await manager.inspectKnowledge(knowledge.id);

    expect(inspected.knowledge?.knowledge_class).toBe('anti_pattern');
    expect(inspected.evidence).toHaveLength(1);
    expect(inspected.audits.length).toBeGreaterThan(0);
  });
});
