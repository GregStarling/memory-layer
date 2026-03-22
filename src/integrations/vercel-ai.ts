import type { AfterModelCallInput, BeforeModelCallInput, MemoryRuntime } from '../core/runtime.js';

export interface VercelAIPreparedInput {
  system?: string;
  messages: Array<{ role: string; content: string }>;
}

export interface VercelAIWrapOptions {
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

export async function prepareVercelAIInput(
  runtime: MemoryRuntime,
  input: string | BeforeModelCallInput,
): Promise<VercelAIPreparedInput> {
  const prepared = await runtime.beforeModelCall(input);
  const resolvedInput = typeof input === 'string' ? input : input.input;
  return {
    system: prepared.bootstrapPrompt,
    messages: [
      ...prepared.messages,
      { role: 'user', content: resolvedInput },
    ],
  };
}

export function wrapVercelAIModel<TInput extends string | BeforeModelCallInput, TResult>(
  runtime: MemoryRuntime,
  modelCall: (prepared: VercelAIPreparedInput) => Promise<TResult>,
  options: VercelAIWrapOptions = {},
): (input: TInput) => Promise<{ result: TResult; responseText: string }> {
  return async (input) => {
    const runtimeInput = options.mapInput ? options.mapInput(input) : input;
    const prepared = await prepareVercelAIInput(runtime, runtimeInput);
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
