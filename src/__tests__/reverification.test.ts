import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope } from './test-helpers.js';

describe('reverification workflows', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
    vi.useRealTimers();
  });

  it('demotes stale project facts that need reconfirmation', async () => {
    const scope = makeScope();
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The deploy target is us-east staging.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.85,
      last_verified_at: Math.floor(Date.now() / 1000),
      next_reverification_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });
    adapter.insertKnowledgeEvidence({
      ...scope,
      knowledge_memory_id: knowledge.id,
      source_type: 'user_turn',
      support_polarity: 'supports',
      excerpt: 'The deploy target is us-east staging.',
      is_explicit: true,
      explicitness_score: 1,
    });

    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'reverify-1',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
      maintenancePolicy: {
        reverificationCadenceDays: 7,
        requireReconfirmationForProjectFacts: true,
      },
    });

    vi.setSystemTime(new Date('2024-02-20T00:00:00Z'));
    const report = await manager.runMaintenance({
      reverificationCadenceDays: 7,
      requireReconfirmationForProjectFacts: true,
      knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
      maxActiveKnowledgeItems: 20,
    });
    const updated = adapter.getKnowledgeMemoryById(knowledge.id);

    expect(report.demotedKnowledgeIds).toContain(knowledge.id);
    expect(updated?.knowledge_state).toBe('provisional');
    expect(updated?.next_reverification_at).not.toBeNull();
    await manager.close();
  });

  it('reverification refreshes timestamps and preserves evidence for trusted memory', async () => {
    const scope = makeScope();
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system must remain local-first.',
      fact_type: 'constraint',
      knowledge_state: 'trusted',
      knowledge_class: 'constraint',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
      verification_status: 'verified',
      next_reverification_at: Math.floor(Date.now() / 1000) - 1,
      last_confirmed_at: Math.floor(Date.now() / 1000),
      confirmation_count: 1,
    });
    adapter.insertKnowledgeEvidenceBatch([
      {
        ...scope,
        knowledge_memory_id: knowledge.id,
        source_type: 'user_turn',
        support_polarity: 'supports',
        excerpt: 'The system must remain local-first.',
        is_explicit: true,
        explicitness_score: 1,
      },
      {
        ...scope,
        knowledge_memory_id: knowledge.id,
        source_type: 'system_turn',
        support_polarity: 'supports',
        excerpt: 'Remain local-first by default.',
        is_explicit: true,
        explicitness_score: 1,
      },
    ]);

    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'reverify-2',
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false,
      autoExtract: false,
      maintenancePolicy: {
        reverificationCadenceDays: 30,
      },
    });

    vi.setSystemTime(new Date('2024-02-10T00:00:00Z'));
    const result = await manager.runReverification({ limit: 10 });
    const updated = adapter.getKnowledgeMemoryById(knowledge.id);
    const evidence = adapter.listKnowledgeEvidenceForKnowledge(knowledge.id);

    expect(result.reverifiedKnowledgeIds).toContain(knowledge.id);
    expect(updated?.knowledge_state).toBe('trusted');
    expect(updated?.confirmation_count).toBe(2);
    expect(updated?.last_confirmed_at).toBe(Math.floor(Date.now() / 1000));
    expect(updated?.next_reverification_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(evidence).toHaveLength(2);
    await manager.close();
  });
});
