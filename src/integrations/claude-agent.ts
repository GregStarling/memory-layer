import type {
  AfterModelCallInput,
  BeforeModelCallInput,
  MemoryRuntime,
  RuntimeWorkItemSuggestion,
} from '../core/runtime.js';
import type { FormatOptions } from '../core/formatter.js';

import { createClaudeMemoryTools, type ClaudeToolDefinition } from './claude-tools.js';

export interface ClaudeAgentPreparedInput {
  system?: string;
  messages: Array<{ role: string; content: string }>;
  tools: ClaudeToolDefinition[];
}

export interface ClaudeAgentWrapOptions {
  mapInput?: (input: string | BeforeModelCallInput) => BeforeModelCallInput;
  mapOutput?: (result: unknown) => string;
  actors?: AfterModelCallInput['actors'];
  /**
   * When true, ensure a session snapshot is captured on first use so subsequent
   * `beforeModelCall` calls read from the frozen cache. Requires the underlying
   * runtime to be constructed with `snapshotMode: true`.
   */
  snapshotMode?: boolean;
  /** Point-in-time query (epoch seconds) for temporal context retrieval. */
  asOf?: number;
  /** Include provisional knowledge in context. */
  includeProvisionalKnowledge?: boolean;
  /** Include disputed knowledge in context. */
  includeDisputedKnowledge?: boolean;
  /** Format options for context rendering. */
  format?: FormatOptions;
  /** Work items to record after model call. */
  workItems?: RuntimeWorkItemSuggestion[];
  /** Include core memory bundle in bootstrap prompt. */
  includeCoreMemory?: boolean;
  /** Include graph report summary in bootstrap prompt. */
  includeGraphReport?: boolean;
  /** Tag filter for knowledge retrieval. */
  tags?: string[];
  /** Alias map override for this call. */
  aliasMap?: import('../contracts/aliases.js').AliasMap;
}

function toTextResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    if ('text' in result && typeof result.text === 'string') {
      return result.text;
    }
    if ('output_text' in result && typeof result.output_text === 'string') {
      return result.output_text;
    }
  }
  return String(result);
}

export async function prepareClaudeAgentInput(
  runtime: MemoryRuntime,
  input: string | BeforeModelCallInput,
): Promise<ClaudeAgentPreparedInput> {
  const prepared = await runtime.beforeModelCall(input);
  const resolvedInput = typeof input === 'string' ? input : input.input;
  const tools = createClaudeMemoryTools(runtime, runtime.manager);

  return {
    system: prepared.bootstrapPrompt,
    messages: [
      ...prepared.messages,
      { role: 'user', content: resolvedInput },
    ],
    tools: tools.tools,
  };
}

export function wrapClaudeAgentModel<TInput extends string | BeforeModelCallInput, TResult>(
  runtime: MemoryRuntime,
  modelCall: (prepared: ClaudeAgentPreparedInput) => Promise<TResult>,
  options: ClaudeAgentWrapOptions = {},
): (input: TInput) => Promise<{ result: TResult; responseText: string }> {
  return async (input) => {
    const rawInput = options.mapInput ? options.mapInput(input) : input;
    // Merge Phase 5 options into the input
    const runtimeInput: BeforeModelCallInput = typeof rawInput === 'string'
      ? {
          input: rawInput,
          asOf: options.asOf,
          includeProvisionalKnowledge: options.includeProvisionalKnowledge,
          includeDisputedKnowledge: options.includeDisputedKnowledge,
          format: options.format,
          includeCoreMemory: options.includeCoreMemory,
          includeGraphReport: options.includeGraphReport,
          tags: options.tags,
          aliasMap: options.aliasMap,
        }
      : {
          ...rawInput,
          asOf: rawInput.asOf ?? options.asOf,
          includeProvisionalKnowledge: rawInput.includeProvisionalKnowledge ?? options.includeProvisionalKnowledge,
          includeDisputedKnowledge: rawInput.includeDisputedKnowledge ?? options.includeDisputedKnowledge,
          format: rawInput.format ?? options.format,
          includeCoreMemory: rawInput.includeCoreMemory ?? options.includeCoreMemory,
          includeGraphReport: rawInput.includeGraphReport ?? options.includeGraphReport,
          tags: rawInput.tags ?? options.tags,
          aliasMap: rawInput.aliasMap ?? options.aliasMap,
        };
    if (options.snapshotMode && runtime.getSnapshot() == null) {
      await runtime.refreshSnapshot(runtimeInput.relevanceQuery);
    }
    const prepared = await prepareClaudeAgentInput(runtime, runtimeInput);
    const result = await modelCall(prepared);
    const responseText = options.mapOutput ? options.mapOutput(result) : toTextResult(result);
    const resolvedInput = runtimeInput.input;
    await runtime.afterModelCall({
      userInput: resolvedInput,
      assistantOutput: responseText,
      actors: options.actors,
      workItems: options.workItems,
    });
    return { result, responseText };
  };
}
