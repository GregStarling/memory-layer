import type { Association, KnowledgeMemory } from '../contracts/types.js';
import type { GraphReportSection } from '../contracts/graph-report.js';

/**
 * A cluster of related knowledge facts, identified by community detection.
 */
export interface KnowledgeCluster {
  /** Opaque cluster identifier (not persisted, computed per pass). */
  clusterId: number;
  /** Knowledge fact IDs in this cluster. */
  memberIds: number[];
  /** Top facts by degree within the cluster (limited for readability). */
  topFacts: Array<{ id: number; fact: string; degree: number }>;
  /** Cohesion score: ratio of intra-cluster edges to total possible edges (0..1). */
  cohesion: number;
  /** Number of edges within the cluster. */
  internalEdges: number;
}

/**
 * Relationships between clusters.
 */
export interface InterClusterRelationship {
  clusterA: number;
  clusterB: number;
  /** Number of edges connecting the two clusters. */
  edgeCount: number;
  /** Association types on those edges. */
  types: string[];
}

export interface ClusterResult {
  clusters: KnowledgeCluster[];
  interClusterRelationships: InterClusterRelationship[];
}

/**
 * Build an adjacency list from associations, restricted to knowledge-to-knowledge edges.
 */
function buildAdjacency(
  associations: Association[],
  knowledgeIds: Set<number>,
): Map<number, Map<number, string[]>> {
  const adj = new Map<number, Map<number, string[]>>();

  const ensureNode = (id: number) => {
    if (!adj.has(id)) adj.set(id, new Map());
  };

  for (const a of associations) {
    if (a.source_kind !== 'knowledge' || a.target_kind !== 'knowledge') continue;
    if (!knowledgeIds.has(a.source_id) || !knowledgeIds.has(a.target_id)) continue;
    if (a.source_id === a.target_id) continue;

    ensureNode(a.source_id);
    ensureNode(a.target_id);

    const srcNeighbors = adj.get(a.source_id)!;
    const tgtNeighbors = adj.get(a.target_id)!;

    if (!srcNeighbors.has(a.target_id)) srcNeighbors.set(a.target_id, []);
    srcNeighbors.get(a.target_id)!.push(a.association_type);

    if (!tgtNeighbors.has(a.source_id)) tgtNeighbors.set(a.source_id, []);
    tgtNeighbors.get(a.source_id)!.push(a.association_type);
  }

  return adj;
}

/**
 * Label propagation community detection.
 *
 * Each node starts with its own label. In each iteration, each node adopts
 * the most frequent label among its neighbors (ties broken by smallest label).
 * Converges when no labels change, or after maxIterations.
 */
function labelPropagation(
  adj: Map<number, Map<number, string[]>>,
  maxIterations = 20,
): Map<number, number> {
  const labels = new Map<number, number>();
  const nodes = [...adj.keys()];

  // Initialize: each node is its own label
  for (const node of nodes) {
    labels.set(node, node);
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Deterministic shuffle using iteration-seeded permutation so identical
    // graphs always yield the same cluster assignments.
    const seed = iter * 2654435761; // Knuth multiplicative hash
    for (let i = nodes.length - 1; i > 0; i--) {
      const j = Math.abs((seed + i * 2246822519) | 0) % (i + 1);
      [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
    }

    for (const node of nodes) {
      const neighbors = adj.get(node);
      if (!neighbors || neighbors.size === 0) continue;

      // Count neighbor labels
      const labelCounts = new Map<number, number>();
      for (const [neighbor] of neighbors) {
        const neighborLabel = labels.get(neighbor)!;
        labelCounts.set(neighborLabel, (labelCounts.get(neighborLabel) ?? 0) + 1);
      }

      // Find max count, break ties by smallest label
      let bestLabel = labels.get(node)!;
      let bestCount = 0;
      for (const [label, count] of labelCounts) {
        if (count > bestCount || (count === bestCount && label < bestLabel)) {
          bestLabel = label;
          bestCount = count;
        }
      }

      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

/**
 * Compute clusters over the knowledge association graph using label propagation.
 * Clusters are ephemeral — computed on each pass, not persisted.
 */
export function computeClusters(
  knowledge: KnowledgeMemory[],
  associations: Association[],
  options: { maxTopFacts?: number; minClusterSize?: number } = {},
): ClusterResult {
  const maxTopFacts = options.maxTopFacts ?? 5;
  const minClusterSize = options.minClusterSize ?? 2;

  const knowledgeIds = new Set(knowledge.map((k) => k.id));
  const knowledgeById = new Map(knowledge.map((k) => [k.id, k]));
  const adj = buildAdjacency(associations, knowledgeIds);

  // Run label propagation
  const labels = labelPropagation(adj);

  // Group nodes by label
  const clusterMembers = new Map<number, number[]>();
  for (const [nodeId, label] of labels) {
    if (!clusterMembers.has(label)) clusterMembers.set(label, []);
    clusterMembers.get(label)!.push(nodeId);
  }

  // Build clusters, filtering by minimum size
  const clusters: KnowledgeCluster[] = [];
  let nextClusterId = 0;
  const nodeToClusterId = new Map<number, number>();

  for (const [, members] of clusterMembers) {
    if (members.length < minClusterSize) continue;

    const clusterId = nextClusterId++;
    for (const m of members) {
      nodeToClusterId.set(m, clusterId);
    }

    // Compute degree within cluster
    const memberSet = new Set(members);
    const degrees = new Map<number, number>();
    let internalEdges = 0;

    for (const m of members) {
      const neighbors = adj.get(m);
      if (!neighbors) continue;
      let deg = 0;
      for (const [neighbor] of neighbors) {
        if (memberSet.has(neighbor)) {
          deg++;
          internalEdges++;
        }
      }
      degrees.set(m, deg);
    }
    // Each edge counted twice (once from each end)
    internalEdges = Math.floor(internalEdges / 2);

    // Top facts by degree
    const topFacts = members
      .map((id) => ({
        id,
        fact: knowledgeById.get(id)?.fact ?? '',
        degree: degrees.get(id) ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, maxTopFacts);

    // Cohesion: ratio of actual internal edges to maximum possible
    const maxPossibleEdges = (members.length * (members.length - 1)) / 2;
    const cohesion = maxPossibleEdges > 0 ? internalEdges / maxPossibleEdges : 0;

    clusters.push({
      clusterId,
      memberIds: members.sort((a, b) => a - b),
      topFacts,
      cohesion,
      internalEdges,
    });
  }

  // Sort clusters by size descending
  clusters.sort((a, b) => b.memberIds.length - a.memberIds.length);

  // Compute inter-cluster relationships
  const interClusterRelationships: InterClusterRelationship[] = [];
  const interClusterEdges = new Map<string, { count: number; types: Set<string> }>();

  for (const a of associations) {
    if (a.source_kind !== 'knowledge' || a.target_kind !== 'knowledge') continue;
    const clA = nodeToClusterId.get(a.source_id);
    const clB = nodeToClusterId.get(a.target_id);
    if (clA == null || clB == null || clA === clB) continue;

    const key = clA < clB ? `${clA}:${clB}` : `${clB}:${clA}`;
    if (!interClusterEdges.has(key)) {
      interClusterEdges.set(key, { count: 0, types: new Set() });
    }
    const entry = interClusterEdges.get(key)!;
    entry.count++;
    entry.types.add(a.association_type);
  }

  for (const [key, value] of interClusterEdges) {
    const [a, b] = key.split(':').map(Number);
    interClusterRelationships.push({
      clusterA: a,
      clusterB: b,
      edgeCount: value.count,
      types: [...value.types],
    });
  }

  interClusterRelationships.sort((a, b) => b.edgeCount - a.edgeCount);

  return { clusters, interClusterRelationships };
}

/**
 * Format cluster results as a GraphReportSection for inclusion in graph reports.
 */
export function formatClustersAsSection(result: ClusterResult): GraphReportSection | null {
  if (result.clusters.length === 0) return null;

  const lines: string[] = [];

  for (const cluster of result.clusters.slice(0, 5)) {
    const topFactLabels = cluster.topFacts
      .slice(0, 3)
      .map((f) => truncate(f.fact, 60))
      .join('; ');
    lines.push(
      `- **Cluster ${cluster.clusterId}** (${cluster.memberIds.length} facts, cohesion ${cluster.cohesion.toFixed(2)}): ${topFactLabels}`,
    );
  }

  if (result.interClusterRelationships.length > 0) {
    lines.push('');
    lines.push('**Bridges:**');
    for (const rel of result.interClusterRelationships.slice(0, 3)) {
      lines.push(
        `- Cluster ${rel.clusterA} ↔ Cluster ${rel.clusterB}: ${rel.edgeCount} edge(s) [${rel.types.join(', ')}]`,
      );
    }
  }

  return {
    title: 'Knowledge Clusters',
    content: lines.join('\n'),
    priority: 8,
  };
}

/**
 * Given a set of seed knowledge IDs and cluster results, return related
 * IDs from the same clusters. Useful for retrieval expansion — facts in
 * the same cluster are topically related.
 */
export function expandFromClusters(
  seedIds: number[],
  clusterResult: ClusterResult,
  maxExpansion = 10,
): number[] {
  const seedSet = new Set(seedIds);
  const expanded = new Set<number>();

  for (const cluster of clusterResult.clusters) {
    const hasOverlap = cluster.memberIds.some((id) => seedSet.has(id));
    if (!hasOverlap) continue;
    for (const id of cluster.memberIds) {
      if (!seedSet.has(id)) {
        expanded.add(id);
      }
    }
  }

  return [...expanded].slice(0, maxExpansion);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
