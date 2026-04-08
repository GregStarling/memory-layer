import type { KnowledgeClass, KnowledgeMemory } from './types.js';
import type { MemoryScope } from './identity.js';

export interface TemporalQueryOptions {
  /** Point-in-time to query, as epoch seconds. */
  timestamp: number;
  /** Scope to restrict the temporal query. */
  scope: MemoryScope;
  /** Optional knowledge class filter. */
  knowledgeClass?: KnowledgeClass;
  /** Whether to fall back to event replay when no snapshot is available. */
  fallbackToReplay: boolean;
}

export interface FactsAtResult {
  /** The facts that were active at the queried timestamp. */
  facts: KnowledgeMemory[];
  /** The timestamp that was queried, as epoch seconds. */
  queryTimestamp: number;
  /** Whether the result was served from a snapshot (fast path) or via replay. */
  usedFastPath: boolean;
}
