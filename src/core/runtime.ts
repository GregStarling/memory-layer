import type { TurnRole, WorkItem } from '../contracts/types.js';
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

export interface BeforeModelCallInput {
  input: string;
  relevanceQuery?: string;
  format?: FormatOptions;
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
}

function resolveRuntimeInput(input: string | BeforeModelCallInput): BeforeModelCallInput {
  return typeof input === 'string'
    ? {
        input,
      }
    : input;
}

export function createMemoryRuntime(
  manager: MemoryManager,
  options: MemoryRuntimeOptions = {},
): MemoryRuntime {
  async function getBootstrapPayload(relevanceQuery?: string, format?: FormatOptions) {
    const bootstrap = await manager.getSessionBootstrap(relevanceQuery);
    const bootstrapPrompt = formatBootstrapForPrompt(bootstrap, format ?? options.format);
    return {
      bootstrap,
      bootstrapPrompt,
    };
  }

  return {
    async startSession(relevanceQuery, format) {
      return getBootstrapPayload(relevanceQuery, format);
    },

    async resumeSession(relevanceQuery, format) {
      return getBootstrapPayload(relevanceQuery, format);
    },

    async beforeModelCall(input) {
      const resolved = resolveRuntimeInput(input);
      const [bootstrapPayload, context] = await Promise.all([
        getBootstrapPayload(resolved.relevanceQuery ?? resolved.input, resolved.format),
        manager.getContext(resolved.relevanceQuery ?? resolved.input),
      ]);
      const contextPrompt = formatContextForPrompt(context, resolved.format ?? options.format);
      return {
        bootstrap: bootstrapPayload.bootstrap,
        context,
        bootstrapPrompt: bootstrapPayload.bootstrapPrompt,
        prompt: [bootstrapPayload.bootstrapPrompt, contextPrompt].join('\n\n'),
        messages: formatContextAsMessages(context, resolved.format ?? options.format),
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
  };
}
