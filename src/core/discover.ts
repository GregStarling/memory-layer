import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  DiscoverOptions,
  DiscoveryReport,
  SurpriseResult,
  BridgeType,
  GraphStats,
} from '../contracts/discovery.js';
import { DISCOVER_DEFAULTS } from '../contracts/discovery.js';
import type { Association, KnowledgeMemory } from '../contracts/types.js';

/**
 * Analyse the association graph for a scope and surface surprising
 * cross-memory connections using betweenness centrality, cross-class
 * bridge detection, and composite surprise scoring.
 *
 * This is a read-only analysis — no mutations to knowledge or associations.
 */
export async function discover(
  adapter: StorageAdapter,
  scope: MemoryScope,
  options: DiscoverOptions = {},
): Promise<DiscoveryReport> {
  const maxResults = options.maxResults ?? DISCOVER_DEFAULTS.maxResults;
  const minSurpriseScore = options.minSurpriseScore ?? DISCOVER_DEFAULTS.minSurpriseScore;
  const rawMaxDepth = options.maxDepth ?? DISCOVER_DEFAULTS.maxDepth;
  const maxDepth = Number.isFinite(rawMaxDepth) && rawMaxDepth >= 0
    ? Math.floor(rawMaxDepth)
    : DISCOVER_DEFAULTS.maxDepth;

  const associations = adapter.listAssociations(scope);
  const knowledge = adapter.getActiveKnowledgeMemory(scope);

  const knowledgeById = new Map<number, KnowledgeMemory>();
  for (const k of knowledge) {
    knowledgeById.set(k.id, k);
  }

  // Build adjacency list from associations
  const adjacency = buildAdjacency(associations);
  const nodeKeys = [...adjacency.keys()];

  const graphStats: GraphStats = {
    totalNodes: nodeKeys.length,
    totalEdges: associations.length,
    avgDegree: nodeKeys.length > 0 ? (2 * associations.length) / nodeKeys.length : 0,
  };

  if (associations.length === 0) {
    return { surprises: [], graphStats, timestamp: Date.now() };
  }

  // Compute betweenness centrality for all nodes (bounded by maxDepth)
  const centrality = computeBetweennessCentrality(adjacency, nodeKeys, maxDepth);

  // Score each association edge as a potential surprise
  const scored: SurpriseResult[] = [];

  for (const edge of associations) {
    const sourceKey = `${edge.source_kind}:${edge.source_id}`;
    const targetKey = `${edge.target_kind}:${edge.target_id}`;

    const sourceKnowledge =
      edge.source_kind === 'knowledge' ? knowledgeById.get(edge.source_id) : undefined;
    const targetKnowledge =
      edge.target_kind === 'knowledge' ? knowledgeById.get(edge.target_id) : undefined;

    const score = computeSurpriseScore(
      edge,
      sourceKey,
      targetKey,
      centrality,
      sourceKnowledge,
      targetKnowledge,
      adjacency,
    );

    if (score < minSurpriseScore) continue;

    const bridgeType = classifyBridge(edge, sourceKnowledge, targetKnowledge);
    const explanation = generateExplanation(
      edge,
      bridgeType,
      score,
      sourceKnowledge,
      targetKnowledge,
      centrality.get(sourceKey) ?? 0,
      centrality.get(targetKey) ?? 0,
    );

    scored.push({
      sourceId: sourceKey,
      targetId: targetKey,
      score,
      explanation,
      bridgeType,
    });
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const surprises = scored.slice(0, maxResults);

  return { surprises, graphStats, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Adjacency
// ---------------------------------------------------------------------------

type AdjacencyMap = Map<string, Set<string>>;

function buildAdjacency(associations: Association[]): AdjacencyMap {
  const adj: AdjacencyMap = new Map();
  const ensure = (key: string) => {
    if (!adj.has(key)) adj.set(key, new Set());
  };

  for (const edge of associations) {
    const sk = `${edge.source_kind}:${edge.source_id}`;
    const tk = `${edge.target_kind}:${edge.target_id}`;
    ensure(sk);
    ensure(tk);
    adj.get(sk)!.add(tk);
    adj.get(tk)!.add(sk);
  }

  return adj;
}

// ---------------------------------------------------------------------------
// Betweenness centrality (Brandes algorithm, unweighted)
// ---------------------------------------------------------------------------

function computeBetweennessCentrality(
  adjacency: AdjacencyMap,
  nodeKeys: string[],
  maxDepth: number = Infinity,
): Map<string, number> {
  const cb = new Map<string, number>();
  for (const key of nodeKeys) cb.set(key, 0);

  for (const s of nodeKeys) {
    // Single-source shortest paths via BFS
    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const v of nodeKeys) {
      pred.set(v, []);
      sigma.set(v, 0);
      dist.set(v, -1);
      delta.set(v, 0);
    }

    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: string[] = [s];

    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);
      const dv = dist.get(v)!;
      // Bound traversal depth
      if (dv >= maxDepth) continue;
      const neighbors = adjacency.get(v) ?? new Set();

      for (const w of neighbors) {
        // w found for the first time?
        if (dist.get(w) === -1) {
          dist.set(w, dv + 1);
          queue.push(w);
        }
        // Shortest path to w via v?
        if (dist.get(w) === dv + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }

    // Back-propagation of dependencies
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        const contribution = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contribution);
      }
      if (w !== s) {
        cb.set(w, cb.get(w)! + delta.get(w)!);
      }
    }
  }

  // Normalize: for undirected graphs divide by 2
  const n = nodeKeys.length;
  const normFactor = n > 2 ? (n - 1) * (n - 2) : 1;
  for (const [key, val] of cb) {
    cb.set(key, val / (2 * normFactor));
  }

  return cb;
}

// ---------------------------------------------------------------------------
// Surprise scoring
// ---------------------------------------------------------------------------

function computeSurpriseScore(
  edge: Association,
  sourceKey: string,
  targetKey: string,
  centrality: Map<string, number>,
  sourceKnowledge: KnowledgeMemory | undefined,
  targetKnowledge: KnowledgeMemory | undefined,
  adjacency: AdjacencyMap,
): number {
  let score = 0;

  // Cross-class bonus (0.3): edges connecting different knowledge_class groups
  if (
    sourceKnowledge &&
    targetKnowledge &&
    sourceKnowledge.knowledge_class !== targetKnowledge.knowledge_class
  ) {
    score += 0.3;
  }

  // Cross-scope bonus (0.15): edges connecting different scope_ids
  if (edge.source_kind !== edge.target_kind) {
    score += 0.1;
  }

  // Betweenness centrality bonus (0.25): high centrality endpoints are bridges
  const sourceCentrality = centrality.get(sourceKey) ?? 0;
  const targetCentrality = centrality.get(targetKey) ?? 0;
  const maxCentrality = Math.max(sourceCentrality, targetCentrality);
  score += Math.min(maxCentrality, 1) * 0.25;

  // Low-to-high-degree bonus (0.15): edges connecting low-degree to high-degree nodes
  const sourceDegree = adjacency.get(sourceKey)?.size ?? 0;
  const targetDegree = adjacency.get(targetKey)?.size ?? 0;
  if (sourceDegree > 0 && targetDegree > 0) {
    const degreeRatio = Math.min(sourceDegree, targetDegree) / Math.max(sourceDegree, targetDegree);
    score += (1 - degreeRatio) * 0.15;
  }

  // Weak-confidence bonus (0.15): low-confidence associations are more surprising
  score += (1 - edge.confidence) * 0.15;

  // Contradiction bonus (0.15): contradictions are inherently surprising
  if (edge.association_type === 'contradicts') {
    score += 0.15;
  }

  return Math.min(score, 1);
}

// ---------------------------------------------------------------------------
// Bridge classification
// ---------------------------------------------------------------------------

function classifyBridge(
  edge: Association,
  sourceKnowledge: KnowledgeMemory | undefined,
  targetKnowledge: KnowledgeMemory | undefined,
): BridgeType {
  if (edge.association_type === 'contradicts') {
    return 'contradiction';
  }

  if (edge.association_type === 'supersedes' || edge.association_type === 'derived_from') {
    return 'causal';
  }

  if (sourceKnowledge && targetKnowledge) {
    // Shared subject indicates entity bridge
    if (
      sourceKnowledge.fact_subject &&
      targetKnowledge.fact_subject &&
      sourceKnowledge.fact_subject === targetKnowledge.fact_subject
    ) {
      return 'entity_shared';
    }

    // Temporal proximity: created within 60 seconds of each other
    const timeDelta = Math.abs(sourceKnowledge.created_at - targetKnowledge.created_at);
    if (timeDelta < 60) {
      return 'temporal_proximity';
    }
  }

  return 'semantic_overlap';
}

// ---------------------------------------------------------------------------
// Explanation generation
// ---------------------------------------------------------------------------

function generateExplanation(
  edge: Association,
  bridgeType: BridgeType,
  score: number,
  sourceKnowledge: KnowledgeMemory | undefined,
  targetKnowledge: KnowledgeMemory | undefined,
  sourceCentrality: number,
  targetCentrality: number,
): string {
  const parts: string[] = [];

  const sourceLabel = sourceKnowledge
    ? truncate(sourceKnowledge.fact, 60)
    : `${edge.source_kind}:${edge.source_id}`;
  const targetLabel = targetKnowledge
    ? truncate(targetKnowledge.fact, 60)
    : `${edge.target_kind}:${edge.target_id}`;

  switch (bridgeType) {
    case 'contradiction':
      parts.push(`Contradiction between "${sourceLabel}" and "${targetLabel}".`);
      break;
    case 'causal':
      parts.push(`Causal link: "${sourceLabel}" ${edge.association_type} "${targetLabel}".`);
      break;
    case 'entity_shared':
      parts.push(
        `Shared entity "${sourceKnowledge!.fact_subject}" connects "${sourceLabel}" and "${targetLabel}".`,
      );
      break;
    case 'temporal_proximity':
      parts.push(
        `Temporally proximate memories: "${sourceLabel}" and "${targetLabel}".`,
      );
      break;
    case 'semantic_overlap':
      parts.push(`Semantic overlap between "${sourceLabel}" and "${targetLabel}".`);
      break;
  }

  if (
    sourceKnowledge &&
    targetKnowledge &&
    sourceKnowledge.knowledge_class !== targetKnowledge.knowledge_class
  ) {
    parts.push(
      `Bridges ${sourceKnowledge.knowledge_class} and ${targetKnowledge.knowledge_class} classes.`,
    );
  }

  const maxCentrality = Math.max(sourceCentrality, targetCentrality);
  if (maxCentrality > 0.1) {
    parts.push('High-centrality bridge node in the knowledge graph.');
  }

  if (edge.confidence < 0.5) {
    parts.push(`Low confidence (${edge.confidence.toFixed(2)}) adds uncertainty.`);
  }

  return parts.join(' ');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
