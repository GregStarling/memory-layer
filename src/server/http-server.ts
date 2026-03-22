import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createMemory, type CreateMemoryOptions } from '../core/quick.js';
import type { MemoryManager } from '../core/manager.js';
import { normalizeScope, type MemoryScope } from '../contracts/identity.js';
import type { FactType, FactConfidence } from '../contracts/types.js';
export interface HttpServerConfig {
  /** Port to listen on. Defaults to 3100. */
  port?: number;
  /** Database path. Defaults to ':memory:'. */
  dbPath?: string;
  /** Default scope. */
  scope?: string | MemoryScope;
  /** Summarizer type. */
  summarizer?: CreateMemoryOptions['summarizer'];
  /** Extractor type. */
  extractor?: CreateMemoryOptions['extractor'];
  /** Preset. */
  preset?: CreateMemoryOptions['preset'];
  /** API key for bearer token auth. If set, all requests require Authorization header. */
  apiKey?: string;
  /** Separate admin API key for compaction and maintenance endpoints. */
  adminApiKey?: string;
  /** Enable CORS headers. Defaults to true. */
  cors?: boolean;
  /** Host to bind to. Defaults to 127.0.0.1. */
  host?: string;
  /** Maximum accepted request body size in bytes. Defaults to 1 MiB. */
  bodyLimitBytes?: number;
  /** Optional redaction hook for stored turns/facts/work items. */
  redactText?: CreateMemoryOptions['redactText'];
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function writeError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message });
}

async function readBody(
  req: IncomingMessage,
  limitBytes = 1_048_576,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (!tooLarge) {
        chunks.push(chunk);
      }
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        tooLarge = true;
      }
    });
    req.on('end', () => {
      try {
        if (tooLarge) {
          reject(new Error('Request body too large'));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  const search = url.slice(idx + 1);
  for (const pair of search.split('&')) {
    const [key, value] = pair.split('=');
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
  }
  return params;
}

function resolveRequestScope(
  fallbackScope: string | MemoryScope | undefined,
  req: IncomingMessage,
  query: Record<string, string>,
  body?: Record<string, unknown>,
): string | MemoryScope {
  const bodyScope =
    body?.scope && typeof body.scope === 'object' ? (body.scope as MemoryScope) : undefined;
  if (bodyScope) {
    return bodyScope;
  }

  const headerScope = {
    tenant_id: req.headers['x-memory-tenant'],
    system_id: req.headers['x-memory-system'],
    workspace_id: req.headers['x-memory-workspace'],
    scope_id: req.headers['x-memory-scope'],
  };
  if (headerScope.tenant_id && headerScope.system_id && headerScope.scope_id) {
    return {
      tenant_id: String(headerScope.tenant_id),
      system_id: String(headerScope.system_id),
      workspace_id: headerScope.workspace_id ? String(headerScope.workspace_id) : undefined,
      scope_id: String(headerScope.scope_id),
    };
  }

  if (query.tenant_id && query.system_id && query.scope_id) {
    return {
      tenant_id: query.tenant_id,
      system_id: query.system_id,
      workspace_id: query.workspace_id,
      scope_id: query.scope_id,
    };
  }

  return fallbackScope ?? 'default';
}

/**
 * Creates and starts an HTTP server exposing memory operations as a REST API.
 *
 * Endpoints:
 * - POST /v1/turns          - Store a turn
 * - POST /v1/exchanges      - Store a user+assistant exchange
 * - GET  /v1/context        - Get assembled context
 * - GET  /v1/search         - Search turns and knowledge
 * - POST /v1/facts          - Learn a fact
 * - POST /v1/work           - Track a work item
 * - POST /v1/compact        - Force compaction
 * - GET  /v1/health         - Get health report
 * - POST /v1/maintenance    - Run maintenance
 * - GET  /v1/events         - SSE stream of memory events
 */
export async function startHttpServer(config: HttpServerConfig = {}): Promise<{
  server: ReturnType<typeof createServer>;
  manager: MemoryManager;
  close: () => Promise<void>;
}> {
  const port = config.port ?? 3100;
  const host = config.host ?? '127.0.0.1';
  const apiKey = config.apiKey ?? process.env.MEMORY_API_KEY;
  const adminApiKey = config.adminApiKey ?? process.env.MEMORY_ADMIN_API_KEY;
  const enableCors = config.cors ?? true;
  const bodyLimitBytes = config.bodyLimitBytes ?? 1_048_576;
  const managers = new Map<string, MemoryManager>();

  // SSE clients
  const sseClients = new Set<ServerResponse>();

  function getManager(scopeInput: string | MemoryScope): MemoryManager {
    const key =
      typeof scopeInput === 'string'
        ? `scope:${scopeInput}`
        : JSON.stringify(normalizeScope(scopeInput));
    const existing = managers.get(key);
    if (existing) {
      return existing;
    }

    const manager = createMemory({
      adapter: 'sqlite',
      path: config.dbPath ?? ':memory:',
      scope: scopeInput,
      summarizer: config.summarizer ?? 'extractive',
      extractor: config.extractor ?? 'regex',
      preset: config.preset,
      redactText: config.redactText,
      onEvent: (event) => {
        if (sseClients.size > 0) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          for (const client of sseClients) {
            client.write(data);
          }
        }
      },
    });
    managers.set(key, manager);
    return manager;
  }

  const manager = getManager(config.scope ?? 'default');

  const server = createServer(async (req, res) => {
    // CORS
    if (enableCors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth
    if (apiKey) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${apiKey}`) {
        writeError(res, 401, 'Unauthorized');
        return;
      }
    }

    const url = req.url ?? '/';
    const path = url.split('?')[0];
    const query = parseQuery(url);

    try {
      // POST /v1/turns
      if (path === '/v1/turns' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const turn = await requestManager.processTurn(
          body.role as 'user' | 'assistant' | 'system',
          String(body.content),
          body.actor ? String(body.actor) : undefined,
        );
        writeJson(res, 201, { turnId: turn.id, role: turn.role });
        return;
      }

      // POST /v1/exchanges
      if (path === '/v1/exchanges' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const exchange = await requestManager.processExchange(
          String(body.userContent),
          String(body.assistantContent),
        );
        writeJson(res, 201, {
          userTurnId: exchange.userTurn.id,
          assistantTurnId: exchange.assistantTurn.id,
          compacted: exchange.compactionResult !== null,
        });
        return;
      }

      // GET /v1/context
      if (path === '/v1/context' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const context = await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, {
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
        return;
      }

      // GET /v1/search
      if (path === '/v1/search' && req.method === 'GET') {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const results = await requestManager.search(
          query.q,
          query.limit ? { limit: Number(query.limit) } : undefined,
        );
        writeJson(res, 200, {
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
        return;
      }

      // POST /v1/facts
      if (path === '/v1/facts' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const fact = await requestManager.learnFact(
          String(body.fact),
          body.factType as FactType,
          (body.confidence as FactConfidence) ?? 'high',
        );
        writeJson(res, 201, { knowledgeId: fact.id });
        return;
      }

      // POST /v1/work
      if (path === '/v1/work' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const item = await requestManager.trackWorkItem(
          String(body.title),
          (body.kind as 'objective' | 'unresolved_work' | 'constraint') ?? 'objective',
          (body.status as 'open' | 'in_progress' | 'blocked' | 'done') ?? 'open',
          body.detail ? String(body.detail) : undefined,
        );
        writeJson(res, 201, { workItemId: item.id });
        return;
      }

      // POST /v1/compact
      if (path === '/v1/compact' && req.method === 'POST') {
        if (adminApiKey && req.headers['x-admin-key'] !== adminApiKey) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const result = await requestManager.forceCompact();
        writeJson(res, 200, {
          compacted: result !== null,
          archivedTurnCount: result?.archivedTurnIds.length ?? 0,
        });
        return;
      }

      // GET /v1/health
      if (path === '/v1/health' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const context = await requestManager.getContext();
        writeJson(res, 200, {
          activeTurnCount: context.activeTurns.length,
          tokenEstimate: context.tokenEstimate,
          knowledgeCount: context.relevantKnowledge.length,
          objectiveCount: context.activeObjectives.length,
          unresolvedWorkCount: context.unresolvedWork.length,
        });
        return;
      }

      if ((path === '/healthz' || path === '/readyz') && req.method === 'GET') {
        writeJson(res, 200, { ok: true, scopes: managers.size });
        return;
      }

      // POST /v1/maintenance
      if (path === '/v1/maintenance' && req.method === 'POST') {
        if (adminApiKey && req.headers['x-admin-key'] !== adminApiKey) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const report = await requestManager.runMaintenance();
        writeJson(res, 200, {
          expiredWorkingMemory: report.expiredWorkingMemoryIds.length,
          retiredKnowledge: report.retiredKnowledgeIds.length,
          deletedWorkItems: report.deletedWorkItemIds.length,
        });
        return;
      }

      // GET /v1/events (SSE)
      if (path === '/v1/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"type":"connected"}\n\n');
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      writeError(res, 404, `Not found: ${req.method} ${path}`);
    } catch (error) {
      writeError(
        res,
        500,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        manager,
        async close() {
          for (const client of sseClients) {
            client.end();
          }
          sseClients.clear();
          server.close();
          for (const cachedManager of managers.values()) {
            await cachedManager.close();
          }
          managers.clear();
        },
      });
    });
  });
}
