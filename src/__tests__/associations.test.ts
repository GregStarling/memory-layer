import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import { traverseAssociations, autoDetectAssociations } from '../core/associations.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

describe('associations', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;
  const s = scope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  describe('traverseAssociations', () => {
    it('returns start node with no edges when no associations exist', async () => {
      const km = adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Isolated fact',
        fact_type: 'entity',
        source: 'user_stated',
        confidence: 'high',
      });

      const graph = await traverseAssociations(asyncAdapter, s, 'knowledge', km.id);
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0]).toEqual({ kind: 'knowledge', id: km.id });
      expect(graph.edges).toHaveLength(0);
    });

    it('traverses one hop from source to target', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact A', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact B', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });

      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km1.id,
        target_kind: 'knowledge', target_id: km2.id,
        association_type: 'supports',
      });

      const graph = await traverseAssociations(asyncAdapter, s, 'knowledge', km1.id);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].association_type).toBe('supports');
    });

    it('traverses two hops by default', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact A', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact B', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      const km3 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact C', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });

      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km1.id,
        target_kind: 'knowledge', target_id: km2.id,
        association_type: 'related_to',
      });
      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km2.id,
        target_kind: 'knowledge', target_id: km3.id,
        association_type: 'supports',
      });

      const graph = await traverseAssociations(asyncAdapter, s, 'knowledge', km1.id);
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(2);
    });

    it('respects maxDepth=1 bound', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact A', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact B', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      const km3 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact C', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });

      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km1.id,
        target_kind: 'knowledge', target_id: km2.id,
        association_type: 'related_to',
      });
      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km2.id,
        target_kind: 'knowledge', target_id: km3.id,
        association_type: 'supports',
      });

      const graph = await traverseAssociations(asyncAdapter, s, 'knowledge', km1.id, { maxDepth: 1 });
      expect(graph.nodes).toHaveLength(2);
      // km3 should not be reached
      expect(graph.nodes.find((n) => n.id === km3.id)).toBeUndefined();
    });

    it('respects maxNodes bound', async () => {
      // Create a star graph with center + 5 spokes
      const center = adapter.insertKnowledgeMemory({
        ...s, fact: 'Center', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      for (let i = 0; i < 5; i++) {
        const spoke = adapter.insertKnowledgeMemory({
          ...s, fact: `Spoke ${i}`, fact_type: 'entity', source: 'user_stated', confidence: 'high',
        });
        adapter.insertAssociation({
          ...s,
          source_kind: 'knowledge', source_id: center.id,
          target_kind: 'knowledge', target_id: spoke.id,
          association_type: 'related_to',
        });
      }

      const graph = await traverseAssociations(asyncAdapter, s, 'knowledge', center.id, { maxNodes: 3 });
      expect(graph.nodes.length).toBeLessThanOrEqual(3);
    });

    it('does not revisit nodes in cycles', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact A', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Fact B', fact_type: 'entity', source: 'user_stated', confidence: 'high',
      });

      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km1.id,
        target_kind: 'knowledge', target_id: km2.id,
        association_type: 'related_to',
      });
      adapter.insertAssociation({
        ...s,
        source_kind: 'knowledge', source_id: km2.id,
        target_kind: 'knowledge', target_id: km1.id,
        association_type: 'related_to',
      });

      const graph = await traverseAssociations(asyncAdapter, s, 'knowledge', km1.id);
      expect(graph.nodes).toHaveLength(2);
    });
  });

  describe('autoDetectAssociations', () => {
    it('creates supports edge for similar facts', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'User prefers dark mode for the IDE', fact_type: 'preference',
        source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'User prefers dark mode for the terminal', fact_type: 'preference',
        source: 'user_stated', confidence: 'high',
      });

      const created = await autoDetectAssociations(asyncAdapter, s, km2, [km1]);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(created[0].auto_generated).toBe(true);
      const types = created.map((a) => a.association_type);
      expect(types.some((t) => t === 'supports' || t === 'related_to')).toBe(true);
    });

    it('creates contradicts edge for slot key conflicts', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'User prefers light mode',
        fact_type: 'preference', source: 'user_stated', confidence: 'high',
        slot_key: 'preference:mode', is_negated: false,
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'User does not prefer light mode',
        fact_type: 'preference', source: 'user_stated', confidence: 'high',
        slot_key: 'preference:mode', is_negated: true,
      });

      const created = await autoDetectAssociations(asyncAdapter, s, km2, [km1]);
      expect(created.some((a) => a.association_type === 'contradicts')).toBe(true);
    });

    it('does not create edges for unrelated facts', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'The database runs on PostgreSQL', fact_type: 'entity',
        source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Meetings are scheduled on Fridays', fact_type: 'entity',
        source: 'user_stated', confidence: 'high',
      });

      const created = await autoDetectAssociations(asyncAdapter, s, km2, [km1]);
      expect(created).toHaveLength(0);
    });

    it('skips self-association', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'Some fact', fact_type: 'entity',
        source: 'user_stated', confidence: 'high',
      });

      const created = await autoDetectAssociations(asyncAdapter, s, km1, [km1]);
      expect(created).toHaveLength(0);
    });

    it('handles duplicate association gracefully', async () => {
      const km1 = adapter.insertKnowledgeMemory({
        ...s, fact: 'User prefers Rust for systems programming', fact_type: 'preference',
        source: 'user_stated', confidence: 'high',
      });
      const km2 = adapter.insertKnowledgeMemory({
        ...s, fact: 'User prefers Rust for memory-safe systems', fact_type: 'preference',
        source: 'user_stated', confidence: 'high',
      });

      // First call creates associations
      const first = await autoDetectAssociations(asyncAdapter, s, km2, [km1]);
      // Second call should not throw on duplicate
      const second = await autoDetectAssociations(asyncAdapter, s, km2, [km1]);
      expect(second).toHaveLength(0);
      expect(first.length).toBeGreaterThanOrEqual(1);
    });
  });
});
