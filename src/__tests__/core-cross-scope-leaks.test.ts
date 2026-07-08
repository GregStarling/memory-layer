import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryAdapter,
  createInMemoryAdapterWithEmbeddings,
} from '../adapters/memory/index.js';
import { createMemoryManager } from '../core/manager.js';
import {
  createTemporalReplayAdapter,
  type ReplayedTemporalState,
} from '../core/temporal.js';
import { makeScope } from './test-helpers.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { MemoryScope } from '../contracts/identity.js';

function emptyReplayState(
  knowledge: KnowledgeMemory[],
): ReplayedTemporalState {
  return {
    turns: [],
    workingMemory: [],
    knowledge,
    workItems: [],
    workClaims: [],
    handoffs: [],
    associations: [],
    playbooks: [],
    sessionStates: [],
    watermarkEventId: null,
  };
}

// Two scopes in the SAME workspace, different scope_id: a private fact in `scopeA`
// must never surface to `scopeB` at any widening level.
const scopeA: MemoryScope = makeScope({ scope_id: 'thread-a' });
const scopeB: MemoryScope = makeScope({ scope_id: 'thread-b' });

describe('CoreLeaks F4 cross-scope visibility gates', () => {
  describe('F4 (item 1) manager semantic-only hydration gate', () => {
    it('does NOT surface a private fact from another scope even when the embedding index leaks its id', async () => {
      const adapter = createInMemoryAdapterWithEmbeddings();
      const privateFact = adapter.insertKnowledgeMemory({
        ...scopeA,
        visibility_class: 'private',
        fact: 'alpha rollout secret',
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
      });
      adapter.embeddings.storeEmbedding(privateFact.id, new Float32Array([1, 0]));

      // Simulate a leaky adapter: findSimilarCrossScope returns the private id as
      // if its SQL visibility WHERE clause had a hole. The manager's defensive
      // isBaseVisible gate on the hydrated semantic-only hit must still drop it.
      vi.spyOn(adapter.embeddings, 'findSimilarCrossScope').mockReturnValue([
        { knowledgeMemoryId: privateFact.id, similarity: 0.99 },
      ]);

      const manager = createMemoryManager({
        adapter,
        scope: scopeB,
        sessionId: 'session-b',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
        autoCompact: false,
        embeddingAdapter: adapter.embeddings,
        embeddingGenerator: async (texts) => texts.map(() => new Float32Array([1, 0])),
      });

      const { knowledge } = await manager.searchCrossScope('alpha', 'workspace');
      expect(knowledge.map((r) => r.item.id)).not.toContain(privateFact.id);
      await manager.close();
    });

    it('does not leak a private fact through the real memory embedding adapter (end-to-end)', async () => {
      const adapter = createInMemoryAdapterWithEmbeddings();
      const privateFact = adapter.insertKnowledgeMemory({
        ...scopeA,
        visibility_class: 'private',
        fact: 'beta rollout secret',
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
      });
      adapter.embeddings.storeEmbedding(privateFact.id, new Float32Array([1, 0]));

      const manager = createMemoryManager({
        adapter,
        scope: scopeB,
        sessionId: 'session-b',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
        autoCompact: false,
        embeddingAdapter: adapter.embeddings,
        embeddingGenerator: async (texts) => texts.map(() => new Float32Array([1, 0])),
      });

      const { knowledge } = await manager.searchCrossScope('beta', 'workspace');
      expect(knowledge.map((r) => r.item.id)).not.toContain(privateFact.id);
      await manager.close();
    });
  });

  describe('F4 (item 2) temporal replay cross-scope reads', () => {
    function seedReplay(): {
      adapter: ReturnType<typeof createInMemoryAdapter>;
      privateFact: KnowledgeMemory;
      workspaceFact: KnowledgeMemory;
    } {
      const adapter = createInMemoryAdapter();
      const privateFact = adapter.insertKnowledgeMemory({
        ...scopeA,
        visibility_class: 'private',
        fact: 'gamma delta private detail',
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
        created_at: 100,
      });
      const workspaceFact = adapter.insertKnowledgeMemory({
        ...scopeA,
        visibility_class: 'workspace',
        fact: 'gamma delta shared detail',
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
        created_at: 101,
      });
      return { adapter, privateFact, workspaceFact };
    }

    it('excludes a private fact from a different scope on every cross-scope read path', async () => {
      const { privateFact, workspaceFact } = seedReplay();
      const replay = createTemporalReplayAdapter(
        emptyReplayState([privateFact, workspaceFact]),
        1_000,
      );

      const activeIds = (await replay.getActiveKnowledgeCrossScope(scopeB, 'workspace')).map(
        (k) => k.id,
      );
      expect(activeIds).toContain(workspaceFact.id);
      expect(activeIds).not.toContain(privateFact.id);

      const sinceIds = (await replay.getKnowledgeSince(scopeB, 'workspace', 0)).map((k) => k.id);
      expect(sinceIds).not.toContain(privateFact.id);

      const searchIds = (
        await replay.searchKnowledgeCrossScope(scopeB, 'workspace', 'gamma delta')
      ).map((r) => r.item.id);
      expect(searchIds).toContain(workspaceFact.id);
      expect(searchIds).not.toContain(privateFact.id);
    });

    it('replay search rank stays within the (0,1] SearchResult contract', async () => {
      const { workspaceFact } = seedReplay();
      const replay = createTemporalReplayAdapter(emptyReplayState([workspaceFact]), 1_000);

      // Multi-term full-coverage query: the pre-fix local scoreText added a 0.25
      // phrase bonus ON TOP of coverage 1.0, reaching 1.25 and breaking the
      // ceiling. Reading the peer scope from itself so it is visible.
      const results = await replay.searchKnowledgeCrossScope(
        scopeA,
        'workspace',
        'gamma delta shared detail',
      );
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.rank).toBeGreaterThan(0);
        expect(r.rank).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('CoreLeaks memory-adapter contract fixes', () => {
  it('(item 4) honors caller-supplied created_at on knowledge insert; last_accessed_at follows it', () => {
    const adapter = createInMemoryAdapter();
    const record = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'imported at a fixed time',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
      created_at: 1_234_567,
    });
    expect(record.created_at).toBe(1_234_567);
    expect(record.last_accessed_at).toBe(1_234_567);
  });

  it('(item 6/F1) knowledge search is any-term (OR): a row matching only ONE query term is returned', () => {
    const adapter = createInMemoryAdapter();
    const onlyAlpha = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'alpha topic only',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const onlyBeta = adapter.insertKnowledgeMemory({
      ...scopeA,
      fact: 'beta topic only',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const ids = adapter.searchKnowledge(scopeA, 'alpha beta').map((r) => r.item.id);
    // OR semantics: BOTH single-term rows surface (AND semantics would return none).
    expect(ids).toContain(onlyAlpha.id);
    expect(ids).toContain(onlyBeta.id);
  });

  it('(item 5) playbook admitted only by a substring match carries a strictly-positive (0,1] rank', () => {
    const adapter = createInMemoryAdapter();
    adapter.insertPlaybook({
      ...scopeA,
      title: 'Deployment runbook',
      description: 'general',
      instructions: 'steps',
    });
    // Query token "deploy" is a SUBSTRING of "deployment" (admitted) but not an
    // exact token, so scoreLexical alone would score 0; the floor keeps rank > 0.
    const results = adapter.searchPlaybooks(scopeA, 'deploy');
    expect(results).toHaveLength(1);
    expect(results[0].rank).toBeGreaterThan(0);
    expect(results[0].rank).toBeLessThanOrEqual(1);
  });
});
