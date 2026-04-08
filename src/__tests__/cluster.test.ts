import { describe, expect, it } from 'vitest';

import type { Association, KnowledgeMemory } from '../contracts/types.js';
import {
  computeClusters,
  formatClustersAsSection,
  expandFromClusters,
} from '../core/cluster.js';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { getGraphReport } from '../core/graph-report.js';

function makeKM(id: number, fact: string): KnowledgeMemory {
  return {
    id,
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    visibility_class: 'scope',
    fact,
    fact_type: 'reference',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    fact_subject: null,
    fact_attribute: null,
    fact_value: null,
    normalized_fact: fact.toLowerCase(),
    slot_key: null,
    is_negated: false,
    source: 'manual',
    confidence: 'high',
    confidence_score: 0.9,
    grounding_strength: 'strong',
    evidence_count: 1,
    trust_score: 0.85,
    verification_status: 'unverified',
    verification_notes: null,
    last_verified_at: null,
    next_reverification_at: null,
    last_confirmed_at: null,
    confirmation_count: 0,
    source_session_id: null,
    source_collaboration_id: null,
    source_working_memory_id: null,
    source_turn_ids: [],
    successful_use_count: 0,
    failed_use_count: 0,
    disputed_at: null,
    dispute_reason: null,
    contradiction_score: 0,
    superseded_at: null,
    superseded_by_id: null,
    retired_at: null,
    valid_from: null,
    valid_until: null,
    rationale: null,
    tags: [],
    created_at: 1000,
    last_accessed_at: 1000,
    access_count: 0,
    schema_version: 1,
  };
}

function makeAssoc(sourceId: number, targetId: number, type = 'related_to'): Association {
  return {
    id: sourceId * 100 + targetId,
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    visibility_class: 'scope',
    source_kind: 'knowledge',
    source_id: sourceId,
    target_kind: 'knowledge',
    target_id: targetId,
    association_type: type as any,
    provenance: 'extracted',
    confidence: 1.0,
    auto_generated: false,
    created_at: 1000,
  };
}

describe('computeClusters', () => {
  it('returns empty when no knowledge', () => {
    const result = computeClusters([], []);
    expect(result.clusters).toHaveLength(0);
    expect(result.interClusterRelationships).toHaveLength(0);
  });

  it('returns empty when no associations', () => {
    const knowledge = [makeKM(1, 'fact 1'), makeKM(2, 'fact 2')];
    const result = computeClusters(knowledge, []);
    expect(result.clusters).toHaveLength(0);
  });

  it('groups connected nodes into a single cluster', () => {
    const knowledge = [makeKM(1, 'fact 1'), makeKM(2, 'fact 2'), makeKM(3, 'fact 3')];
    const associations = [
      makeAssoc(1, 2),
      makeAssoc(2, 3),
    ];
    const result = computeClusters(knowledge, associations);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds.sort()).toEqual([1, 2, 3]);
    expect(result.clusters[0].internalEdges).toBe(2);
    expect(result.clusters[0].cohesion).toBeCloseTo(2 / 3, 2);
  });

  it('detects separate clusters', () => {
    const knowledge = [
      makeKM(1, 'A1'), makeKM(2, 'A2'), makeKM(3, 'A3'),
      makeKM(4, 'B1'), makeKM(5, 'B2'), makeKM(6, 'B3'),
    ];
    // Two disconnected triangles
    const associations = [
      makeAssoc(1, 2), makeAssoc(2, 3), makeAssoc(1, 3),
      makeAssoc(4, 5), makeAssoc(5, 6), makeAssoc(4, 6),
    ];
    const result = computeClusters(knowledge, associations);
    expect(result.clusters).toHaveLength(2);
    // Each cluster should have exactly 3 members
    const sizes = result.clusters.map((c) => c.memberIds.length).sort();
    expect(sizes).toEqual([3, 3]);
    // Triangles have perfect cohesion
    for (const cluster of result.clusters) {
      expect(cluster.cohesion).toBeCloseTo(1.0, 2);
      expect(cluster.internalEdges).toBe(3);
    }
  });

  it('filters by minimum cluster size', () => {
    const knowledge = [makeKM(1, 'A'), makeKM(2, 'B'), makeKM(3, 'C')];
    const associations = [makeAssoc(1, 2)];
    // Nodes 1,2 form a cluster of size 2; node 3 is isolated
    const result = computeClusters(knowledge, associations, { minClusterSize: 3 });
    expect(result.clusters).toHaveLength(0);

    const result2 = computeClusters(knowledge, associations, { minClusterSize: 2 });
    expect(result2.clusters).toHaveLength(1);
  });

  it('computes inter-cluster relationships', () => {
    // Two dense triangles connected by a single bridge edge
    const knowledge = [
      makeKM(1, 'A1'), makeKM(2, 'A2'), makeKM(3, 'A3'),
      makeKM(4, 'B1'), makeKM(5, 'B2'), makeKM(6, 'B3'),
    ];
    const associations = [
      // Triangle A: fully connected
      makeAssoc(1, 2), makeAssoc(2, 3), makeAssoc(1, 3),
      // Triangle B: fully connected
      makeAssoc(4, 5), makeAssoc(5, 6), makeAssoc(4, 6),
      // Single bridge
      makeAssoc(3, 4, 'supports'),
    ];
    const result = computeClusters(knowledge, associations);
    // Label propagation may or may not split these depending on iteration order;
    // verify the structure is consistent regardless
    if (result.clusters.length === 2) {
      expect(result.interClusterRelationships).toHaveLength(1);
      expect(result.interClusterRelationships[0].edgeCount).toBe(1);
      expect(result.interClusterRelationships[0].types).toContain('supports');
    } else {
      // If merged into one cluster, no inter-cluster relationships
      expect(result.clusters).toHaveLength(1);
      expect(result.interClusterRelationships).toHaveLength(0);
    }
  });

  it('limits top facts per cluster', () => {
    const knowledge = Array.from({ length: 10 }, (_, i) => makeKM(i + 1, `fact ${i + 1}`));
    // Fully connected
    const associations: Association[] = [];
    for (let i = 1; i <= 10; i++) {
      for (let j = i + 1; j <= 10; j++) {
        associations.push(makeAssoc(i, j));
      }
    }
    const result = computeClusters(knowledge, associations, { maxTopFacts: 3 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].topFacts).toHaveLength(3);
  });

  it('ignores non-knowledge associations', () => {
    const knowledge = [makeKM(1, 'A'), makeKM(2, 'B')];
    const associations: Association[] = [
      {
        ...makeAssoc(1, 2),
        source_kind: 'playbook', // not knowledge
      },
    ];
    const result = computeClusters(knowledge, associations);
    expect(result.clusters).toHaveLength(0);
  });

  it('ignores self-loops', () => {
    const knowledge = [makeKM(1, 'A'), makeKM(2, 'B')];
    const associations = [
      makeAssoc(1, 1), // self-loop
      makeAssoc(1, 2),
    ];
    const result = computeClusters(knowledge, associations);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds).toEqual([1, 2]);
  });

  it('topFacts are sorted by degree descending', () => {
    // Star graph: node 1 connected to 2, 3, 4
    const knowledge = [makeKM(1, 'hub'), makeKM(2, 'spoke1'), makeKM(3, 'spoke2'), makeKM(4, 'spoke3')];
    const associations = [
      makeAssoc(1, 2),
      makeAssoc(1, 3),
      makeAssoc(1, 4),
    ];
    const result = computeClusters(knowledge, associations);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].topFacts[0].id).toBe(1);
    expect(result.clusters[0].topFacts[0].degree).toBe(3);
  });
});

describe('formatClustersAsSection', () => {
  it('returns null when no clusters', () => {
    const result = formatClustersAsSection({ clusters: [], interClusterRelationships: [] });
    expect(result).toBeNull();
  });

  it('formats clusters as a GraphReportSection', () => {
    const result = formatClustersAsSection({
      clusters: [
        {
          clusterId: 0,
          memberIds: [1, 2, 3],
          topFacts: [
            { id: 1, fact: 'The system uses TypeScript', degree: 3 },
            { id: 2, fact: 'The system uses vitest', degree: 2 },
          ],
          cohesion: 0.67,
          internalEdges: 2,
        },
      ],
      interClusterRelationships: [],
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Knowledge Clusters');
    expect(result!.content).toContain('Cluster 0');
    expect(result!.content).toContain('3 facts');
    expect(result!.content).toContain('0.67');
    expect(result!.priority).toBe(8);
  });

  it('includes inter-cluster bridge info', () => {
    const result = formatClustersAsSection({
      clusters: [
        { clusterId: 0, memberIds: [1, 2], topFacts: [{ id: 1, fact: 'A', degree: 1 }], cohesion: 1.0, internalEdges: 1 },
        { clusterId: 1, memberIds: [3, 4], topFacts: [{ id: 3, fact: 'B', degree: 1 }], cohesion: 1.0, internalEdges: 1 },
      ],
      interClusterRelationships: [
        { clusterA: 0, clusterB: 1, edgeCount: 2, types: ['supports', 'related_to'] },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Bridges');
    expect(result!.content).toContain('Cluster 0 ↔ Cluster 1');
    expect(result!.content).toContain('2 edge(s)');
  });
});

describe('expandFromClusters', () => {
  it('returns related IDs from the same cluster as seeds', () => {
    const knowledge = [makeKM(1, 'A'), makeKM(2, 'B'), makeKM(3, 'C'), makeKM(4, 'D')];
    const associations = [
      makeAssoc(1, 2),
      makeAssoc(2, 3),
      // 4 is isolated
    ];
    const result = computeClusters(knowledge, associations);
    const expanded = expandFromClusters([1], result);
    // Should include 2 and 3 (same cluster), but not 4 (isolated/different cluster)
    expect(expanded).toContain(2);
    expect(expanded).toContain(3);
    expect(expanded).not.toContain(1); // seed excluded
    expect(expanded).not.toContain(4);
  });

  it('returns empty array when seeds are not in any cluster', () => {
    const knowledge = [makeKM(1, 'A'), makeKM(2, 'B')];
    const associations = [makeAssoc(1, 2)];
    const result = computeClusters(knowledge, associations);
    const expanded = expandFromClusters([99], result);
    expect(expanded).toEqual([]);
  });

  it('respects maxExpansion limit', () => {
    const knowledge = [];
    const associations = [];
    for (let i = 1; i <= 20; i++) {
      knowledge.push(makeKM(i, `Fact ${i}`));
      if (i > 1) associations.push(makeAssoc(1, i));
    }
    const result = computeClusters(knowledge, associations);
    const expanded = expandFromClusters([1], result, 5);
    expect(expanded.length).toBeLessThanOrEqual(5);
  });
});

describe('determinism', () => {
  it('produces identical results across multiple runs', () => {
    const knowledge = [makeKM(1, 'A'), makeKM(2, 'B'), makeKM(3, 'C'), makeKM(4, 'D'), makeKM(5, 'E')];
    const associations = [
      makeAssoc(1, 2), makeAssoc(2, 3),
      makeAssoc(4, 5),
    ];

    const run1 = computeClusters(knowledge, associations);
    const run2 = computeClusters(knowledge, associations);
    expect(run1.clusters.map((c) => c.memberIds)).toEqual(run2.clusters.map((c) => c.memberIds));
    expect(run1.clusters.map((c) => c.cohesion)).toEqual(run2.clusters.map((c) => c.cohesion));
  });
});

describe('graph-report integration', () => {
  it('includes clusters as an optional section in graph report', async () => {
    const adapter = createInMemoryAdapter();
    const scope = { tenant_id: 'test', system_id: 'test', scope_id: 'cluster-gr' };
    const now = Math.floor(Date.now() / 1000);

    // Create a small cluster
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Cluster fact 1', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Cluster fact 2', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'related_to', confidence: 0.7, auto_generated: true,
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['clusters'] });
    const section = report.sections.find((s) => s.title === 'Knowledge Clusters');
    expect(section).toBeDefined();
    expect(section!.content).toContain('Cluster');
    expect(section!.content).toContain('cohesion');
  });
});
