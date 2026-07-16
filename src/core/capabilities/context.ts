import type { MemoryScope } from '../../contracts/identity.js';
import type { EventHook } from '../../contracts/observability.js';
import type { HandoffRecord, WorkClaim } from '../../contracts/coordination.js';
import type {
  Association,
  KnowledgeMemory,
  Playbook,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';
import type { Profile } from '../../contracts/profile.js';
import type { MemoryEventRecord, TemporalId, TemporalIdInput } from '../../contracts/temporal.js';
import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { TokenEstimator } from '../tokens.js';
import type { CircuitBreaker } from '../circuit-breaker.js';
import type { MemoryContext } from '../context.js';
import type { SessionBootstrap } from '../formatter.js';
import type { normalizeReplayedTemporalState } from '../temporal.js';
import type { MemoryManagerConfig } from '../manager-config.js';
import type {
  ContextQueryOptions,
  KnowledgeChangeResult,
} from '../manager-types.js';

/**
 * The explicit context object each capability namespace factory receives
 * (Phase 6.2). Capability modules destructure exactly the members they need
 * from this object; they never reach back into the MemoryManager factory's
 * closure. This makes each capability independently constructible (and
 * testable) with just a storage adapter plus the internal services it uses.
 */

/** Fully-replayed temporal state as produced by the temporal fold. */
export type ReplayedTemporalState = ReturnType<typeof normalizeReplayedTemporalState>;

/** The bounded slice of temporal state used to assemble historical context. */
export interface TemporalContextState {
  turns: Turn[];
  workingMemory: WorkingMemory[];
  knowledge: KnowledgeMemory[];
  workItems: WorkItem[];
  workClaims: WorkClaim[];
  handoffs: HandoffRecord[];
  associations: Association[];
  playbooks: Playbook[];
}

/** Result of a point-in-time context replay. */
export interface ReplayedContextResult {
  context: MemoryContext;
  events: MemoryEventRecord[];
  state: ReplayedTemporalState | null;
  watermarkEventId: TemporalId | null;
  exact: boolean;
  cutoverAt: number | null;
}

export interface CircuitBreakers {
  summarizer: CircuitBreaker;
  extractor: CircuitBreaker;
  embeddings: CircuitBreaker;
}

/**
 * Shared runtime surface the MemoryManager exposes to its capability
 * namespaces. The base members (adapter/config/onEvent) plus the internal
 * service functions the manager builds around them.
 */
export interface CapabilityContext {
  asyncAdapter: AsyncStorageAdapter;
  config: MemoryManagerConfig;
  onEvent: EventHook;
  tokenEstimator: TokenEstimator;
  circuitBreakers: CircuitBreakers;
  activeEmbeddingModel: string;

  // Shared internal services (defined as closures inside the manager factory).
  emitKnowledgeChange(
    action: 'learned' | 'promoted' | 'reverified' | 'demoted' | 'retired',
    knowledge: KnowledgeMemory,
  ): void;
  emitDegradation(
    kind: 'summarizer' | 'extractor' | 'embeddings',
    detail: Record<string, unknown>,
  ): void;
  maybeEmbedKnowledge(knowledge: KnowledgeMemory[]): Promise<void>;
  refreshSessionStateProjection(): Promise<void>;
  getContextInternal(
    relevanceQuery?: string,
    asOf?: number,
    options?: ContextQueryOptions,
  ): Promise<MemoryContext>;
  buildReplayedContext(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
    replayCutoff?: { throughEventId?: TemporalId | null },
  ): Promise<ReplayedContextResult>;
  collectKnowledgeForProfile(
    adapter: AsyncStorageAdapter,
    options?: ContextQueryOptions,
    asOf?: number,
  ): Promise<KnowledgeMemory[]>;
  buildSessionBootstrapPayload(context: MemoryContext, profile: Profile): SessionBootstrap;
  filterTemporalStateForContext(
    state: TemporalContextState,
    options?: ContextQueryOptions,
  ): TemporalContextState;
  collectBestEffortTemporalState(
    asOf: number,
    options?: ContextQueryOptions,
  ): Promise<TemporalContextState>;
  getTemporalCutoverAt(): Promise<number | null>;
  resolveChangeStreamCursorInternal(cursor?: TemporalIdInput): Promise<TemporalId>;
  listKnowledgeChangesInternal(options?: {
    cursor?: TemporalIdInput;
    since?: Date;
    scopeLevel?: import('../../contracts/identity.js').ScopeLevel;
    limit?: number;
  }): Promise<KnowledgeChangeResult>;
}

/** Convenience: the manager scope reference. */
export type { MemoryScope };
