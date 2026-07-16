import type { MemoryRuntime } from '../core/runtime.js';
import { ValidationError } from '../contracts/errors.js';

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'memory_start_session',
    description: 'Load bootstrap memory for a new or resumed session.',
    inputSchema: {
      type: 'object',
      properties: {
        relevanceQuery: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_prepare_call',
    description: 'Prepare prompt-ready memory before a model call.',
    inputSchema: {
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
    inputSchema: {
      type: 'object',
      properties: {
        userInput: { type: 'string' },
        assistantOutput: { type: 'string' },
      },
      required: ['userInput', 'assistantOutput'],
    },
  },
];

export function createMemoryMcpAdapter(runtime: MemoryRuntime) {
  return {
    tools: MCP_TOOLS,
    async callTool(name: string, args: Record<string, unknown>) {
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
      throw new ValidationError(`Unknown MCP memory tool '${name}'`);
    },
  };
}

export type { McpToolDefinition };
