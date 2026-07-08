import { describe, expect, it } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import {
  normalizeBm25Rank,
  normalizeTsRank,
  resolveSearchOptions,
  scoreLexical,
} from '../adapters/shared/search.js';
import { isBaseVisible } from '../adapters/shared/visibility.js';
import { makeScope } from './test-helpers.js';
import type { MemoryScope } from '../contracts/identity.js';

function knowledge(scope: MemoryScope, overrides: Record<string, unknown> = {}) {
  return {
    ...scope,
    fact: 'placeholder fact',
    fact_type: 'reference' as const,
    source: 'manual' as const,
    confidence: 'high' as const,
    ...overrides,
  };
}

describe('Phase 3 shared kernel', () => {
  describe('3.1/P2 shared search helpers', () => {
    it('scoreLexical stays in (0,1] and ranks fuller matches higher', () => {
      const full = scoreLexical('alpha beta', 'the alpha beta gamma');
      const partial = scoreLexical('alpha beta', 'alpha only here');
      expect(full).toBeGreaterThan(0);
      expect(full).toBeLessThanOrEqual(1);
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThanOrEqual(1);
      expect(full).toBeGreaterThan(partial);
      expect(scoreLexical('zzz', 'alpha beta')).toBe(0);
    });

    it('normalizeBm25Rank maps negative-is-better into (0,1] with correct direction', () => {
      // FTS5 bm25 is more-negative-is-better; a stronger (more negative) match
      // must normalize HIGHER (this is the direction the manager example inverted).
      expect(normalizeBm25Rank(-10)).toBeGreaterThan(normalizeBm25Rank(-1));
      expect(normalizeBm25Rank(-1)).toBeGreaterThan(0);
      expect(normalizeBm25Rank(-1)).toBeLessThanOrEqual(1);
      expect(normalizeBm25Rank(null)).toBe(0);
      expect(normalizeBm25Rank(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('normalizeTsRank maps ts_rank (higher-is-better) into (0,1]', () => {
      expect(normalizeTsRank(5)).toBeGreaterThan(normalizeTsRank(0.5));
      expect(normalizeTsRank(0.5)).toBeGreaterThan(0);
      expect(normalizeTsRank(5)).toBeLessThanOrEqual(1);
      expect(normalizeTsRank(0)).toBe(0);
      expect(normalizeTsRank(null)).toBe(0);
    });

    it('resolveSearchOptions defaults activeOnly true and limit 10', () => {
      expect(resolveSearchOptions().activeOnly).toBe(true);
      expect(resolveSearchOptions().limit).toBe(10);
      expect(resolveSearchOptions({ activeOnly: false }).activeOnly).toBe(false);
    });
  });

  describe('P2 playbook rank (was array index)', () => {
    it('returns a real (0,1] rank, title matches ranked above body matches', () => {
      const adapter = createInMemoryAdapter();
      const s = makeScope();
      const titled = adapter.insertPlaybook({
        ...s,
        title: 'Deploy pipeline',
        description: 'general',
        instructions: 'steps',
      });
      const bodied = adapter.insertPlaybook({
        ...s,
        title: 'General guide',
        description: 'general',
        instructions: 'deploy steps here',
      });
      const results = adapter.searchPlaybooks(s, 'deploy');
      expect(results.map((r) => r.item.id).sort()).toEqual([titled.id, bodied.id].sort());
      expect(results.every((r) => r.rank > 0 && r.rank <= 1)).toBe(true);
      expect(results[0].item.id).toBe(titled.id);
      expect(results[0].rank).toBeGreaterThan(results[1].rank);
    });
  });

  describe('P3 ordering: created_at ASC then id ASC', () => {
    it('orders time-range reads by created_at even when inserted out of order', () => {
      const adapter = createInMemoryAdapter();
      const s = makeScope();
      adapter.insertWorkItem({ ...s, kind: 'objective', title: 'A', created_at: 300 });
      adapter.insertWorkItem({ ...s, kind: 'objective', title: 'B', created_at: 100 });
      adapter.insertWorkItem({ ...s, kind: 'objective', title: 'C', created_at: 200 });
      const ordered = adapter
        .getWorkItemsByTimeRange(s, { start_at: 0, end_at: 1000 })
        .map((w) => w.title);
      expect(ordered).toEqual(['B', 'C', 'A']);
    });
  });

  describe('P6 cross-scope visibility gate', () => {
    it('shared_collaboration is gated by collaboration_id', () => {
      const adapter = createInMemoryAdapter();
      const collabA = makeScope({ system_id: 'planner', collaboration_id: 'factory-1', scope_id: 't1' });
      const collabB = makeScope({ system_id: 'executor', collaboration_id: 'factory-1', scope_id: 't2' });
      const collabC = makeScope({ system_id: 'outsider', collaboration_id: 'factory-2', scope_id: 't3' });
      adapter.insertKnowledgeMemory(
        knowledge(collabA, { visibility_class: 'shared_collaboration', fact: 'collab secret' }),
      );

      const factsFor = (scope: MemoryScope, level: 'workspace' | 'tenant') =>
        adapter.getActiveKnowledgeCrossScope(scope, level).map((k) => k.fact);

      expect(factsFor(collabB, 'workspace')).toContain('collab secret');
      expect(factsFor(collabC, 'workspace')).not.toContain('collab secret');
      expect(factsFor(collabC, 'tenant')).not.toContain('collab secret');
    });

    it('workspace and tenant classes widen as declared; private never leaks', () => {
      const adapter = createInMemoryAdapter();
      const a = makeScope({ workspace_id: 'w1', scope_id: 'a' });
      const otherWorkspace = makeScope({ workspace_id: 'w2', scope_id: 'x' });
      const sameWorkspace = makeScope({ workspace_id: 'w1', scope_id: 'b' });
      adapter.insertKnowledgeMemory(knowledge(a, { visibility_class: 'workspace', fact: 'ws fact' }));
      adapter.insertKnowledgeMemory(knowledge(a, { visibility_class: 'tenant', fact: 'tenant fact' }));
      adapter.insertKnowledgeMemory(knowledge(a, { visibility_class: 'private', fact: 'priv fact' }));

      const wsView = adapter.getActiveKnowledgeCrossScope(sameWorkspace, 'workspace').map((k) => k.fact);
      expect(wsView).toContain('ws fact');
      expect(wsView).toContain('tenant fact');
      expect(wsView).not.toContain('priv fact');

      const otherWsTenant = adapter
        .getActiveKnowledgeCrossScope(otherWorkspace, 'tenant')
        .map((k) => k.fact);
      expect(otherWsTenant).toContain('tenant fact');
      expect(otherWsTenant).not.toContain('ws fact');
      expect(otherWsTenant).not.toContain('priv fact');
    });

    it('isBaseVisible denies across tenants unconditionally', () => {
      const item = makeScope({ tenant_id: 'acme', scope_id: 'a' });
      const reader = makeScope({ tenant_id: 'globex', scope_id: 'a' });
      expect(isBaseVisible('tenant', item, reader)).toBe(false);
    });
  });

  describe('3.7 wrapper transaction delegation', () => {
    it('rolls back a synchronous body via the native transaction', async () => {
      const mem = createInMemoryAdapter();
      const wrapped = wrapSyncAdapter(mem);
      const s = makeScope();
      await expect(
        wrapped.transaction((() => {
          mem.insertWorkItem({ ...s, kind: 'objective', title: 'partial' });
          throw new Error('boom');
        }) as unknown as () => Promise<void>),
      ).rejects.toThrow('boom');
      // The partial insert was rolled back by the native transaction.
      expect(mem.getActiveWorkItems(s)).toHaveLength(0);
    });

    it('still runs async bodies (no regression)', async () => {
      const mem = createInMemoryAdapter();
      const wrapped = wrapSyncAdapter(mem);
      const s = makeScope();
      const item = await wrapped.transaction(async () => {
        return wrapped.insertWorkItem({ ...s, kind: 'objective', title: 'ok' });
      });
      expect(item.id).toBeGreaterThan(0);
      expect(mem.getActiveWorkItems(s)).toHaveLength(1);
    });
  });
});
