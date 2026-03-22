import type { EmbeddingGenerator } from '../contracts/embedding.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MaintenancePolicy,
  MonitorPolicy,
} from '../contracts/policy.js';
import type { MemoryEventEmitter } from './events.js';
import {
  createSQLiteAdapter,
  createSQLiteAdapterWithEmbeddings,
} from '../adapters/sqlite/index.js';
import { createSessionId } from './tokens.js';
import {
  createMemoryManager,
  type MemoryManager,
  type MemoryManagerConfig,
} from './manager.js';
import {
  resolveMemoryManagerPreset,
  type MemoryManagerPreset,
} from './presets.js';
import {
  createClaudeExtractor,
  createOpenAIExtractor,
  type ProviderExtractorOptions,
} from '../summarizers/extractor.js';
import {
  createClaudeSummarizer,
  type ClaudeSummarizerOptions,
} from '../summarizers/claude.js';
import {
  createOpenAISummarizer,
  type OpenAISummarizerOptions,
} from '../summarizers/openai.js';

function getOptionalEmbeddingAdapter(
  adapter: ReturnType<typeof createSQLiteAdapter> | ReturnType<typeof createSQLiteAdapterWithEmbeddings>,
  embeddingGenerator: EmbeddingGenerator | undefined,
) {
  if (!embeddingGenerator || !('embeddings' in adapter)) {
    return undefined;
  }
  return adapter.embeddings;
}

interface ProviderFailurePolicy extends NonNullable<MemoryManagerConfig['failurePolicy']> {}

interface ProviderMemoryManagerBaseOptions {
  dbPath: string | ':memory:';
  scope: MemoryScope;
  sessionId?: string;
  preset?: MemoryManagerPreset;
  embeddingGenerator?: EmbeddingGenerator;
  logger?: Logger;
  onEvent?: EventHook;
  eventEmitter?: MemoryEventEmitter;
  redactText?: MemoryManagerConfig['redactText'];
  autoCompact?: boolean;
  autoExtract?: boolean;
  crossScopeLevel?: MemoryManagerConfig['crossScopeLevel'];
  monitorPolicy?: Partial<MonitorPolicy>;
  extractionPolicy?: Partial<ExtractionPolicy>;
  contextPolicy?: Partial<ContextPolicy>;
  maintenancePolicy?: Partial<MaintenancePolicy>;
  failurePolicy?: Partial<ProviderFailurePolicy>;
}

export interface ClaudeMemoryManagerOptions extends ProviderMemoryManagerBaseOptions {
  summarizer?: ClaudeSummarizerOptions;
  extractor?: (ProviderExtractorOptions & { enabled?: boolean }) | false;
}

export interface OpenAIMemoryManagerOptions extends ProviderMemoryManagerBaseOptions {
  summarizer?: OpenAISummarizerOptions;
  extractor?: (ProviderExtractorOptions & { enabled?: boolean }) | false;
}

function resolveProviderConfig<TSummarizer, TExtractor extends { enabled?: boolean } | false | undefined>(
  options: ProviderMemoryManagerBaseOptions & {
    summarizer?: TSummarizer;
    extractor?: TExtractor;
  },
) {
  const preset = resolveMemoryManagerPreset(options.preset);
  const adapter =
    options.embeddingGenerator !== undefined
      ? createSQLiteAdapterWithEmbeddings(options.dbPath, {
          logger: options.logger,
          onEvent: options.onEvent,
        })
      : createSQLiteAdapter(options.dbPath, {
          logger: options.logger,
          onEvent: options.onEvent,
        });

  return {
    adapter,
    preset,
    sessionId: options.sessionId ?? createSessionId(options.scope),
    monitorPolicy: {
      ...preset.monitorPolicy,
      ...options.monitorPolicy,
    },
    extractionPolicy: {
      ...preset.extractionPolicy,
      ...options.extractionPolicy,
    },
    contextPolicy: {
      ...preset.contextPolicy,
      ...options.contextPolicy,
    },
    maintenancePolicy: {
      ...preset.maintenancePolicy,
      ...options.maintenancePolicy,
    },
    autoCompact: options.autoCompact ?? preset.autoCompact,
    autoExtract:
      options.autoExtract ??
      (options.extractor === false || options.extractor?.enabled === false
        ? false
        : preset.autoExtract),
    crossScopeLevel: options.crossScopeLevel ?? preset.crossScopeLevel,
    failurePolicy: {
      summarizer: 'retry_once' as const,
      extractor: 'disable_auto_extract' as const,
      ...options.failurePolicy,
    },
  };
}

export function createClaudeMemoryManager(
  options: ClaudeMemoryManagerOptions,
): MemoryManager {
  const resolved = resolveProviderConfig(options);
  const extractorEnabled = options.extractor !== false && options.extractor?.enabled !== false;

  return createMemoryManager({
    adapter: resolved.adapter,
    scope: options.scope,
    sessionId: resolved.sessionId,
    summarizer: createClaudeSummarizer(options.summarizer),
    extractor: extractorEnabled
      ? createClaudeExtractor(options.extractor === false ? undefined : options.extractor)
      : undefined,
    embeddingAdapter: getOptionalEmbeddingAdapter(resolved.adapter, options.embeddingGenerator),
    embeddingGenerator: options.embeddingGenerator,
    logger: options.logger,
    onEvent: options.onEvent,
    eventEmitter: options.eventEmitter,
    redactText: options.redactText,
    monitorPolicy: resolved.monitorPolicy,
    extractionPolicy: resolved.extractionPolicy,
    contextPolicy: resolved.contextPolicy,
    maintenancePolicy: resolved.maintenancePolicy,
    autoCompact: resolved.autoCompact,
    autoExtract: resolved.autoExtract,
    crossScopeLevel: resolved.crossScopeLevel,
    failurePolicy: resolved.failurePolicy,
  });
}

export function createOpenAIMemoryManager(
  options: OpenAIMemoryManagerOptions,
): MemoryManager {
  const resolved = resolveProviderConfig(options);
  const extractorEnabled = options.extractor !== false && options.extractor?.enabled !== false;

  return createMemoryManager({
    adapter: resolved.adapter,
    scope: options.scope,
    sessionId: resolved.sessionId,
    summarizer: createOpenAISummarizer(options.summarizer),
    extractor: extractorEnabled
      ? createOpenAIExtractor(options.extractor === false ? undefined : options.extractor)
      : undefined,
    embeddingAdapter: getOptionalEmbeddingAdapter(resolved.adapter, options.embeddingGenerator),
    embeddingGenerator: options.embeddingGenerator,
    logger: options.logger,
    onEvent: options.onEvent,
    eventEmitter: options.eventEmitter,
    redactText: options.redactText,
    monitorPolicy: resolved.monitorPolicy,
    extractionPolicy: resolved.extractionPolicy,
    contextPolicy: resolved.contextPolicy,
    maintenancePolicy: resolved.maintenancePolicy,
    autoCompact: resolved.autoCompact,
    autoExtract: resolved.autoExtract,
    crossScopeLevel: resolved.crossScopeLevel,
    failurePolicy: resolved.failurePolicy,
  });
}
