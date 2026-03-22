import type { AfterModelCallInput, BeforeModelCallInput, MemoryRuntime } from '../core/runtime.js';

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
  const tools = createClaudeMemoryTools(runtime);

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
    const runtimeInput = options.mapInput ? options.mapInput(input) : input;
    const prepared = await prepareClaudeAgentInput(runtime, runtimeInput);
    const result = await modelCall(prepared);
    const responseText = options.mapOutput ? options.mapOutput(result) : toTextResult(result);
    const resolvedInput = typeof runtimeInput === 'string' ? runtimeInput : runtimeInput.input;
    await runtime.afterModelCall({
      userInput: resolvedInput,
      assistantOutput: responseText,
      actors: options.actors,
    });
    return { result, responseText };
  };
}
