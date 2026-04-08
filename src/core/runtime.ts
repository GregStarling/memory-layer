import type { TurnRole, WorkItem } from '../contracts/types.js';
import type { Profile } from '../contracts/profile.js';
import {
  formatBootstrapForPrompt,
  formatContextAsMessages,
  formatContextForPrompt,
  type FormatOptions,
  type SessionBootstrap,
} from './formatter.js';
import type { MemoryManager } from './manager.js';
import type { MemoryContext } from './context.js';

export interface RuntimeWorkItemSuggestion {
  title: string;
  kind?: WorkItem['kind'];
  status?: WorkItem['status'];
  detail?: string;
}

export interface MemoryRuntimeOptions {
  format?: FormatOptions;
  inferWorkItems?: (input: {
    userInput: string;
    assistantOutput: string;
  }) => RuntimeWorkItemSuggestion[] | Promise<RuntimeWorkItemSuggestion[]>;
}

export interface SessionSnapshot {
  snapshotId: string;
  bootstrap: SessionBootstrap;
  context: MemoryContext;
  frozenAt: number;
  watermarkEventId: string | null;
  profile?: Profile | null;
}

export interface SnapshotRuntimeOptions extends MemoryRuntimeOptions {
  snapshotMode?: boolean;
}

export interface BeforeModelCallInput {
  input: string;
  relevanceQuery?: string;
  format?: FormatOptions;
  asOf?: number;
  includeProvisionalKnowledge?: boolean;
  includeDisputedKnowledge?: boolean;
  /** Include core memory bundle in the bootstrap prompt. */
  includeCoreMemory?: boolean;
  /** Include graph report summary in the bootstrap prompt. */
  includeGraphReport?: boolean;
  /** Tag filter for knowledge retrieval. */
  tags?: string[];
  /** Alias map override for this call. */
  aliasMap?: import('../contracts/aliases.js').AliasMap;
}

export interface BeforeModelCallResult {
  bootstrap: SessionBootstrap;
  context: MemoryContext;
  bootstrapPrompt: string;
  prompt: string;
  messages: Array<{ role: 'system'; content: string }>;
}

export interface AfterModelCallInput {
  userInput: string;
  assistantOutput: string;
  actors?: { user?: string; assistant?: string };
  workItems?: RuntimeWorkItemSuggestion[];
}

export interface MemoryRuntime {
  /** The underlying manager, exposed for advanced integrations (episodic tools, playbooks). */
  manager: MemoryManager;
  startSession(relevanceQuery?: string, format?: FormatOptions): Promise<{
    bootstrap: SessionBootstrap;
    bootstrapPrompt: string;
  }>;
  resumeSession(relevanceQuery?: string, format?: FormatOptions): Promise<{
    bootstrap: SessionBootstrap;
    bootstrapPrompt: string;
  }>;
  beforeModelCall(input: string | BeforeModelCallInput): Promise<BeforeModelCallResult>;
  afterModelCall(input: AfterModelCallInput): Promise<{
    exchange: Awaited<ReturnType<MemoryManager['processExchange']>>;
    trackedWorkItems: WorkItem[];
  }>;
  wrapModelCall(
    modelCall: (payload: BeforeModelCallResult) => Promise<string>,
    input: string | BeforeModelCallInput,
    actors?: AfterModelCallInput['actors'],
  ): Promise<{
    result: string;
    runtime: BeforeModelCallResult;
    exchange: Awaited<ReturnType<MemoryManager['processExchange']>>;
    trackedWorkItems: WorkItem[];
  }>;
  refreshSnapshot(relevanceQuery?: string, format?: FormatOptions): Promise<SessionSnapshot | null>;
  getSnapshot(): SessionSnapshot | null;
}

function resolveRuntimeInput(input: string | BeforeModelCallInput): BeforeModelCallInput {
  return typeof input === 'string'
    ? {
        input,
      }
    : input;
}

/**
 * Recursively deep-freeze a value so cached snapshots cannot be mutated
 * by downstream callers. Arrays and plain objects are walked; primitives
 * and already-frozen values are returned as-is.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function cloneSnapshotValue<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryRuntime(
  manager: MemoryManager,
  options: SnapshotRuntimeOptions = {},
): MemoryRuntime {
  const snapshotMode = options.snapshotMode ?? false;
  let cachedSnapshot: SessionSnapshot | null = null;

  async function getBootstrapPayload(relevanceQuery?: string, format?: FormatOptions) {
    const bootstrap = await manager.getSessionBootstrap(relevanceQuery);
    const bootstrapPrompt = formatBootstrapForPrompt(bootstrap, format ?? options.format);
    return {
      bootstrap,
      bootstrapPrompt,
    };
  }

  async function captureSnapshot(
    relevanceQuery?: string,
    _format?: FormatOptions,
  ): Promise<SessionSnapshot> {
    const captured = await manager.captureSnapshot(relevanceQuery);
    const snapshot: SessionSnapshot = {
      snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      bootstrap: captured.bootstrap,
      context: captured.context,
      frozenAt: captured.frozenAt,
      watermarkEventId: captured.watermarkEventId,
      profile: captured.profile,
    };
    // Deep-freeze so callers can't mutate the cached snapshot's bootstrap,
    // context, or profile via returned references.
    return deepFreeze(cloneSnapshotValue(snapshot));
  }

  return {
    manager,

    async startSession(relevanceQuery, format) {
      if (snapshotMode) {
        cachedSnapshot = await captureSnapshot(relevanceQuery, format);
        return {
          bootstrap: cachedSnapshot.bootstrap,
          bootstrapPrompt: formatBootstrapForPrompt(cachedSnapshot.bootstrap, format ?? options.format),
        };
      }
      return getBootstrapPayload(relevanceQuery, format);
    },

    async resumeSession(relevanceQuery, format) {
      if (snapshotMode) {
        cachedSnapshot = await captureSnapshot(relevanceQuery, format);
        return {
          bootstrap: cachedSnapshot.bootstrap,
          bootstrapPrompt: formatBootstrapForPrompt(cachedSnapshot.bootstrap, format ?? options.format),
        };
      }
      return getBootstrapPayload(relevanceQuery, format);
    },

    async beforeModelCall(input) {
      const resolved = resolveRuntimeInput(input);
      const resolvedFormat = {
        ...(options.format ?? {}),
        ...(resolved.format ?? {}),
        includeProvisionalKnowledge:
          resolved.includeProvisionalKnowledge ??
          resolved.format?.includeProvisionalKnowledge ??
          options.format?.includeProvisionalKnowledge,
        includeDisputedKnowledge:
          resolved.includeDisputedKnowledge ??
          resolved.format?.includeDisputedKnowledge ??
          options.format?.includeDisputedKnowledge,
      };

      // Snapshot mode: return the frozen snapshot instead of refetching live state.
      // Live writes (afterModelCall) still persist to durable storage; only the
      // prompt-injected context is frozen for cache stability.
      //
      // If no snapshot has been captured yet (caller skipped startSession/
      // resumeSession), seed it lazily on first use so subsequent calls remain
      // stable.
      if (snapshotMode) {
        if (!cachedSnapshot) {
          cachedSnapshot = await captureSnapshot(
            resolved.relevanceQuery ?? resolved.input,
            resolvedFormat,
          );
        }
        const bootstrapPrompt = formatBootstrapForPrompt(cachedSnapshot.bootstrap, resolvedFormat);
        const contextPrompt = formatContextForPrompt(cachedSnapshot.context, resolvedFormat);
        return {
          bootstrap: cachedSnapshot.bootstrap,
          context: cachedSnapshot.context,
          bootstrapPrompt,
          prompt: [bootstrapPrompt, contextPrompt].join('\n\n'),
          messages: formatContextAsMessages(cachedSnapshot.context, resolvedFormat),
        };
      }

      const [bootstrap, context] = await Promise.all([
        resolved.asOf != null
          ? manager.getSessionBootstrapAt(resolved.asOf, resolved.relevanceQuery ?? resolved.input)
          : manager.getSessionBootstrap(resolved.relevanceQuery ?? resolved.input),
        resolved.asOf != null
          ? manager.getContextAt(resolved.asOf, resolved.relevanceQuery ?? resolved.input)
          : manager.getContext(resolved.relevanceQuery ?? resolved.input),
      ]);
      const bootstrapPrompt = formatBootstrapForPrompt(bootstrap, resolvedFormat);
      const contextPrompt = formatContextForPrompt(context, resolvedFormat);
      return {
        bootstrap,
        context,
        bootstrapPrompt,
        prompt: [bootstrapPrompt, contextPrompt].join('\n\n'),
        messages: formatContextAsMessages(context, resolvedFormat),
      };
    },

    async afterModelCall(input) {
      const exchange = await manager.processExchange(
        input.userInput,
        input.assistantOutput,
        input.actors,
      );

      const inferred = options.inferWorkItems
        ? await options.inferWorkItems({
            userInput: input.userInput,
            assistantOutput: input.assistantOutput,
          })
        : [];
      const trackedWorkItems = await Promise.all(
        [...(input.workItems ?? []), ...inferred].map((item) =>
          manager.trackWorkItem(item.title, item.kind, item.status, item.detail),
        ),
      );

      return {
        exchange,
        trackedWorkItems,
      };
    },

    async wrapModelCall(modelCall, input, actors) {
      const runtime = await this.beforeModelCall(input);
      const result = await modelCall(runtime);
      const resolved = resolveRuntimeInput(input);
      const after = await this.afterModelCall({
        userInput: resolved.input,
        assistantOutput: result,
        actors,
      });
      return {
        result,
        runtime,
        exchange: after.exchange,
        trackedWorkItems: after.trackedWorkItems,
      };
    },

    async refreshSnapshot(relevanceQuery, format) {
      if (!snapshotMode) return null;
      cachedSnapshot = await captureSnapshot(relevanceQuery, format);
      return cachedSnapshot;
    },

    getSnapshot() {
      return cachedSnapshot;
    },
  };
}
