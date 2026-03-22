import type { MemoryRuntime } from '../core/runtime.js';

interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const OPENAI_MEMORY_TOOLS: OpenAIFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory_start_session',
      description: 'Load bootstrap memory for a new or resumed session.',
      parameters: {
        type: 'object',
        properties: {
          relevanceQuery: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_prepare_call',
      description: 'Prepare prompt-ready memory before a model call.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          relevanceQuery: { type: 'string' },
        },
        required: ['input'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_commit_call',
      description: 'Commit the completed user and assistant exchange to memory.',
      parameters: {
        type: 'object',
        properties: {
          userInput: { type: 'string' },
          assistantOutput: { type: 'string' },
        },
        required: ['userInput', 'assistantOutput'],
      },
    },
  },
];

export function createOpenAIMemoryTools(runtime: MemoryRuntime) {
  return {
    tools: OPENAI_MEMORY_TOOLS,
    async invokeTool(name: string, args: Record<string, unknown>) {
      if (name === 'memory_start_session') {
        return runtime.startSession(
          typeof args.relevanceQuery === 'string' ? args.relevanceQuery : undefined,
        );
      }
      if (name === 'memory_prepare_call') {
        return runtime.beforeModelCall({
          input: String(args.input ?? ''),
          relevanceQuery:
            typeof args.relevanceQuery === 'string' ? args.relevanceQuery : undefined,
        });
      }
      if (name === 'memory_commit_call') {
        return runtime.afterModelCall({
          userInput: String(args.userInput ?? ''),
          assistantOutput: String(args.assistantOutput ?? ''),
        });
      }
      throw new Error(`Unknown OpenAI memory tool '${name}'`);
    },
  };
}

export type { OpenAIFunctionTool };
