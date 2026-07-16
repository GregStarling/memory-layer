import type { AliasMap } from '../contracts/aliases.js';
import type { OntologyConfig } from '../contracts/ontology.js';
import type {
  EmbeddingAdapter,
  EmbeddingGenerator,
} from '../contracts/embedding.js';
import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MaintenancePolicy,
  MonitorPolicy,
} from '../contracts/policy.js';
import type {
  ContextContract,
  ContextInvariant,
  ContextEscalationPolicy,
} from '../contracts/context-contract.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryEventEmitter } from './events.js';
import type { Extractor } from './extractor.js';
import type { Summarizer } from './orchestrator.js';
import type { TokenEstimator } from './tokens.js';
import type { CircuitBreakerOptions } from './circuit-breaker.js';
import type { StructuredGenerationClient } from '../contracts/generation-client.js';

/**
 * Configuration for {@link createMemoryManager}. Extracted into a neutral
 * module (Phase 6.2) so the capability namespace modules can depend on the
 * config shape without importing `src/core/manager.ts` (which would create a
 * type-only import cycle). Re-exported from `manager.ts` for barrel stability.
 */
export interface MemoryManagerConfig {
  /** Synchronous storage adapter (SQLite, in-memory). Mutually exclusive with asyncAdapter. */
  adapter?: StorageAdapter;
  /** Async storage adapter (PostgreSQL, remote). Mutually exclusive with adapter. */
  asyncAdapter?: AsyncStorageAdapter;
  scope: MemoryScope;
  sessionId: string;
  summarizer: Summarizer;
  extractor?: Extractor;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingGenerator?: EmbeddingGenerator;
  /**
   * Identifier of the active embedding model (Phase 2.4). Stored alongside each
   * vector so mismatched vectors are excluded from similarity search in the
   * storage layer before any distance comparison. Defaults to `'unknown'`.
   */
  embeddingModel?: string;
  logger?: Logger;
  onEvent?: EventHook;
  eventEmitter?: MemoryEventEmitter;
  monitorPolicy?: MonitorPolicy;
  extractionPolicy?: ExtractionPolicy;
  contextPolicy?: ContextPolicy;
  maintenancePolicy?: MaintenancePolicy;
  crossScopeLevel?: ScopeLevel;
  contextContract?: ContextContract;
  contextContracts?: Record<string, ContextContract>;
  invariants?: ContextInvariant[];
  escalationPolicy?: ContextEscalationPolicy;
  tokenEstimator?: TokenEstimator;
  autoCompact?: boolean;
  autoExtract?: boolean;
  failurePolicy?: {
    summarizer?: 'throw' | 'retry_once' | 'log_and_continue';
    extractor?: 'throw' | 'retry_once' | 'log_and_continue' | 'disable_auto_extract';
  };
  circuitBreaker?: {
    summarizer?: CircuitBreakerOptions;
    extractor?: CircuitBreakerOptions;
    embeddings?: CircuitBreakerOptions;
  };
  redactText?: (input: { kind: 'turn' | 'fact' | 'work_item'; text: string }) => string;
  structuredClient?: StructuredGenerationClient;
  closeAdapter?: boolean;
  aliasMap?: AliasMap;
  ontology?: OntologyConfig;
}
