import type { ActorRef, ContextViewPolicy } from '../contracts/coordination.js';
import type {
  ContextContractReference,
  ContextInvariant,
} from '../contracts/context-contract.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { MemoryEventRecord, TemporalId } from '../contracts/temporal.js';

/**
 * Shared facade option/result types used by the MemoryManager and its
 * capability namespaces. Extracted into a neutral module so both
 * `src/core/manager.ts` and `src/core/capabilities/**` can import them
 * without introducing a type-only import cycle (Phase 6.2).
 */
export interface ContextQueryOptions {
  view?: ContextViewPolicy;
  viewer?: ActorRef;
  includeCoordinationState?: boolean;
  contract?: ContextContractReference;
  invariants?: ContextInvariant[];
}

export interface ContextExpansionOptions {
  currentContract?: ContextContractReference;
}

export interface KnowledgeChangeRecord {
  event_id: TemporalId;
  event_type: MemoryEventRecord['event_type'];
  created_at: number;
  knowledge: KnowledgeMemory;
}

export interface KnowledgeChangeResult {
  changes: KnowledgeChangeRecord[];
  nextCursor: TemporalId;
}
