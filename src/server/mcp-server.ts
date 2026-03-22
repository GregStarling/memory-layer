import {
  createMemoryWithAsyncAdapter,
  type CreateMemoryOptions,
} from '../core/quick.js';
import type { MemoryManager } from '../core/manager.js';
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { EmbeddingAdapter } from '../contracts/embedding.js';
import type { FactType, FactConfidence } from '../contracts/types.js';
import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';

export interface McpServerConfig {
  /** Database path. Defaults to ':memory:'. */
  dbPath?: string;
  /** Default scope for all operations. Can be overridden per-tool-call. */
  scope?: string | MemoryScope;
  /** Summarizer: 'extractive' | 'claude' | 'openai'. Defaults to 'extractive'. */
  summarizer?: CreateMemoryOptions['summarizer'];
  /** Extractor: 'regex' | 'claude' | 'openai' | false. Defaults to 'regex'. */
  extractor?: CreateMemoryOptions['extractor'];
  /** Preset: 'ai_ide' | 'chat_agent' | 'autonomous_agent'. */
  preset?: CreateMemoryOptions['preset'];
  /** Optional Postgres connection string for hosted deployments. */
  databaseUrl?: string;
  /** Quality mode applied to hosted managers. */
  qualityMode?: CreateMemoryOptions['qualityMode'];
  /** Legacy quality tier mapping. */
  qualityTier?: CreateMemoryOptions['qualityTier'];
  /** Cross-scope retrieval level for hosted managers. */
  crossScopeLevel?: ScopeLevel;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

class McpValidationError extends Error {}

const TOOLS: McpTool[] = [
  {
    name: 'memory_store_turn',
    description: 'Store a single conversation turn in memory.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Turn role' },
        content: { type: 'string', description: 'Turn content' },
        actor: { type: 'string', description: 'Optional actor name' },
      },
      required: ['role', 'content'],
    },
  },
  {
    name: 'memory_store_exchange',
    description: 'Store a user+assistant exchange atomically.',
    inputSchema: {
      type: 'object',
      properties: {
        userContent: { type: 'string', description: 'User message content' },
        assistantContent: { type: 'string', description: 'Assistant response content' },
      },
      required: ['userContent', 'assistantContent'],
    },
  },
  {
    name: 'memory_get_context',
    description: 'Retrieve assembled memory context for prompt injection. Returns active turns, working memory, relevant knowledge, objectives, and unresolved work.',
    inputSchema: {
      type: 'object',
      properties: {
        relevanceQuery: { type: 'string', description: 'Optional query to rank knowledge by relevance' },
      },
    },
  },
  {
    name: 'memory_search',
    description: 'Search across turns and knowledge using hybrid lexical+semantic retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_search_cross_scope',
    description: 'Search durable knowledge across collaboration, system, or tenant boundaries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scopeLevel: {
          type: 'string',
          enum: ['workspace', 'system', 'tenant'],
          description: 'Cross-scope level (default: workspace)',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_learn_fact',
    description: 'Manually add a durable knowledge fact.',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to store' },
        factType: {
          type: 'string',
          enum: ['preference', 'entity', 'decision', 'constraint', 'reference'],
          description: 'Fact classification',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Confidence level (default: high)',
        },
      },
      required: ['fact', 'factType'],
    },
  },
  {
    name: 'memory_track_work',
    description: 'Track an objective, unresolved work item, or constraint.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Work item title' },
        kind: { type: 'string', enum: ['objective', 'unresolved_work', 'constraint'], description: 'Item kind (default: objective)' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done'], description: 'Item status (default: open)' },
        detail: { type: 'string', description: 'Additional detail' },
      },
      required: ['title'],
    },
  },
  {
    name: 'memory_force_compact',
    description: 'Force compaction of conversation history into a summary.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_get_health',
    description: 'Get memory health report including compaction state and token estimates.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_run_maintenance',
    description: 'Run maintenance to expire stale data, retire unused knowledge, and clean up completed work items.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function jsonResult(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpValidationError(`Missing or invalid field: ${name}`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpValidationError(`Invalid field: ${name}`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new McpValidationError(`Invalid field: ${name}`);
  }
  return value as T;
}

function parseLimit(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new McpValidationError('Invalid field: limit');
  }
  return value;
}

function resolveScopeInput(
  fallbackScope: string | MemoryScope | undefined,
  args: Record<string, unknown>,
): string | MemoryScope {
  if (args.scope) {
    if (!isRecord(args.scope)) {
      throw new McpValidationError('Invalid scope override');
    }
    normalizeScope(args.scope as unknown as MemoryScope);
    return args.scope as unknown as MemoryScope;
  }
  return fallbackScope ?? 'default';
}

/**
 * Creates a standalone MCP server handler that exposes memory operations as tools.
 *
 * This function returns the tools list and a callTool dispatcher. It can be used
 * with any MCP transport (stdio, SSE, etc.).
 *
 * For a ready-to-run stdio server, use `startMcpServer()`.
 */
export function createMcpServerHandler(config: McpServerConfig = {}) {
  const managers = new Map<string, MemoryManager>();
  let adapterPromise: Promise<{
    asyncAdapter: AsyncStorageAdapter;
    embeddingAdapter?: EmbeddingAdapter;
  }> | null = null;

  async function getAsyncAdapter(): Promise<{
    asyncAdapter: AsyncStorageAdapter;
    embeddingAdapter?: EmbeddingAdapter;
  }> {
    if (!adapterPromise) {
      adapterPromise = (async () => {
        if (!config.databaseUrl && !process.env.MEMORY_DATABASE_URL) {
          const sqlite = createSQLiteAdapterWithEmbeddings(config.dbPath ?? ':memory:');
          return {
            asyncAdapter: wrapSyncAdapter(sqlite),
            embeddingAdapter: sqlite.embeddings,
          };
        }
        const moduleName = 'pg';
        const pgModule = await import(moduleName).catch(() => {
          throw new Error(
            'memory-layer: hosted Postgres mode requires the "pg" package. Install it with: npm install pg',
          );
        });
        const { createPostgresAdapter, createPostgresEmbeddingAdapter } = await import(
          '../adapters/postgres/index.js'
        );
        const Pool = pgModule.Pool ?? pgModule.default?.Pool;
        const pool = new Pool({
          connectionString: config.databaseUrl ?? process.env.MEMORY_DATABASE_URL,
        });
        const asyncAdapter = createPostgresAdapter(pool);
        return {
          asyncAdapter,
          embeddingAdapter: createPostgresEmbeddingAdapter(pool),
        };
      })();
    }
    return adapterPromise;
  }

  async function getManager(scopeInput: string | MemoryScope): Promise<MemoryManager> {
    const key =
      typeof scopeInput === 'string'
        ? `scope:${scopeInput}`
        : JSON.stringify(normalizeScope(scopeInput));
    const existing = managers.get(key);
    if (existing) return existing;
    const baseOptions: CreateMemoryOptions = {
      adapter: 'sqlite',
      path: config.dbPath ?? ':memory:',
      scope: scopeInput,
      summarizer: config.summarizer ?? 'extractive',
      extractor: config.extractor ?? 'regex',
      preset: config.preset,
      qualityMode: config.qualityMode,
      qualityTier: config.qualityTier,
      crossScopeLevel: config.crossScopeLevel,
    };
    const adapterContext = await getAsyncAdapter();
    const manager = createMemoryWithAsyncAdapter({
      ...baseOptions,
      asyncAdapter: adapterContext.asyncAdapter,
      embeddingAdapter: adapterContext.embeddingAdapter,
    });
    managers.set(key, manager);
    return manager;
  }
  const managerPromise = getManager(config.scope ?? 'default');

  async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      const requestManager = await getManager(resolveScopeInput(config.scope, args));
      switch (name) {
        case 'memory_store_turn': {
          const turn = await requestManager.processTurn(
            requireEnum(args.role, ['user', 'assistant', 'system'], 'role'),
            requireString(args.content, 'content'),
            optionalString(args.actor, 'actor'),
          );
          return jsonResult({ stored: true, turnId: turn.id });
        }
        case 'memory_store_exchange': {
          const exchange = await requestManager.processExchange(
            requireString(args.userContent, 'userContent'),
            requireString(args.assistantContent, 'assistantContent'),
          );
          return jsonResult({
            stored: true,
            userTurnId: exchange.userTurn.id,
            assistantTurnId: exchange.assistantTurn.id,
            compacted: exchange.compactionResult !== null,
          });
        }
        case 'memory_get_context': {
          const context = await requestManager.getContext(
            args.relevanceQuery ? String(args.relevanceQuery) : undefined,
          );
          return jsonResult({
            currentObjective: context.currentObjective,
            activeTurnCount: context.activeTurns.length,
            workingMemory: context.workingMemory
              ? {
                  summary: context.workingMemory.summary,
                  key_entities: context.workingMemory.key_entities,
                  topic_tags: context.workingMemory.topic_tags,
                }
              : null,
            relevantKnowledge: context.relevantKnowledge.map((k) => ({
              id: k.id,
              fact: k.fact,
              fact_type: k.fact_type,
              confidence: k.confidence,
            })),
            activeObjectives: context.activeObjectives.map((o) => ({
              title: o.title,
              status: o.status,
            })),
            unresolvedWork: context.unresolvedWork,
            tokenEstimate: context.tokenEstimate,
          });
        }
        case 'memory_search': {
          const results = await requestManager.search(
            requireString(args.query, 'query'),
            args.limit != null ? { limit: parseLimit(args.limit) } : undefined,
          );
          return jsonResult({
            turns: results.turns.map((r) => ({
              id: r.item.id,
              role: r.item.role,
              content: r.item.content,
              rank: r.rank,
            })),
            knowledge: results.knowledge.map((r) => ({
              id: r.item.id,
              fact: r.item.fact,
              fact_type: r.item.fact_type,
              rank: r.rank,
            })),
          });
        }
        case 'memory_search_cross_scope': {
          const results = await requestManager.searchCrossScope(
            requireString(args.query, 'query'),
            (args.scopeLevel == null
              ? 'workspace'
              : requireEnum(args.scopeLevel, ['workspace', 'system', 'tenant'], 'scopeLevel')) as ScopeLevel,
            args.limit != null ? { limit: parseLimit(args.limit) } : undefined,
          );
          return jsonResult({
            knowledge: results.knowledge.map((r) => ({
              id: r.item.id,
              fact: r.item.fact,
              fact_type: r.item.fact_type,
              scope_id: r.item.scope_id,
              collaboration_id: r.item.collaboration_id,
              rank: r.rank,
            })),
          });
        }
        case 'memory_learn_fact': {
          const fact = await requestManager.learnFact(
            requireString(args.fact, 'fact'),
            requireEnum(args.factType, ['preference', 'entity', 'decision', 'constraint', 'reference'], 'factType') as FactType,
            (args.confidence == null
              ? 'high'
              : requireEnum(args.confidence, ['high', 'medium', 'low'], 'confidence')) as FactConfidence,
          );
          return jsonResult({ stored: true, knowledgeId: fact.id });
        }
        case 'memory_track_work': {
          const item = await requestManager.trackWorkItem(
            requireString(args.title, 'title'),
            requireEnum(args.kind ?? 'objective', ['objective', 'unresolved_work', 'constraint'], 'kind') as
              | 'objective'
              | 'unresolved_work'
              | 'constraint',
            requireEnum(args.status ?? 'open', ['open', 'in_progress', 'blocked', 'done'], 'status') as
              | 'open'
              | 'in_progress'
              | 'blocked'
              | 'done',
            optionalString(args.detail, 'detail'),
          );
          return jsonResult({ tracked: true, workItemId: item.id });
        }
        case 'memory_force_compact': {
          const result = await requestManager.forceCompact();
          return jsonResult({
            compacted: result !== null,
            archivedTurnCount: result?.archivedTurnIds.length ?? 0,
          });
        }
        case 'memory_get_health': {
          const context = await requestManager.getContext();
          return jsonResult({
            activeTurnCount: context.activeTurns.length,
            tokenEstimate: context.tokenEstimate,
            knowledgeCount: context.relevantKnowledge.length,
            objectiveCount: context.activeObjectives.length,
            unresolvedWorkCount: context.unresolvedWork.length,
          });
        }
        case 'memory_run_maintenance': {
          const report = await requestManager.runMaintenance();
          return jsonResult({
            expiredWorkingMemory: report.expiredWorkingMemoryIds.length,
            retiredKnowledge: report.retiredKnowledgeIds.length,
            deletedWorkItems: report.deletedWorkItemIds.length,
          });
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    tools: TOOLS,
    callTool,
    manager: undefined,
    async close() {
      const manager = await managerPromise;
      for (const cachedManager of managers.values()) {
        await cachedManager.close();
      }
      managers.clear();
      await manager.close();
    },
  };
}

/**
 * Starts a stdio-based MCP server.
 * This is the entry point for `npx memory-layer serve`.
 */
export async function startMcpServer(config: McpServerConfig = {}): Promise<void> {
  const handler = createMcpServerHandler(config);

  // MCP over stdio protocol
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin });

  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n',
  );

  rl.on('line', async (line: string) => {
    try {
      const message = JSON.parse(line);

      if (message.method === 'initialize') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'memory-layer',
                version: '2.0.0',
              },
            },
          }) + '\n',
        );
        return;
      }

      if (message.method === 'tools/list') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: handler.tools,
            },
          }) + '\n',
        );
        return;
      }

      if (message.method === 'tools/call') {
        if (!isRecord(message.params)) {
          throw new McpValidationError('Invalid tools/call params');
        }
        const result = await handler.callTool(
          message.params.name,
          isRecord(message.params.arguments) ? message.params.arguments : {},
        );
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result,
          }) + '\n',
        );
        return;
      }

      // Respond to unknown methods
      if (message.id !== undefined) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`,
            },
          }) + '\n',
        );
      }
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: error instanceof McpValidationError ? -32602 : -32700,
            message: error instanceof Error ? error.message : String(error),
          },
        }) + '\n',
      );
    }
  });

  rl.on('close', async () => {
    await handler.close();
    process.exit(0);
  });
}

export { TOOLS as MCP_TOOLS };
export type { McpTool, McpToolResult };
