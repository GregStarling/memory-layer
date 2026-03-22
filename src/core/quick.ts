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
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { createSQLiteAdapter, createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createLocalEmbeddingGenerator } from '../embeddings/local.js';
import { createRegexExtractor, type Extractor } from './extractor.js';
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

type QuickAdapterOption = 'sqlite' | 'memory' | StorageAdapter;
type QuickSummarizerOption = 'claude' | 'openai' | 'extractive' | Summarizer;
type QuickExtractorOption = 'claude' | 'openai' | 'regex' | Extractor | false;
type QuickEmbeddingOption = 'local' | EmbeddingGenerator | false;
export type MemoryQualityTier = 'offline_default' | 'local_semantic' | 'provider_backed';

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
}

function resolveScope(scope?: string | MemoryScope): MemoryScope {
  if (typeof scope === 'string') {
    return {
      tenant_id: 'default',
      system_id: scope,
      scope_id: 'default',
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
  qualityTier: MemoryQualityTier = 'offline_default',
): { adapter: StorageAdapter; embeddingAdapter?: EmbeddingAdapter } {
  if (!adapter || adapter === 'sqlite') {
    if (qualityTier === 'offline_default' || qualityTier === 'local_semantic') {
      const sqlite = createSQLiteAdapterWithEmbeddings(path, { logger, onEvent });
      return { adapter: sqlite, embeddingAdapter: sqlite.embeddings };
    }
    return { adapter: createSQLiteAdapter(path, { logger, onEvent }) };
  }
  if (adapter === 'memory') {
    return { adapter: createInMemoryAdapter({ logger, onEvent }) };
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
  if (!extractor || extractor === 'regex') {
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
  if (embedding === 'local' || qualityTier === 'offline_default' || qualityTier === 'local_semantic') {
    return createLocalEmbeddingGenerator();
  }
  return undefined;
}

export function createMemory(options: CreateMemoryOptions = {}): MemoryManager {
  const scope = resolveScope(options.scope);
  const preset = resolveMemoryManagerPreset(options.preset);
  const resolvedAdapter = resolveAdapter(
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

  return createMemoryManager({
    adapter: resolvedAdapter.adapter,
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
      ...options.policies?.monitor,
    },
    extractionPolicy: {
      ...preset.extractionPolicy,
      ...options.policies?.extraction,
    },
    contextPolicy: {
      ...preset.contextPolicy,
      ...options.policies?.context,
    },
    maintenancePolicy: {
      ...preset.maintenancePolicy,
      ...options.policies?.maintenance,
    },
    failurePolicy: options.failurePolicy,
    tokenEstimator: options.tokenEstimator,
  });
}
