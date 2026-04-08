import type { NormalizedMemoryScope } from './identity.js';

/**
 * Options for cross-memory surprise discovery.
 */
export interface DiscoverOptions {
  /** Scope filters to narrow the discovery search space. */
  scope?: NormalizedMemoryScope[];
  /** Maximum number of surprise results to return. */
  maxResults?: number;
  /** Minimum surprise score threshold (0-1). */
  minSurpriseScore?: number;
  /** Maximum graph traversal depth for centrality computation. */
  maxDepth?: number;
}

export const DISCOVER_DEFAULTS = {
  maxResults: 10,
  minSurpriseScore: 0,
  maxDepth: 10,
} as const;

/**
 * The type of bridge that connects two surprising memories.
 */
export type BridgeType =
  | 'semantic_overlap'
  | 'temporal_proximity'
  | 'entity_shared'
  | 'contradiction'
  | 'causal';

/**
 * A single surprising connection between two memories.
 */
export interface SurpriseResult {
  /** ID of the source memory node. */
  sourceId: string;
  /** ID of the target memory node. */
  targetId: string;
  /** Surprise score (0-1). */
  score: number;
  /** Human-readable explanation of why this connection is surprising. */
  explanation: string;
  /** The type of bridge linking source and target. */
  bridgeType: BridgeType;
}

/**
 * Summary statistics about the memory graph at discovery time.
 */
export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  avgDegree: number;
}

/**
 * Full discovery report returned by the surprise-discovery engine.
 */
export interface DiscoveryReport {
  /** Surprising connections found. */
  surprises: SurpriseResult[];
  /** Summary statistics for the memory graph. */
  graphStats: GraphStats;
  /** Epoch-ms timestamp of when this report was generated. */
  timestamp: number;
}
