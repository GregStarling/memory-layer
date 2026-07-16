import type { MemoryManager } from '../core/manager.js';
import type { MemoryRuntime } from '../core/runtime.js';
import { ValidationError } from '../contracts/errors.js';
import type { EpisodeDetailLevel, TimeRange } from '../contracts/types.js';
import type { CognitiveMemoryType } from '../contracts/cognitive.js';

interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function parseTimeRangeArg(raw: unknown): TimeRange | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as { start_at?: unknown; end_at?: unknown };
  const start_at = typeof obj.start_at === 'number' ? obj.start_at : undefined;
  const end_at = typeof obj.end_at === 'number' ? obj.end_at : undefined;
  if (start_at === undefined && end_at === undefined) return undefined;
  return { start_at, end_at } as TimeRange;
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

const CLAUDE_EPISODIC_TOOLS: ClaudeToolDefinition[] = [
  {
    name: 'memory_search_episodes',
    description:
      'Search episodic memory for past session activity. Returns structured episode summaries grouped by session.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        detailLevel: {
          type: 'string',
          enum: ['abstract', 'overview', 'full'],
          description:
            'Amount of detail: abstract (objective+outcomes), overview (+actions), full (+artifacts+excerpts). Defaults to overview.',
        },
        limit: { type: 'number', description: 'Max episodes to return.' },
        timeRange: {
          type: 'object',
          description: 'Restrict episodes to a time window (unix seconds).',
          properties: {
            start_at: { type: 'number', description: 'Inclusive lower bound (unix seconds).' },
            end_at: { type: 'number', description: 'Inclusive upper bound (unix seconds).' },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_summarize_episode',
    description:
      'Produce a structured recap of a specific session at the requested detail level.',
    input_schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session to summarize.' },
        detailLevel: {
          type: 'string',
          enum: ['abstract', 'overview', 'full'],
          description: 'Detail level for the recap. Defaults to overview.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'memory_reflect',
    description:
      'Synthesize a cross-memory reflection that combines episodic and declarative knowledge with source attribution.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic to reflect on.' },
        detailLevel: {
          type: 'string',
          enum: ['abstract', 'overview', 'full'],
          description: 'Detail level for episode summaries in the reflection.',
        },
        includeEpisodic: {
          type: 'boolean',
          description: 'Include episodic memory in reflection. Defaults to true.',
        },
        includeDeclarative: {
          type: 'boolean',
          description: 'Include declarative knowledge in reflection. Defaults to true.',
        },
        limit: { type: 'number', description: 'Max source items to consider.' },
        timeRange: {
          type: 'object',
          description: 'Restrict evidence to a time window (unix seconds).',
          properties: {
            start_at: { type: 'number' },
            end_at: { type: 'number' },
          },
        },
      },
      required: ['query'],
    },
  },
];

const CLAUDE_COGNITIVE_TOOLS: ClaudeToolDefinition[] = [
  {
    name: 'memory_search_cognitive',
    description:
      'Search memory using the cognitive taxonomy (episodic, semantic, procedural, working). Returns results grouped by cognitive type.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'working'] },
          description: 'Cognitive memory types to include. Defaults to all.',
        },
        limit: { type: 'number', description: 'Max results to return.' },
        minimumTrustScore: {
          type: 'number',
          description: 'Minimum trust score threshold (0-1).',
        },
        activeOnly: {
          type: 'boolean',
          description: 'Only return active memories. Defaults to true.',
        },
      },
      required: ['query'],
    },
  },
];

export function createClaudeMemoryTools(runtime: MemoryRuntime, manager?: MemoryManager) {
  const tools = [
    ...CLAUDE_MEMORY_TOOLS,
    ...(manager ? [...CLAUDE_EPISODIC_TOOLS, ...CLAUDE_COGNITIVE_TOOLS] : []),
  ];

  return {
    tools,
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

      if (manager) {
        if (name === 'memory_search_episodes') {
          return manager.searchEpisodes({
            query: String(args.query ?? ''),
            detailLevel: (args.detailLevel as EpisodeDetailLevel) ?? undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            timeRange: parseTimeRangeArg(args.timeRange),
          });
        }
        if (name === 'memory_summarize_episode') {
          return manager.summarizeEpisode(String(args.sessionId ?? ''), {
            detailLevel: (args.detailLevel as EpisodeDetailLevel) ?? undefined,
          });
        }
        if (name === 'memory_reflect') {
          return manager.reflect({
            query: String(args.query ?? ''),
            detailLevel: (args.detailLevel as EpisodeDetailLevel) ?? undefined,
            includeEpisodic:
              typeof args.includeEpisodic === 'boolean' ? args.includeEpisodic : undefined,
            includeDeclarative:
              typeof args.includeDeclarative === 'boolean' ? args.includeDeclarative : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            timeRange: parseTimeRangeArg(args.timeRange),
          });
        }
        if (name === 'memory_search_cognitive') {
          return manager.searchCognitive({
            query: String(args.query ?? ''),
            types: Array.isArray(args.types)
              ? (args.types as CognitiveMemoryType[])
              : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            minimumTrustScore:
              typeof args.minimumTrustScore === 'number' ? args.minimumTrustScore : undefined,
            activeOnly: typeof args.activeOnly === 'boolean' ? args.activeOnly : undefined,
          });
        }
      }

      throw new ValidationError(`Unknown Claude memory tool '${name}'`);
    },
  };
}

export type { ClaudeToolDefinition };
