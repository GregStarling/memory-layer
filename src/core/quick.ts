import type { MemoryScope } from '../contracts/identity.js';
import type { EmbeddingAdapter, EmbeddingGenerator } from '../contracts/embedding.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MaintenancePolicy,
  MonitorPolicy,
} from '../contracts/policy.js';
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
} from './extractor.js';
import {
  createMemoryManager,
  type MemoryManager,
  type MemoryManagerConfig,
} from './manager.js';
import { resolveMemoryManagerPreset, type MemoryManagerPreset } from './presets.js';
import { createSessionId, type TokenEstimator } from './tokens.js';
import { type StructuredGenerationClient } from '../summarizers/client.js';
import { createClaudeSummarizer } from '../summarizers/claude.js';
import { createExtractiveSummarizer } from '../summarizers/extractive.js';
import { createOpenAISummarizer } from '../summarizers/openai.js';
import { createClaudeExtractor, createOpenAIExtractor } from '../summarizers/extractor.js';
import type { Summarizer } from './orchestrator.js';
import { emitMemoryEvent } from './telemetry.js';
import { detectWorkspace } from './workspace-detect.js';

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
  qualityMode?: MemoryQualityMode;
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

function resolveQualityMode(options: CreateMemoryOptions): MemoryQualityMode {
  if (options.qualityMode) return options.qualityMode;
  switch (options.qualityTier) {
    case 'offline_default':
      return 'balanced_memory';
    case 'provider_backed':
      return 'high_fidelity_memory';
    case 'local_semantic':
    default:
      return 'balanced_memory';
  }
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
