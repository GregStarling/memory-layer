import type { MemoryRuntime } from '../core/runtime.js';

interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const CLAUDE_MEMORY_TOOLS: ClaudeToolDefinition[] = [
  {
    name: 'memory_start_session',
    description: 'Load bootstrap memory for a new or resumed session.',
    input_schema: {
      type: 'object',
      properties: {
        relevanceQuery: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_prepare_call',
    description: 'Prepare prompt-ready memory before a model call.',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string' },
        relevanceQuery: { type: 'string' },
      },
      required: ['input'],
    },
  },
  {
    name: 'memory_commit_call',
    description: 'Commit the completed user and assistant exchange to memory.',
    input_schema: {
      type: 'object',
      properties: {
        userInput: { type: 'string' },
        assistantOutput: { type: 'string' },
      },
      required: ['userInput', 'assistantOutput'],
    },
  },
];

export function createClaudeMemoryTools(runtime: MemoryRuntime) {
  return {
    tools: CLAUDE_MEMORY_TOOLS,
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
      throw new Error(`Unknown Claude memory tool '${name}'`);
    },
  };
}

export type { ClaudeToolDefinition };
