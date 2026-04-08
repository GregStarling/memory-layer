import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { discover } from '../core/discover.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

const scope: MemoryScope = {
  tenant_id: 'test',
  system_id: 'test',
  scope_id: 'discover-test',
};

describe('discover', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  it('returns empty report when no associations exist', async () => {
    const report = await discover(adapter, scope);
    expect(report.surprises).toEqual([]);
    expect(report.graphStats.totalNodes).toBe(0);
    expect(report.graphStats.totalEdges).toBe(0);
    expect(report.graphStats.avgDegree).toBe(0);
    expect(typeof report.timestamp).toBe('number');
  });

  it('computes betweenness centrality and identifies bridge nodes', async () => {
    // Create a linear chain: A -- B -- C
    // B is the bridge between A and C
    const now = Math.floor(Date.now() / 1000);
    const factA = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Fact A about deployment', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const factB = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Fact B bridging topics', fact_type: 'entity',
      knowledge_class: 'strategy', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const factC = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Fact C about testing', fact_type: 'entity',
      knowledge_class: 'procedure', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: factA.id,
      target_kind: 'knowledge', target_id: factB.id,
      association_type: 'related_to', confidence: 0.6, auto_generated: true,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: factB.id,
      target_kind: 'knowledge', target_id: factC.id,
      association_type: 'related_to', confidence: 0.6, auto_generated: true,
    });

    const report = await discover(adapter, scope);
    expect(report.graphStats.totalNodes).toBe(3);
    expect(report.graphStats.totalEdges).toBe(2);
    expect(report.surprises.length).toBeGreaterThan(0);

    // Both edges should be scored, and the ones involving B (the bridge)
    // should have higher centrality contribution
    for (const s of report.surprises) {
      expect(s.score).toBeGreaterThan(0);
      expect(s.explanation.length).toBeGreaterThan(0);
    }
  });

  it('detects cross-class bridges and scores them higher', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Same-class pair
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Fact 1', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Fact 2', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    // Cross-class target
    const k3 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Fact 3', fact_type: 'entity',
      knowledge_class: 'identity', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'supports', confidence: 0.8, auto_generated: true,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k3.id,
      association_type: 'related_to', confidence: 0.8, auto_generated: true,
    });

    const report = await discover(adapter, scope);
    expect(report.surprises.length).toBe(2);

    // The cross-class edge (k1->k3: project_fact->identity) should score higher
    const crossClass = report.surprises.find(
      (s) => s.sourceId === `knowledge:${k1.id}` && s.targetId === `knowledge:${k3.id}`,
    );
    const sameClass = report.surprises.find(
      (s) => s.sourceId === `knowledge:${k1.id}` && s.targetId === `knowledge:${k2.id}`,
    );
    expect(crossClass).toBeDefined();
    expect(sameClass).toBeDefined();
    expect(crossClass!.score).toBeGreaterThan(sameClass!.score);
    expect(crossClass!.explanation).toContain('project_fact');
    expect(crossClass!.explanation).toContain('identity');
  });

  it('scores contradictions higher than supports', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Deploy to US East', fact_type: 'decision',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Deploy to EU West', fact_type: 'decision',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k3 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Deploy to US East confirmed', fact_type: 'decision',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'contradicts', confidence: 0.7, auto_generated: true,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k3.id,
      association_type: 'supports', confidence: 0.7, auto_generated: true,
    });

    const report = await discover(adapter, scope);
    const contradiction = report.surprises.find((s) => s.bridgeType === 'contradiction');
    const support = report.surprises.find((s) => s.bridgeType !== 'contradiction');
    expect(contradiction).toBeDefined();
    expect(support).toBeDefined();
    expect(contradiction!.score).toBeGreaterThan(support!.score);
  });

  it('respects maxResults option', async () => {
    const now = Math.floor(Date.now() / 1000);
    const facts = [];
    for (let i = 0; i < 5; i++) {
      facts.push(
        adapter.insertKnowledgeMemory({
          ...scope, fact: `Fact ${i}`, fact_type: 'entity',
          knowledge_class: i % 2 === 0 ? 'project_fact' : 'strategy',
          source: 'user_stated', confidence: 'high',
          created_at: now, last_accessed_at: now,
        }),
      );
    }

    // Create a chain of associations
    for (let i = 0; i < facts.length - 1; i++) {
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: facts[i].id,
        target_kind: 'knowledge', target_id: facts[i + 1].id,
        association_type: 'related_to', confidence: 0.5, auto_generated: true,
      });
    }

    const report = await discover(adapter, scope, { maxResults: 2 });
    expect(report.surprises.length).toBe(2);
  });

  it('respects minSurpriseScore option', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Low surprise', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Low surprise too', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'supports', confidence: 0.95, auto_generated: true,
    });

    const report = await discover(adapter, scope, { minSurpriseScore: 0.99 });
    expect(report.surprises.length).toBe(0);
    // Graph stats should still be computed
    expect(report.graphStats.totalEdges).toBe(1);
  });

  it('generates explanations with low-confidence note', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Ambiguous fact', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'low',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Another ambiguous fact', fact_type: 'entity',
      knowledge_class: 'strategy', source: 'user_stated', confidence: 'low',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'related_to', confidence: 0.2, auto_generated: true,
    });

    const report = await discover(adapter, scope);
    expect(report.surprises.length).toBe(1);
    expect(report.surprises[0].explanation).toContain('Low confidence');
    expect(report.surprises[0].explanation).toContain('project_fact');
    expect(report.surprises[0].explanation).toContain('strategy');
  });

  it('is read-only — does not mutate knowledge or associations', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Immutable', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Also immutable', fact_type: 'entity',
      knowledge_class: 'strategy', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'related_to', confidence: 0.5, auto_generated: true,
    });

    const knowledgeBefore = adapter.getActiveKnowledgeMemory(scope);
    const assocsBefore = adapter.listAssociations(scope);

    await discover(adapter, scope);

    const knowledgeAfter = adapter.getActiveKnowledgeMemory(scope);
    const assocsAfter = adapter.listAssociations(scope);

    expect(knowledgeAfter).toEqual(knowledgeBefore);
    expect(assocsAfter).toEqual(assocsBefore);
  });

  it('classifies entity_shared bridges when facts share a subject', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Alice prefers dark mode', fact_type: 'preference',
      knowledge_class: 'preference', source: 'user_stated', confidence: 'high',
      fact_subject: 'Alice', created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Alice leads backend team', fact_type: 'entity',
      knowledge_class: 'identity', source: 'user_stated', confidence: 'high',
      fact_subject: 'Alice', created_at: now + 120, last_accessed_at: now + 120,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'related_to', confidence: 0.6, auto_generated: true,
    });

    const report = await discover(adapter, scope);
    expect(report.surprises.length).toBe(1);
    expect(report.surprises[0].bridgeType).toBe('entity_shared');
    expect(report.surprises[0].explanation).toContain('Alice');
  });
});
