import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import type { EmbeddingAdapter, EmbeddingGenerator } from '../contracts/embedding.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MaintenancePolicy,
  MonitorPolicy,
} from '../contracts/policy.js';
import {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_EXTRACTION_POLICY,
  DEFAULT_MAINTENANCE_POLICY,
  DEFAULT_MONITOR_POLICY,
} from '../contracts/policy.js';
import type {
  ContextContract,
  ContextInvariant,
  ContextEscalationPolicy,
} from '../contracts/context-contract.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { createInMemoryAdapter, createInMemoryAdapterWithEmbeddings } from '../adapters/memory/index.js';
import { createSQLiteAdapter, createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createLocalEmbeddingGenerator } from '../embeddings/local.js';
import { createOpenAIEmbeddingGenerator } from '../embeddings/openai.js';
import { createVoyageEmbeddingGenerator } from '../embeddings/voyage.js';
import {
  createCompositeExtractor,
  createHeuristicExtractor,
  createRegexExtractor,
  type Extractor,
} from '../core/extractor.js';
import {
  createMemoryManager,
  type MemoryManager,
  type MemoryManagerConfig,
} from '../core/manager.js';
import { resolveMemoryManagerPreset, type MemoryManagerPreset } from './presets.js';
import { createSessionId, type TokenEstimator } from '../core/tokens.js';
import { type StructuredGenerationClient } from '../contracts/generation-client.js';
import { createClaudeSummarizer } from '../summarizers/claude.js';
import { createExtractiveSummarizer } from '../summarizers/extractive.js';
import { createOpenAISummarizer } from '../summarizers/openai.js';
import { createClaudeExtractor, createOpenAIExtractor } from '../summarizers/extractor.js';
import type { Summarizer } from '../core/orchestrator.js';
import { emitMemoryEvent } from '../core/telemetry.js';
import { detectWorkspace } from '../core/workspace-detect.js';

type QuickAdapterOption = 'sqlite' | 'memory' | StorageAdapter;
type QuickSummarizerOption = 'claude' | 'openai' | 'extractive' | Summarizer;
type QuickExtractorOption = 'claude' | 'openai' | 'regex' | 'heuristic' | Extractor | false;
type QuickEmbeddingOption = 'local' | EmbeddingGenerator | false;
export type MemoryQualityTier = 'offline_default' | 'local_semantic' | 'provider_backed';
export type MemoryQualityMode =
  | 'fast_adoption'
  | 'balanced_memory'
  | 'high_fidelity_memory';

interface QuickProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  prompt?: string;
  client?: StructuredGenerationClient;
}

export interface CreateMemoryOptions {
  adapter?: QuickAdapterOption;
  path?: string | ':memory:';
  scope?: string | MemoryScope;
  sessionId?: string;
  preset?: MemoryManagerPreset;
  summarizer?: QuickSummarizerOption;
  /**
   * Named quality profile — the canonical way to select memory fidelity
   * (Phase 6.5). One of `fast_adoption` | `balanced_memory` | `high_fidelity_memory`.
   */
  qualityMode?: MemoryQualityMode;
  /**
   * @deprecated Use {@link CreateMemoryOptions.qualityMode} instead (Phase 6.5).
   * The legacy `qualityTier` conflated fidelity with the storage/embedding
   * capability tier. It is still accepted this major and mapped onto the
   * equivalent `qualityMode` named profile (see {@link resolveQualityMode}),
   * and still steers the local-embedding fallback; a one-time console warning
   * is emitted on use. Removed in 6.0.0.
   */
  qualityTier?: MemoryQualityTier;
  summarizerOptions?: QuickProviderOptions;
  extractor?: QuickExtractorOption;
  extractorOptions?: QuickProviderOptions;
  embeddingGenerator?: QuickEmbeddingOption;
  embeddingAdapter?: EmbeddingAdapter;
  policies?: {
    monitor?: Partial<MonitorPolicy>;
    extraction?: Partial<ExtractionPolicy>;
    context?: Partial<ContextPolicy>;
    maintenance?: Partial<MaintenancePolicy>;
  };
  logger?: Logger;
  onEvent?: EventHook;
  eventEmitter?: MemoryManagerConfig['eventEmitter'];
  redactText?: MemoryManagerConfig['redactText'];
  autoCompact?: boolean;
  autoExtract?: boolean;
  crossScopeLevel?: MemoryManagerConfig['crossScopeLevel'];
  contextContract?: ContextContract;
  contextContracts?: Record<string, ContextContract>;
  invariants?: ContextInvariant[];
  escalationPolicy?: ContextEscalationPolicy;
  failurePolicy?: MemoryManagerConfig['failurePolicy'];
  tokenEstimator?: TokenEstimator;
  autoDetectWorkspace?: boolean;
  /** Structured generation client for episodic recall, playbooks, and reflect. */
  structuredClient?: StructuredGenerationClient;
  /** Whether the created manager owns adapter shutdown. Defaults to true. */
  closeAdapter?: boolean;
  /** Optional ontology configuration for entity type validation and relationship constraints. */
  ontology?: import('../contracts/ontology.js').OntologyConfig;
}

export interface CreateMemoryAsyncOptions extends CreateMemoryOptions {
  asyncAdapter: AsyncStorageAdapter;
}

interface QualityModeConfig {
  monitorPolicy?: Partial<MonitorPolicy>;
  extractionPolicy?: Partial<ExtractionPolicy>;
  contextPolicy?: Partial<ContextPolicy>;
  maintenancePolicy?: Partial<MaintenancePolicy>;
}

const QUALITY_MODE_CONFIG: Record<MemoryQualityMode, QualityModeConfig> = {
  fast_adoption: {
    extractionPolicy: {
      requireGroundingForTrusted: false,
      minimumEvidenceCountForTrusted: 1,
      trustPromotionThreshold: 0.55,
      trustProvisionalThreshold: 0.15,
      contradictionDisputeThreshold: 0.5,
    },
    contextPolicy: {
      trustWeight: 0.8,
      contradictionPenalty: 1,
      provisionalPenalty: 0.15,
    },
    maintenancePolicy: {
      trustedCoreRetentionDays: 60,
      provisionalRetentionDays: 21,
      reverificationCadenceDays: 60,
      requireReconfirmationForProjectFacts: false,
    },
  },
  balanced_memory: {
    extractionPolicy: {
      requireGroundingForTrusted: true,
      minimumEvidenceCountForTrusted: 2,
      trustPromotionThreshold: 0.7,
      trustProvisionalThreshold: 0.45,
      contradictionDisputeThreshold: 0.35,
    },
    contextPolicy: {
      trustWeight: 1.3,
      contradictionPenalty: 1.5,
      provisionalPenalty: 0.75,
    },
    maintenancePolicy: {
      trustedCoreRetentionDays: 365,
      provisionalRetentionDays: 14,
      reverificationCadenceDays: 30,
      requireReconfirmationForProjectFacts: true,
    },
  },
  high_fidelity_memory: {
    extractionPolicy: {
      requireGroundingForTrusted: true,
      minimumEvidenceCountForTrusted: 2,
      minConfidenceForPromotion: 'high',
      trustPromotionThreshold: 0.82,
      trustProvisionalThreshold: 0.55,
      contradictionDisputeThreshold: 0.25,
    },
    contextPolicy: {
      trustWeight: 1.6,
      contradictionPenalty: 2,
      provisionalPenalty: 1.2,
      trustedCoreLimit: 10,
      taskRelevantLimit: 10,
    },
    maintenancePolicy: {
      trustedCoreRetentionDays: 730,
      provisionalRetentionDays: 10,
      reverificationCadenceDays: 14,
      requireReconfirmationForProjectFacts: true,
    },
  },
};

/** Map a legacy {@link MemoryQualityTier} onto its equivalent named profile. */
const QUALITY_TIER_TO_MODE: Record<MemoryQualityTier, MemoryQualityMode> = {
  offline_default: 'balanced_memory',
  local_semantic: 'balanced_memory',
  provider_backed: 'high_fidelity_memory',
};

let warnedQualityTierDeprecation = false;

/**
 * Emit a single process-lifetime warning when the deprecated `qualityTier`
 * option is used (Phase 6.5). Matches the JSDoc `@deprecated` convention used
 * for the flat manager shims; kept "once" so batch callers are not spammed.
 */
function warnQualityTierDeprecatedOnce(logger?: Logger): void {
  if (warnedQualityTierDeprecation) return;
  warnedQualityTierDeprecation = true;
  const message =
    "[ai-memory-layer] 'qualityTier' is deprecated (Phase 6.5) and will be removed in 6.0.0; " +
    "use 'qualityMode' (fast_adoption | balanced_memory | high_fidelity_memory) instead.";
  if (logger?.warn) {
    logger.warn(message);
  } else {
    console.warn(message);
  }
}

function resolveQualityMode(options: CreateMemoryOptions): MemoryQualityMode {
  if (options.qualityMode) return options.qualityMode;
  if (options.qualityTier) {
    warnQualityTierDeprecatedOnce(options.logger);
    return QUALITY_TIER_TO_MODE[options.qualityTier];
  }
  return 'balanced_memory';
}

function resolveScope(scope?: string | MemoryScope): MemoryScope {
  if (typeof scope === 'string') {
    return {
      tenant_id: 'default',
      system_id: 'default',
      scope_id: scope,
    };
  }

  return (
    scope ?? {
      tenant_id: 'default',
      system_id: 'default',
      scope_id: 'default',
    }
  );
}

function resolveAdapter(
  adapter: QuickAdapterOption | undefined,
  path: string | ':memory:',
  logger?: Logger,
  onEvent?: EventHook,
  qualityTier?: MemoryQualityTier,
): { adapter: StorageAdapter; embeddingAdapter?: EmbeddingAdapter } {
  if (!adapter && path === ':memory:') {
    const memory = createInMemoryAdapterWithEmbeddings({ logger, onEvent });
    return { adapter: memory, embeddingAdapter: memory.embeddings };
  }
  if (!adapter || adapter === 'sqlite') {
    const sqlite = createSQLiteAdapterWithEmbeddings(path, { logger, onEvent });
    return { adapter: sqlite, embeddingAdapter: sqlite.embeddings };
  }
  if (adapter === 'memory') {
    const memory = createInMemoryAdapterWithEmbeddings({ logger, onEvent });
    return { adapter: memory, embeddingAdapter: memory.embeddings };
  }
  return { adapter };
}

function resolveSummarizer(
  summarizer: QuickSummarizerOption | undefined,
  options?: QuickProviderOptions,
): Summarizer {
  if (!summarizer || summarizer === 'extractive') {
    return createExtractiveSummarizer();
  }
  if (summarizer === 'claude') {
    return createClaudeSummarizer(options);
  }
  if (summarizer === 'openai') {
    return createOpenAISummarizer(options);
  }
  return summarizer;
}

function resolveExtractor(
  extractor: QuickExtractorOption | undefined,
  options?: QuickProviderOptions,
): Extractor | undefined {
  if (extractor === false) {
    return undefined;
  }
  if (!extractor) {
    return createCompositeExtractor(createHeuristicExtractor(), createRegexExtractor());
  }
  if (extractor === 'heuristic') {
    return createHeuristicExtractor();
  }
  if (extractor === 'regex') {
    return createRegexExtractor();
  }
  if (extractor === 'claude') {
    return createClaudeExtractor(options);
  }
  if (extractor === 'openai') {
    return createOpenAIExtractor(options);
  }
  return extractor;
}

function resolveEmbeddingGenerator(
  embedding: QuickEmbeddingOption | undefined,
  embeddingAdapter: EmbeddingAdapter | undefined,
  qualityTier: MemoryQualityTier,
): EmbeddingGenerator | undefined {
  if (embedding === false) {
    return undefined;
  }
  if (typeof embedding === 'function') {
    return embedding;
  }
  if (!embeddingAdapter) {
    return undefined;
  }
  if (process.env.OPENAI_API_KEY) {
    return createOpenAIEmbeddingGenerator();
  }
  if (process.env.VOYAGE_API_KEY) {
    return createVoyageEmbeddingGenerator();
  }
  if (embedding === 'local' || qualityTier === 'offline_default' || qualityTier === 'local_semantic') {
    return createLocalEmbeddingGenerator();
  }
  return undefined;
}

function resolveCapabilityProfile(input: {
  options: CreateMemoryOptions & { asyncAdapter?: AsyncStorageAdapter };
  resolvedAdapter: { adapter?: StorageAdapter; embeddingAdapter?: EmbeddingAdapter };
  scope: MemoryScope;
  extractor: Extractor | undefined;
  embeddingGenerator: EmbeddingGenerator | undefined;
}): Record<string, unknown> {
  const storageKind = input.options.asyncAdapter
    ? 'async_custom'
    : !input.options.adapter && (input.options.path ?? ':memory:') === ':memory:'
      ? 'memory'
      : input.options.adapter === 'memory'
        ? 'memory'
        : input.options.adapter === 'sqlite' || input.options.path
          ? 'sqlite'
          : 'custom';
  const extractorTier =
    input.options.extractor === false
      ? 'disabled'
      : input.options.extractor === 'claude' || input.options.extractor === 'openai'
        ? 'provider'
        : input.options.extractor === 'regex'
          ? 'regex_enhanced'
          : input.options.extractor === 'heuristic' || input.options.extractor == null
            ? 'local_heuristic'
            : typeof input.options.extractor === 'function'
              ? 'custom'
              : input.extractor
                ? 'configured'
                : 'disabled';
  const embeddingTier =
    !input.embeddingGenerator && !input.resolvedAdapter.embeddingAdapter
      ? 'disabled'
      : process.env.OPENAI_API_KEY || process.env.VOYAGE_API_KEY
        ? 'provider'
        : input.embeddingGenerator
          ? 'local_semantic'
          : 'storage_only';

  return {
    qualityMode: resolveQualityMode(input.options),
    qualityTier: input.options.qualityTier ?? 'offline_default',
    storageKind,
    durableStorage:
      storageKind === 'sqlite' && (input.options.path ?? ':memory:') !== ':memory:',
    extractorTier,
    embeddingTier,
    semanticSearchEnabled: Boolean(input.embeddingGenerator && input.resolvedAdapter.embeddingAdapter),
    providerBacked:
      input.options.summarizer === 'claude' ||
      input.options.summarizer === 'openai' ||
      input.options.extractor === 'claude' ||
      input.options.extractor === 'openai' ||
      embeddingTier === 'provider',
    localFallbackActive: extractorTier !== 'provider' || embeddingTier !== 'provider',
    nativeAddonRequiredAtBootstrap: storageKind === 'sqlite',
  };
}

/** Where a resolved config field's final value came from (Phase 6.5). */
export type ConfigFieldSource = 'default' | 'preset' | 'qualityMode' | 'user';

/** A single resolved config field: its effective value and where it came from. */
export interface EffectiveConfigField<T = unknown> {
  value: T;
  source: ConfigFieldSource;
}

/**
 * The fully-merged manager configuration with per-field provenance (Phase 6.5).
 *
 * Reflects the layering the created manager actually applies at runtime:
 * built-in policy defaults (`default`) < preset (`preset`) < quality profile
 * (`qualityMode`) < caller policy overrides (`user`). The four policy maps are
 * keyed by policy field, each carrying the winning value and its `source`.
 */
export interface EffectiveManagerConfig {
  preset: MemoryManagerPreset;
  qualityMode: MemoryQualityMode;
  /** The legacy quality tier if one was supplied, else `null` (see the deprecated `qualityTier`). */
  qualityTier: MemoryQualityTier | null;
  monitorPolicy: Record<string, EffectiveConfigField>;
  extractionPolicy: Record<string, EffectiveConfigField>;
  contextPolicy: Record<string, EffectiveConfigField>;
  maintenancePolicy: Record<string, EffectiveConfigField>;
  autoCompact: EffectiveConfigField<boolean>;
  crossScopeLevel: EffectiveConfigField<ScopeLevel>;
}

function layerPolicy(
  layers: Array<{ source: ConfigFieldSource; obj: Record<string, unknown> | undefined }>,
): Record<string, EffectiveConfigField> {
  const out: Record<string, EffectiveConfigField> = {};
  for (const { source, obj } of layers) {
    if (!obj) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      out[key] = { value, source };
    }
  }
  return out;
}

/**
 * Resolve the effective manager configuration for a set of {@link CreateMemoryOptions},
 * annotating every policy field with its provenance (Phase 6.5).
 *
 * Pure and side-effect free with respect to storage/providers — it only reads
 * the same preset + quality-profile + user layers that {@link createMemory}
 * feeds to the manager, so callers can inspect or diff what a config resolves
 * to without instantiating adapters. (Passing a deprecated `qualityTier` still
 * triggers the one-time deprecation warning, exactly as construction would.)
 */
export function resolveEffectiveConfig(
  options: CreateMemoryOptions = {},
): EffectiveManagerConfig {
  const preset = options.preset ?? 'chat_agent';
  const presetConfig = resolveMemoryManagerPreset(options.preset);
  const qualityMode = resolveQualityMode(options);
  const qualityConfig = QUALITY_MODE_CONFIG[qualityMode];

  return {
    preset,
    qualityMode,
    qualityTier: options.qualityTier ?? null,
    monitorPolicy: layerPolicy([
      { source: 'default', obj: DEFAULT_MONITOR_POLICY as unknown as Record<string, unknown> },
      { source: 'preset', obj: presetConfig.monitorPolicy },
      { source: 'qualityMode', obj: qualityConfig.monitorPolicy },
      { source: 'user', obj: options.policies?.monitor },
    ]),
    extractionPolicy: layerPolicy([
      { source: 'default', obj: DEFAULT_EXTRACTION_POLICY as unknown as Record<string, unknown> },
      { source: 'preset', obj: presetConfig.extractionPolicy },
      { source: 'qualityMode', obj: qualityConfig.extractionPolicy },
      { source: 'user', obj: options.policies?.extraction },
    ]),
    contextPolicy: layerPolicy([
      { source: 'default', obj: DEFAULT_CONTEXT_POLICY as unknown as Record<string, unknown> },
      { source: 'preset', obj: presetConfig.contextPolicy },
      { source: 'qualityMode', obj: qualityConfig.contextPolicy },
      { source: 'user', obj: options.policies?.context },
    ]),
    maintenancePolicy: layerPolicy([
      { source: 'default', obj: DEFAULT_MAINTENANCE_POLICY as unknown as Record<string, unknown> },
      { source: 'preset', obj: presetConfig.maintenancePolicy },
      { source: 'qualityMode', obj: qualityConfig.maintenancePolicy },
      { source: 'user', obj: options.policies?.maintenance },
    ]),
    autoCompact: {
      value: options.autoCompact ?? presetConfig.autoCompact,
      source: options.autoCompact !== undefined ? 'user' : 'preset',
    },
    crossScopeLevel: {
      value: options.crossScopeLevel ?? presetConfig.crossScopeLevel,
      source: options.crossScopeLevel !== undefined ? 'user' : 'preset',
    },
  };
}

export function createMemory(options: CreateMemoryOptions = {}): MemoryManager {
  return createMemoryInternal(options);
}

export function createMemoryWithAsyncAdapter(options: CreateMemoryAsyncOptions): MemoryManager {
  return createMemoryInternal(options);
}

function createMemoryInternal(
  options: CreateMemoryOptions & { asyncAdapter?: AsyncStorageAdapter },
): MemoryManager {
  let scope = resolveScope(options.scope);
  if (options.autoDetectWorkspace && !scope.workspace_id) {
    const detectedId = detectWorkspace();
    if (detectedId) {
      scope = { ...scope, workspace_id: detectedId };
    }
  }
  const preset = resolveMemoryManagerPreset(options.preset);
  const qualityMode = resolveQualityMode(options);
  const qualityConfig = QUALITY_MODE_CONFIG[qualityMode];
  const resolvedAdapter = options.asyncAdapter
    ? { adapter: undefined, embeddingAdapter: options.embeddingAdapter }
    : resolveAdapter(
        options.adapter,
        options.path ?? ':memory:',
        options.logger,
        options.onEvent,
        options.qualityTier,
      );
  const summarizer = resolveSummarizer(options.summarizer, options.summarizerOptions);
  const extractor = resolveExtractor(options.extractor, options.extractorOptions);
  const embeddingAdapter = options.embeddingAdapter ?? resolvedAdapter.embeddingAdapter;
  const embeddingGenerator = resolveEmbeddingGenerator(
    options.embeddingGenerator,
    embeddingAdapter,
    options.qualityTier ?? 'offline_default',
  );
  const manager = createMemoryManager({
    ...(options.asyncAdapter
      ? { asyncAdapter: options.asyncAdapter }
      : { adapter: resolvedAdapter.adapter }),
    scope,
    sessionId: options.sessionId ?? createSessionId(scope),
    summarizer,
    extractor,
    embeddingAdapter,
    embeddingGenerator,
    logger: options.logger,
    onEvent: options.onEvent,
    eventEmitter: options.eventEmitter,
    redactText: options.redactText,
    autoCompact: options.autoCompact ?? preset.autoCompact,
    autoExtract: options.autoExtract ?? (extractor ? preset.autoExtract : false),
    crossScopeLevel: options.crossScopeLevel ?? preset.crossScopeLevel,
    contextContract: options.contextContract,
    contextContracts: options.contextContracts,
    invariants: options.invariants,
    escalationPolicy: options.escalationPolicy,
    monitorPolicy: {
      ...preset.monitorPolicy,
      ...qualityConfig.monitorPolicy,
      ...options.policies?.monitor,
    },
    extractionPolicy: {
      ...preset.extractionPolicy,
      ...qualityConfig.extractionPolicy,
      ...options.policies?.extraction,
    },
    contextPolicy: {
      ...preset.contextPolicy,
      ...qualityConfig.contextPolicy,
      ...options.policies?.context,
    },
    maintenancePolicy: {
      ...preset.maintenancePolicy,
      ...qualityConfig.maintenancePolicy,
      ...options.policies?.maintenance,
    },
    failurePolicy: options.failurePolicy,
    tokenEstimator: options.tokenEstimator,
    structuredClient: options.structuredClient ?? options.summarizerOptions?.client,
    closeAdapter: options.closeAdapter,
    ontology: options.ontology,
  });

  emitMemoryEvent(
    'capability',
    scope,
    { logger: options.logger, onEvent: options.onEvent },
    0,
    resolveCapabilityProfile({
      options,
      resolvedAdapter,
      scope,
      extractor,
      embeddingGenerator,
    }),
  );

  return manager;
}
