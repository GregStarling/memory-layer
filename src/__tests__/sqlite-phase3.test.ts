import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter, createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import type { NewKnowledgeMemory } from '../contracts/types.js';

/**
 * SQLite adapter Phase 3 parity regressions. Each test fails on the pre-Phase-3
 * behavior it guards (constant-1.0 rank, index-as-rank, raw-query FTS throw,
 * post-LIMIT filtering starvation, missing cross-scope visibility gate).
 */

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    collaboration_id: '',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function fact(overrides: Partial<NewKnowledgeMemory> & { fact: string; scope: MemoryScope }): NewKnowledgeMemory {
  const { scope: s, ...rest } = overrides;
  return {
    ...s,
    fact: rest.fact,
    fact_type: 'reference',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    source: 'manual',
    confidence: 'high',
    ...rest,
  };
}

describe('SQLite Phase 3 parity', () => {
  let adapter: StorageAdapter;
  const s = scope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  describe('P2 rank normalization', () => {
    it('gives two hits for one query DISTINCT, correctly-ordered (0,1] ranks', () => {
      // Pre-P2: normalizeRank clamped every bm25 hit to a constant 1.0.
      adapter.insertKnowledgeMemory(
        fact({ scope: s, fact: 'deploy deploy deploy checklist for the release' }),
      );
      adapter.insertKnowledgeMemory(
        fact({
          scope: s,
          fact: 'deploy the annual company picnic schedule alongside many other unrelated notes',
        }),
      );

      const results = adapter.searchKnowledge(s, 'deploy');
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.rank).toBeGreaterThan(0);
        expect(r.rank).toBeLessThanOrEqual(1);
      }
      // Strictly distinct + ordered rank DESC (the old constant-1.0 made these equal).
      expect(results[0].rank).toBeGreaterThan(results[1].rank);
      // The term-dense, shorter fact must be the stronger bm25 hit.
      expect(results[0].item.fact).toContain('deploy deploy deploy');
    });

    it('searchPlaybooks returns a real (0,1] rank, not the array index', () => {
      // Pre-P2: rank was the array index → first hit got rank 0 (falsy).
      adapter.insertPlaybook({
        ...s,
        title: 'Deploy runbook',
        description: 'How to deploy the deploy pipeline deploy',
        instructions: 'run deploy',
      });
      adapter.insertPlaybook({
        ...s,
        title: 'Onboarding',
        description: 'deploy appears once here among many other onboarding words',
        instructions: 'welcome',
      });

      const results = adapter.searchPlaybooks(s, 'deploy');
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const r of results) {
        expect(r.rank).toBeGreaterThan(0);
        expect(r.rank).toBeLessThanOrEqual(1);
      }
      expect(results[0].rank).toBeGreaterThan(results[1].rank);
    });
  });

  describe('P1 FTS5 input safety', () => {
    it('a query with a stray FTS5 operator char returns results and does not throw', () => {
      adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'deploy checklist reviewed' }));
      for (const query of ['deploy"', 'deploy AND', 'deploy)', '"deploy', 'deploy* (checklist']) {
        expect(() => adapter.searchKnowledge(s, query)).not.toThrow();
        const results = adapter.searchKnowledge(s, query);
        expect(results.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('P4 filters before LIMIT', () => {
    it('returns a high-trust match beyond the top-N bm25 hits when filtering by trust', () => {
      // Four short, term-dense low-trust facts dominate bm25; one long, term-sparse
      // high-trust fact ranks last. Pre-P4 (filter after LIMIT) starved it.
      for (let i = 0; i < 4; i += 1) {
        adapter.insertKnowledgeMemory(
          fact({ scope: s, fact: 'deploy deploy deploy now', trust_score: 0.3 }),
        );
      }
      const high = adapter.insertKnowledgeMemory(
        fact({
          scope: s,
          fact: 'deploy is mentioned once inside this much longer low-frequency sentence about process',
          trust_score: 0.95,
        }),
      );

      const results = adapter.searchKnowledge(s, 'deploy', {
        limit: 2,
        minimumTrustScore: 0.5,
      });
      // Only the high-trust fact clears the trust filter; it must survive despite
      // ranking last in raw bm25 (the filter runs in the WHERE, before LIMIT).
      expect(results.map((r) => r.item.id)).toContain(high.id);
      expect(results.every((r) => r.item.trust_score >= 0.5)).toBe(true);
    });

    it('applies tag containment in the WHERE before LIMIT', () => {
      for (let i = 0; i < 4; i += 1) {
        adapter.insertKnowledgeMemory(
          fact({ scope: s, fact: 'deploy deploy deploy now', tags: ['other'] }),
        );
      }
      const tagged = adapter.insertKnowledgeMemory(
        fact({
          scope: s,
          fact: 'deploy appears once in this longer tagged sentence about the pipeline',
          tags: ['release'],
        }),
      );
      const results = adapter.searchKnowledge(s, 'deploy', { limit: 2, tags: ['release'] });
      expect(results.map((r) => r.item.id)).toContain(tagged.id);
    });
  });

  describe('P6 cross-scope visibility', () => {
    const levels: ScopeLevel[] = ['scope', 'workspace', 'system', 'tenant'];
    const scopeA = scope({ scope_id: 'project/root', collaboration_id: 'collab-1' });
    // Reader in a different scope_id/system_id but same tenant+workspace.
    const scopeB = scope({
      scope_id: 'project/other',
      system_id: 'other-agent',
      collaboration_id: 'collab-2',
    });

    it('a private fact in scope A never surfaces to scope B at any widening level', () => {
      const priv = adapter.insertKnowledgeMemory(
        fact({ scope: scopeA, fact: 'private deploy secret', visibility_class: 'private' }),
      );
      for (const level of levels) {
        expect(
          adapter.getActiveKnowledgeCrossScope(scopeB, level).map((k) => k.id),
        ).not.toContain(priv.id);
        expect(
          adapter.searchKnowledgeCrossScope(scopeB, level, 'deploy').map((r) => r.item.id),
        ).not.toContain(priv.id);
        expect(
          adapter.getKnowledgeSince(scopeB, level, 0).map((k) => k.id),
        ).not.toContain(priv.id);
      }
    });

    it('a workspace fact surfaces cross-scope within the same workspace', () => {
      const ws = adapter.insertKnowledgeMemory(
        fact({ scope: scopeA, fact: 'workspace deploy note', visibility_class: 'workspace' }),
      );
      expect(
        adapter.getActiveKnowledgeCrossScope(scopeB, 'workspace').map((k) => k.id),
      ).toContain(ws.id);
      expect(
        adapter.searchKnowledgeCrossScope(scopeB, 'workspace', 'deploy').map((r) => r.item.id),
      ).toContain(ws.id);
    });

    it('a shared_collaboration fact surfaces only inside its collaboration_id', () => {
      const shared = adapter.insertKnowledgeMemory(
        fact({
          scope: scopeA,
          fact: 'shared collaboration deploy note',
          visibility_class: 'shared_collaboration',
        }),
      );
      // scopeB is in a DIFFERENT collaboration → must not see it.
      expect(
        adapter.searchKnowledgeCrossScope(scopeB, 'workspace', 'deploy').map((r) => r.item.id),
      ).not.toContain(shared.id);
      // A reader in the SAME collaboration (different scope_id) sees it.
      const sameCollab = scope({ scope_id: 'project/sibling', collaboration_id: 'collab-1' });
      expect(
        adapter.searchKnowledgeCrossScope(sameCollab, 'workspace', 'deploy').map((r) => r.item.id),
      ).toContain(shared.id);
    });

    it('persists a caller-supplied visibility_class on insert (round-trip)', () => {
      const ws = adapter.insertKnowledgeMemory(
        fact({ scope: s, fact: 'round trip', visibility_class: 'workspace' }),
      );
      expect(adapter.getKnowledgeMemoryById(ws.id)?.visibility_class).toBe('workspace');
    });
  });

  // ── F1: multi-term FTS is any-term (OR), not implicit-AND ──────────────────
  describe('F1 multi-term search is any-term (OR)', () => {
    it('searchKnowledge returns rows matching ANY term when some rows match every term', () => {
      // With a row that matches BOTH terms present, the FTS MATCH returns rows
      // (so the JS any-term fallback does NOT engage). Under the old implicit-AND
      // MATCH only the both-terms row would surface; single-term rows would be
      // silently dropped. OR-joined terms surface all three.
      const alpha = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'alpha widget notes' }));
      const beta = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'beta gadget notes' }));
      const both = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'alpha and beta together' }));

      const ids = adapter.searchKnowledge(s, 'alpha beta').map((r) => r.item.id);
      expect(ids).toContain(both.id);
      expect(ids).toContain(alpha.id); // AND-only MATCH would drop this
      expect(ids).toContain(beta.id); // AND-only MATCH would drop this
    });

    it('searchKnowledgeCrossScope is any-term (OR) across a widening level', () => {
      const wsScope = scope({ scope_id: 'src', system_id: 'agent-a' });
      const reader = scope({ scope_id: 'dst', system_id: 'agent-b' });
      const alpha = adapter.insertKnowledgeMemory(
        fact({ scope: wsScope, fact: 'alpha only fact', visibility_class: 'workspace' }),
      );
      const beta = adapter.insertKnowledgeMemory(
        fact({ scope: wsScope, fact: 'beta only fact', visibility_class: 'workspace' }),
      );
      const both = adapter.insertKnowledgeMemory(
        fact({ scope: wsScope, fact: 'alpha beta fact', visibility_class: 'workspace' }),
      );
      const ids = adapter
        .searchKnowledgeCrossScope(reader, 'workspace', 'alpha beta')
        .map((r) => r.item.id);
      expect(ids).toEqual(expect.arrayContaining([alpha.id, beta.id, both.id]));
    });

    it('searchTurns is any-term (OR) — no JS fallback masks the FTS behavior', () => {
      // searchTurns has no JS full-scan fallback, so the FTS operator is the whole
      // story. Two rows each matching exactly one term must BOTH return; the old
      // implicit-AND MATCH would return zero.
      adapter.insertTurn({ ...s, session_id: 'sess', actor: 'user', role: 'user', content: 'alpha here' });
      adapter.insertTurn({ ...s, session_id: 'sess', actor: 'user', role: 'user', content: 'beta there' });
      const results = adapter.searchTurns(s, 'alpha beta');
      expect(results).toHaveLength(2);
    });
  });

  // ── F5: honor a caller-supplied created_at on knowledge insert ─────────────
  describe('F5 knowledge honors caller created_at', () => {
    it('round-trips a backdated created_at (was always stamped now)', () => {
      const backdated = 1_600_000_321;
      const k = adapter.insertKnowledgeMemory(
        fact({ scope: s, fact: 'backdated import', created_at: backdated }),
      );
      expect(adapter.getKnowledgeMemoryById(k.id)?.created_at).toBe(backdated);
    });
  });

  // ── F6(d): residual cross-scope ordering is created_at ASC, id ASC ─────────
  describe('F6(d) cross-scope ordering', () => {
    it('getActiveKnowledgeCrossScope returns created_at ASC, id ASC (honors created_at)', () => {
      const vis = { visibility_class: 'tenant' as const };
      const c = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'ord c', ...vis, created_at: 300 }));
      const a1 = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'ord a1', ...vis, created_at: 100 }));
      const a2 = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'ord a2', ...vis, created_at: 100 }));
      const b = adapter.insertKnowledgeMemory(fact({ scope: s, fact: 'ord b', ...vis, created_at: 200 }));
      const ids = adapter.getActiveKnowledgeCrossScope(s, 'tenant').map((k) => k.id);
      expect(ids).toEqual([a1.id, a2.id, b.id, c.id]);
    });

    it('getActivePlaybooksCrossScope returns created_at ASC, id ASC (honors created_at)', () => {
      const pbC = adapter.insertPlaybook({
        ...s, visibility_class: 'tenant', title: 'pb C', description: 'd', instructions: 'i', created_at: 300,
      });
      const pbA = adapter.insertPlaybook({
        ...s, visibility_class: 'tenant', title: 'pb A', description: 'd', instructions: 'i', created_at: 100,
      });
      const pbB = adapter.insertPlaybook({
        ...s, visibility_class: 'tenant', title: 'pb B', description: 'd', instructions: 'i', created_at: 200,
      });
      const ids = adapter.getActivePlaybooksCrossScope(s, 'tenant').map((p) => p.id);
      expect(ids).toEqual([pbA.id, pbB.id, pbC.id]);
    });
  });

  // ── F4: event-log cross-scope reads gate on the payload-derived class ──────
  describe('F4 event-log cross-scope visibility', () => {
    const scopeA = scope({ scope_id: 'evt/src', collaboration_id: 'collab-1' });
    const reader = scope({ scope_id: 'evt/dst', system_id: 'other-agent', collaboration_id: 'collab-2' });
    const levels: ScopeLevel[] = ['scope', 'workspace', 'system', 'tenant'];

    it("a private fact's knowledge.created event never surfaces cross-scope (payload.after holds the fact text)", () => {
      const priv = adapter.insertKnowledgeMemory(
        fact({ scope: scopeA, fact: 'private event fact text', visibility_class: 'private' }),
      );
      const ws = adapter.insertKnowledgeMemory(
        fact({ scope: scopeA, fact: 'workspace event fact text', visibility_class: 'workspace' }),
      );
      const knowledgeEventIds = (level: ScopeLevel): string[] =>
        adapter
          .listMemoryEventsCrossScope(reader, level, { limit: 200 })
          .events.filter((e) => e.entity_kind === 'knowledge_memory')
          .map((e) => e.entity_id);
      for (const level of levels) {
        expect(knowledgeEventIds(level)).not.toContain(String(priv.id));
      }
      // Positive control: the workspace fact's event surfaces at workspace widening.
      expect(knowledgeEventIds('workspace')).toContain(String(ws.id));
    });
  });
});

// ── F4: semantic cross-scope reads gate on base visibility ──────────────────
describe('SQLite F4 semantic cross-scope visibility', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;
  const scopeA = scope({ scope_id: 'sem/src', collaboration_id: 'collab-1' });
  const reader = scope({ scope_id: 'sem/dst', system_id: 'other-agent', collaboration_id: 'collab-2' });
  const levels: ScopeLevel[] = ['scope', 'workspace', 'system', 'tenant'];
  const vec = (): Float32Array => Float32Array.from([1, 0, 0, 0]);
  const meta = { model: 'm', dimensions: 4 } as const;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });
  afterEach(() => {
    adapter.close();
  });

  it('a private fact with an embedding is invisible to findSimilarCrossScope from another scope', () => {
    const priv = adapter.insertKnowledgeMemory(
      fact({ scope: scopeA, fact: 'private semantic secret', visibility_class: 'private' }),
    );
    adapter.embeddings.storeEmbedding(priv.id, vec(), meta);
    const ws = adapter.insertKnowledgeMemory(
      fact({ scope: scopeA, fact: 'workspace semantic note', visibility_class: 'workspace' }),
    );
    adapter.embeddings.storeEmbedding(ws.id, vec(), meta);

    for (const level of levels) {
      const hits = adapter.embeddings
        .findSimilarCrossScope(reader, level, vec(), { limit: 10, minSimilarity: 0, filter: meta })
        .map((h) => h.knowledgeMemoryId);
      expect(hits).not.toContain(priv.id);
    }
    // Positive control: the workspace fact IS found at workspace widening.
    const wsHits = adapter.embeddings
      .findSimilarCrossScope(reader, 'workspace', vec(), { limit: 10, minSimilarity: 0, filter: meta })
      .map((h) => h.knowledgeMemoryId);
    expect(wsHits).toContain(ws.id);
  });
});
