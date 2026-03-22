import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { createSessionId } from '../core/tokens.js';
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

describe('in-memory adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  afterEach(() => {
    adapter.close();
  });

  it('stores and searches turns', () => {
    const memoryScope = scope();
    const sessionId = createSessionId(memoryScope);
    adapter.insertTurn({
      ...memoryScope,
      session_id: sessionId,
      actor: 'user',
      role: 'user',
      content: 'remember local first sqlite',
    });

    const results = adapter.searchTurns(memoryScope, 'sqlite local');
    expect(results[0]?.item.content).toContain('sqlite');
  });

  it('supports cross-scope knowledge search', () => {
    const workspaceScope = scope({ workspace_id: 'shared', scope_id: 'a' });
    adapter.insertKnowledgeMemory({
      ...workspaceScope,
      fact: 'Use shared workspace memory',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const results = adapter.searchKnowledgeCrossScope(
      scope({ workspace_id: 'shared', scope_id: 'b' }),
      'workspace',
      'shared memory',
    );
    expect(results).toHaveLength(1);
  });

  it('tracks work items and context monitors', () => {
    const memoryScope = scope();
    const item = adapter.insertWorkItem({
      ...memoryScope,
      kind: 'objective',
      title: 'Ship memory layer',
    });
    adapter.upsertContextMonitor({
      ...memoryScope,
      compaction_state: 'idle',
      active_turn_count: 1,
      active_token_estimate: 10,
      compaction_score: 0,
    });

    expect(adapter.getActiveWorkItems(memoryScope)[0]?.id).toBe(item.id);
    expect(adapter.getContextMonitor(memoryScope)?.compaction_state).toBe('idle');
  });

  it('stores knowledge candidates and evidence before promotion', () => {
    const memoryScope = scope();
    const sessionId = createSessionId(memoryScope);
    const turn = adapter.insertTurn({
      ...memoryScope,
      session_id: sessionId,
      actor: 'user',
      role: 'user',
      content: 'Use smaller batches for migrations.',
    });
    const workingMemory = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'Migration guidance',
      key_entities: ['migration'],
      topic_tags: ['strategy'],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'manual',
    });

    const candidate = adapter.insertKnowledgeCandidate({
      ...memoryScope,
      working_memory_id: workingMemory.id,
      fact: 'Use smaller batches for migrations.',
      fact_type: 'decision',
      knowledge_class: 'strategy',
      normalized_fact: 'use smaller batches for migrations',
      confidence: 'high',
      source_turns: true,
      grounding_strength: 'strong',
      evidence_count: 1,
      trust_score: 0.8,
    });
    const evidence = adapter.insertKnowledgeEvidence({
      ...memoryScope,
      knowledge_candidate_id: candidate.id,
      working_memory_id: workingMemory.id,
      turn_id: turn.id,
      source_type: 'user_turn',
      support_polarity: 'supports',
      speaker_role: 'user',
      actor: 'user',
      excerpt: 'Use smaller batches for migrations.',
      is_explicit: true,
      explicitness_score: 1,
      outcome: 'success',
    });
    const promoted = adapter.promoteKnowledgeCandidate(candidate.id, {
      ...memoryScope,
      fact: candidate.fact,
      fact_type: candidate.fact_type,
      knowledge_class: candidate.knowledge_class,
      knowledge_state: 'provisional',
      normalized_fact: candidate.normalized_fact,
      source: 'promoted_from_working',
      confidence: candidate.confidence,
      grounding_strength: candidate.grounding_strength,
      evidence_count: 1,
      trust_score: 0.8,
      source_working_memory_id: workingMemory.id,
      source_turn_ids: [turn.id],
    });

    expect(adapter.getKnowledgeCandidateById(candidate.id)?.promoted_knowledge_id).toBe(promoted.id);
    expect(adapter.listKnowledgeEvidenceForCandidate(candidate.id)[0]?.id).toBe(evidence.id);
    expect(adapter.getKnowledgeMemoryById(promoted.id)?.knowledge_class).toBe('strategy');
  });
});
