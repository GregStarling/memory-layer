import { createHash, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import {
  createMemoryWithAsyncAdapter,
  type CreateMemoryOptions,
} from '../core/quick.js';
import type { MemoryManager } from '../core/manager.js';
import type { MemoryContext } from '../core/context.js';
import type {
  TemporalIdInput,
  TemporalStateSnapshot,
  TimelineResult,
} from '../contracts/temporal.js';
import type {
  ActorRef,
  ContextViewPolicy,
  HandoffRecord,
  WorkClaim,
} from '../contracts/coordination.js';
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { EmbeddingAdapter } from '../contracts/embedding.js';
import { isMemoryDomainError } from '../contracts/errors.js';
import {
  MEMORY_EVENT_TYPES,
  type MemoryEvent,
  type MemoryEventType,
} from '../contracts/observability.js';
import type {
  FactType,
  FactConfidence,
  EpisodeDetailLevel,
  AssociationTargetKind,
  AssociationType,
} from '../contracts/types.js';
import { EPISODE_DETAIL_LEVELS, PLAYBOOK_STATUSES, ASSOCIATION_TYPES, ASSOCIATION_TARGET_KINDS } from '../contracts/types.js';
import { ACTOR_KINDS, CONTEXT_VIEW_POLICIES, MEMORY_VISIBILITY_CLASSES } from '../contracts/coordination.js';
import type { CognitiveMemoryType } from '../contracts/cognitive.js';
import type { ProfileSection, ProfileView } from '../contracts/profile.js';
import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
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
  /** Optional Postgres connection string for hosted deployments. */
  databaseUrl?: string;
  /** Quality mode applied to hosted managers. */
  qualityMode?: CreateMemoryOptions['qualityMode'];
  /** Legacy quality tier mapping. */
  qualityTier?: CreateMemoryOptions['qualityTier'];
  /** Cross-scope retrieval level for hosted managers. */
  crossScopeLevel?: ScopeLevel;
  /** Auto-detect workspace from git remote or cwd when no scope provided. */
  autoDetectWorkspace?: boolean;
  /** Structured generation client for episodic recall, playbooks, and reflect. */
  structuredClient?: CreateMemoryOptions['structuredClient'];
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_SNAPSHOT_LIMIT = 1000;
const PER_SCOPE_SESSION_SNAPSHOT_LIMIT = 10;
const MANAGER_CACHE_LIMIT = 256;
const SESSION_MANAGER_CACHE_LIMIT = 256;
const MAX_LIST_LIMIT = 100;

function safeSecretEquals(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const providedBuffer = createHash('sha256').update(provided).digest();
  const expectedBuffer = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedBuffer, expectedBuffer) && provided.length === expected.length;
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

function serializeContextResponse(
  context: MemoryContext,
  options: {
    includeDebug?: boolean;
    includeAssociatedKnowledge?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    currentObjective: context.currentObjective,
    sessionState: context.sessionState,
    activeTurnCount: context.activeTurns.length,
    workingMemory: context.workingMemory
      ? {
          summary: context.workingMemory.summary,
          key_entities: context.workingMemory.key_entities,
          topic_tags: context.workingMemory.topic_tags,
        }
      : null,
    relevantKnowledge: context.relevantKnowledge.map((knowledge) => ({
      id: knowledge.id,
      fact: knowledge.fact,
      fact_type: knowledge.fact_type,
      confidence: knowledge.confidence,
    })),
    activeObjectives: context.activeObjectives.map((objective) => ({
      id: objective.id,
      title: objective.title,
      status: objective.status,
      visibility_class: objective.visibility_class,
    })),
    associatedKnowledge: options.includeAssociatedKnowledge === false
      ? undefined
      : context.associatedKnowledge.map((knowledge) => ({
          id: knowledge.id,
          fact: knowledge.fact,
          fact_type: knowledge.fact_type,
          knowledge_class: knowledge.knowledge_class,
          trust_score: knowledge.trust_score,
        })),
    unresolvedWork: context.unresolvedWork,
    coordinationState: context.coordinationState
      ? {
          ownedClaims: context.coordinationState.ownedClaims.map(serializeWorkClaim),
          pendingInboundHandoffs: context.coordinationState.pendingInboundHandoffs.map(
            serializeHandoffRecord,
          ),
          pendingOutboundHandoffs: context.coordinationState.pendingOutboundHandoffs.map(
            serializeHandoffRecord,
          ),
          sharedWorkItems: context.coordinationState.sharedWorkItems.map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            visibility_class: item.visibility_class,
          })),
        }
      : null,
    tokenEstimate: context.tokenEstimate,
    ...(options.includeDebug
      ? {
          debugTrace: context.debugTrace,
          knowledgeSelectionReasons: context.knowledgeSelectionReasons,
        }
      : {}),
  };
}

function serializeActorRef(actor: ActorRef): Record<string, unknown> {
  return {
    actor_kind: actor.actor_kind,
    actor_id: actor.actor_id,
    system_id: actor.system_id,
    display_name: actor.display_name,
    metadata: actor.metadata,
  };
}

function serializeWorkClaim(claim: WorkClaim): Record<string, unknown> {
  return {
    id: claim.id,
    work_item_id: claim.work_item_id,
    actor: serializeActorRef(claim.actor),
    session_id: claim.session_id,
    claim_token: claim.claim_token,
    status: claim.status,
    claimed_at: claim.claimed_at,
    expires_at: claim.expires_at,
    released_at: claim.released_at,
    release_reason: claim.release_reason,
    visibility_class: claim.visibility_class,
    version: claim.version,
  };
}

function serializeHandoffRecord(handoff: HandoffRecord): Record<string, unknown> {
  return {
    id: handoff.id,
    work_item_id: handoff.work_item_id,
    from_actor: serializeActorRef(handoff.from_actor),
    to_actor: serializeActorRef(handoff.to_actor),
    session_id: handoff.session_id,
    summary: handoff.summary,
    context_bundle_ref: handoff.context_bundle_ref,
    status: handoff.status,
    created_at: handoff.created_at,
    accepted_at: handoff.accepted_at,
    rejected_at: handoff.rejected_at,
    canceled_at: handoff.canceled_at,
    expires_at: handoff.expires_at,
    decision_reason: handoff.decision_reason,
    visibility_class: handoff.visibility_class,
    version: handoff.version,
  };
}

function serializeTimelineResult(result: TimelineResult): Record<string, unknown> {
  return {
    events: result.events,
    nextCursor: result.nextCursor,
  };
}

function serializeTemporalState(
  state: TemporalStateSnapshot<MemoryContext>,
  options: { includeDebug?: boolean } = {},
): Record<string, unknown> {
  return {
    asOf: state.asOf,
    exact: state.exact,
    cutoverAt: state.cutoverAt,
    watermarkEventId: state.watermarkEventId,
    context: serializeContextResponse(state.context, {
      includeDebug: options.includeDebug,
    }),
    sessionState: state.sessionState,
    turns: state.turns,
    workingMemory: state.workingMemory,
    knowledge: state.knowledge,
    workItems: state.workItems,
    workClaims: state.workClaims.map(serializeWorkClaim),
    handoffs: state.handoffs.map(serializeHandoffRecord),
    coordinationState: state.coordinationState
      ? {
          ownedClaims: state.coordinationState.ownedClaims.map(serializeWorkClaim),
          pendingInboundHandoffs: state.coordinationState.pendingInboundHandoffs.map(
            serializeHandoffRecord,
          ),
          pendingOutboundHandoffs: state.coordinationState.pendingOutboundHandoffs.map(
            serializeHandoffRecord,
          ),
          sharedWorkItems: state.coordinationState.sharedWorkItems,
        }
      : null,
    associations: state.associations,
    playbooks: state.playbooks,
  };
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
          reject(new HttpRequestError(413, 'Request body too large'));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf-8');
        const parsed = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpRequestError(400, 'JSON body must be an object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpRequestError(400, 'Invalid JSON body'));
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
    try {
      const [key, value] = pair.split('=');
      if (key) params[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
    } catch {
      throw new HttpRequestError(400, 'Invalid query string');
    }
  }
  return params;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalTemporalId(value: string | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  return /^\d+$/.test(value.trim()) ? BigInt(value.trim()).toString() : undefined;
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpRequestError(400, `Missing or invalid field: ${name}`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpRequestError(400, `Invalid field: ${name}`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpRequestError(400, `Invalid field: ${name}`);
  }
  return value as T;
}

function parseContextViewPolicy(
  value: string | undefined,
  name = 'view',
): ContextViewPolicy | undefined {
  return value ? requireEnum(value, CONTEXT_VIEW_POLICIES, name) : undefined;
}

function parseViewerFromQuery(query: Record<string, string | undefined>): ActorRef | undefined {
  if (query.viewer_actor_id == null && query.viewer_actor_kind == null) return undefined;
  return parseActorRef(
    {
      actor_kind: query.viewer_actor_kind,
      actor_id: query.viewer_actor_id,
      system_id: query.viewer_system_id,
      display_name: query.viewer_display_name,
    },
    'viewer',
  );
}

function parseActorRef(value: unknown, name = 'actor'): ActorRef | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    throw new HttpRequestError(400, `Invalid field: ${name}`);
  }
  return {
    actor_kind: requireEnum(value.actor_kind, ACTOR_KINDS, `${name}.actor_kind`),
    actor_id: requireString(value.actor_id, `${name}.actor_id`),
    system_id: value.system_id == null ? null : requireString(value.system_id, `${name}.system_id`),
    display_name:
      value.display_name == null ? null : requireString(value.display_name, `${name}.display_name`),
    metadata: isRecord(value.metadata) ? value.metadata : null,
  };
}

function parseLimit(value: string | undefined): number | undefined {
  const parsed = parseOptionalInteger(value);
  if (value != null && parsed == null) {
    throw new HttpRequestError(400, 'Invalid limit parameter');
  }
  if (parsed != null && parsed > MAX_LIST_LIMIT) {
    throw new HttpRequestError(400, `Limit parameter exceeds maximum of ${MAX_LIST_LIMIT}`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HttpRequestError(400, `Invalid field: ${name} (must be a non-negative integer)`);
  }
  return value;
}

function parseScopeLevel(
  value: unknown,
  name: string,
  allowed: readonly ScopeLevel[] = ['scope', 'workspace', 'system', 'tenant'],
): ScopeLevel | undefined {
  if (value == null || value === '') return undefined;
  return requireEnum(value, allowed, name);
}

function resolvePartialScope(
  source: Record<string, unknown>,
  labels: [string, string, string],
): MemoryScope | undefined {
  const requiredValues = [source.tenant_id, source.system_id, source.scope_id];
  const provided = requiredValues.filter((value) => value != null && value !== '').length;
  if (provided === 0) {
    return undefined;
  }
  if (provided !== 3) {
    throw new HttpRequestError(400, `Incomplete scope override: ${labels.join(', ')}`);
  }
  return {
    tenant_id: requireString(source.tenant_id, labels[0]),
    system_id: requireString(source.system_id, labels[1]),
    workspace_id: optionalString(source.workspace_id, 'workspace_id'),
    collaboration_id: optionalString(source.collaboration_id, 'collaboration_id'),
    scope_id: requireString(source.scope_id, labels[2]),
  };
}

function parseEventTypes(value: string | undefined): Set<MemoryEventType> | undefined {
  if (!value) return undefined;
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => requireEnum(entry, MEMORY_EVENT_TYPES, 'event_types')),
  );
}

function resolveRequestScope(
  fallbackScope: string | MemoryScope | undefined,
  req: IncomingMessage,
  query: Record<string, string>,
  body?: Record<string, unknown>,
): string | MemoryScope {
  const bodyScope = body?.scope;
  if (bodyScope) {
    if (!isRecord(bodyScope)) {
      throw new HttpRequestError(400, 'Invalid scope override');
    }
    normalizeScope(bodyScope as unknown as MemoryScope);
    return bodyScope as unknown as MemoryScope;
  }

  const headerScope = resolvePartialScope(
    {
      tenant_id: req.headers['x-memory-tenant'],
      system_id: req.headers['x-memory-system'],
      workspace_id: req.headers['x-memory-workspace'],
      collaboration_id: req.headers['x-memory-collaboration'],
      scope_id: req.headers['x-memory-scope'],
    },
    ['x-memory-tenant', 'x-memory-system', 'x-memory-scope'],
  );
  if (headerScope) {
    normalizeScope(headerScope);
    return headerScope;
  }

  const queryScope = resolvePartialScope(
    {
      tenant_id: query.tenant_id,
      system_id: query.system_id,
      workspace_id: query.workspace_id,
      collaboration_id: query.collaboration_id,
      scope_id: query.scope_id,
    },
    ['tenant_id', 'system_id', 'scope_id'],
  );
  if (queryScope) {
    normalizeScope(queryScope);
    return queryScope;
  }

  return fallbackScope ?? 'default';
}

function materializeScope(scopeInput: string | MemoryScope): MemoryScope {
  return typeof scopeInput === 'string'
    ? {
        tenant_id: 'default',
        system_id: 'default',
        scope_id: scopeInput,
      }
    : scopeInput;
}

function cloneSnapshotValue<T>(value: T): T {
  return structuredClone(value);
}

function matchesEventScope(event: MemoryEvent, scope: MemoryScope, level: ScopeLevel): boolean {
  const left = normalizeScope(event.scope);
  const right = normalizeScope(scope);
  if (left.tenant_id !== right.tenant_id) return false;
  if (level === 'tenant') return true;
  // Collaboration scope is the explicit shared-memory boundary across systems,
  // so workspace-level collaboration listeners intentionally fan out across
  // system_id values when both sides are bound to the same collaboration.
  if (level === 'workspace' && left.collaboration_id && right.collaboration_id) {
    return left.collaboration_id === right.collaboration_id;
  }
  if (left.system_id !== right.system_id) return false;
  if (level === 'system') return true;
  if (level === 'workspace') {
    return left.workspace_id === right.workspace_id;
  }
  return left.workspace_id === right.workspace_id && left.scope_id === right.scope_id;
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
 * - GET  /v1/inspect/*      - Inspect knowledge, audits, monitor, and compactions
 * - POST /v1/reverification - Run reverification workflows
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
  // Managers keyed by (scope, sessionId) for snapshot endpoints that must
  // honor the URL-path session instead of the scope's bound default session.
  const sessionManagers = new Map<string, MemoryManager>();
  // Insertion-ordered LRU: Map preserves insertion order; we delete+re-set on
  // access to refresh recency and evict the oldest when the cap is exceeded.
  type SessionSnapshotCacheEntry = {
    scopeKey: string;
    snapshotId: string;
    bootstrap: unknown;
    context: unknown;
    frozenAt: number;
    watermarkEventId: string | null;
  };
  const sessionSnapshots = new Map<string, SessionSnapshotCacheEntry>();
  function touchManagerCache(
    cache: Map<string, MemoryManager>,
    key: string,
    manager: MemoryManager,
    limit: number,
  ): void {
    cache.delete(key);
    cache.set(key, manager);
    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }
  function touchSnapshot(key: string, snapshot: SessionSnapshotCacheEntry): void {
    const cachedSnapshot = cloneSnapshotValue(snapshot);
    sessionSnapshots.delete(key);
    sessionSnapshots.set(key, cachedSnapshot);
    const scopeEntries = [...sessionSnapshots.entries()].filter(
      ([, value]) => value.scopeKey === cachedSnapshot.scopeKey,
    );
    while (scopeEntries.length > PER_SCOPE_SESSION_SNAPSHOT_LIMIT) {
      const [oldestKey] = scopeEntries.shift() ?? [];
      if (!oldestKey) break;
      sessionSnapshots.delete(oldestKey);
    }
    while (sessionSnapshots.size > SESSION_SNAPSHOT_LIMIT) {
      const oldest = sessionSnapshots.keys().next().value;
      if (oldest === undefined) break;
      sessionSnapshots.delete(oldest);
    }
  }
  function readSnapshot(key: string): SessionSnapshotCacheEntry | undefined {
    const snapshot = sessionSnapshots.get(key);
    if (!snapshot) return undefined;
    // Refresh LRU recency
    sessionSnapshots.delete(key);
    sessionSnapshots.set(key, snapshot);
    return cloneSnapshotValue(snapshot);
  }
  const databaseUrl = config.databaseUrl ?? process.env.MEMORY_DATABASE_URL;

  const adapterResources: {
    asyncAdapter: AsyncStorageAdapter;
    embeddingAdapter?: EmbeddingAdapter;
    close: () => Promise<void>;
  } = databaseUrl
    ? await (async () => {
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
        const pool = new Pool({ connectionString: databaseUrl });
        const asyncAdapter = createPostgresAdapter(pool, { ownsPool: false });
        return {
          asyncAdapter,
          embeddingAdapter: createPostgresEmbeddingAdapter(pool),
          close: async () => {
            await pool.end();
          },
        };
      })()
    : (() => {
        const sqlite = createSQLiteAdapterWithEmbeddings(config.dbPath ?? ':memory:');
        return {
          asyncAdapter: wrapSyncAdapter(sqlite),
          embeddingAdapter: sqlite.embeddings,
          close: async () => {
            sqlite.close();
          },
        };
      })();

  const sseClients = new Set<{
    response: ServerResponse;
    scope?: MemoryScope;
    scopeLevel?: ScopeLevel;
    eventTypes?: Set<MemoryEventType>;
  }>();

  function buildHostedManagerOptions(
    scopeInput: string | MemoryScope,
    sessionId?: string,
  ): Omit<CreateMemoryOptions, 'adapter' | 'path'> {
    return {
      scope: scopeInput,
      ...(sessionId ? { sessionId } : {}),
      summarizer: config.summarizer ?? 'extractive',
      extractor: config.extractor ?? 'regex',
      preset: config.preset,
      redactText: config.redactText,
      qualityMode: config.qualityMode,
      qualityTier: config.qualityTier,
      crossScopeLevel: config.crossScopeLevel,
      autoDetectWorkspace: config.autoDetectWorkspace,
      structuredClient: config.structuredClient,
    };
  }

  function createHostedManager(scopeInput: string | MemoryScope): MemoryManager {
    const baseOptions: CreateMemoryOptions = {
      ...buildHostedManagerOptions(scopeInput),
      onEvent: (event) => {
        if (sseClients.size === 0) return;
        const data = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of sseClients) {
          if (client.eventTypes && !client.eventTypes.has(event.type)) continue;
          if (client.scope && client.scopeLevel) {
            if (!matchesEventScope(event, client.scope, client.scopeLevel)) continue;
          }
          client.response.write(data);
        }
      },
    };

    return createMemoryWithAsyncAdapter({
      ...baseOptions,
      asyncAdapter: adapterResources.asyncAdapter,
      embeddingAdapter: adapterResources.embeddingAdapter,
      closeAdapter: false,
    });
  }

  function getManager(scopeInput: string | MemoryScope): MemoryManager {
    const key =
      typeof scopeInput === 'string'
        ? `scope:${scopeInput}`
        : JSON.stringify(normalizeScope(scopeInput));
    const existing = managers.get(key);
    if (existing) {
      touchManagerCache(managers, key, existing, MANAGER_CACHE_LIMIT);
      return existing;
    }

    const manager = createHostedManager(scopeInput);
    touchManagerCache(managers, key, manager, MANAGER_CACHE_LIMIT);
    return manager;
  }

  function scopeKeyFor(scopeInput: string | MemoryScope): string {
    return typeof scopeInput === 'string'
      ? `scope:${scopeInput}`
      : JSON.stringify(normalizeScope(scopeInput));
  }

  /**
   * Get a manager bound to a specific sessionId under the given scope.
   * Snapshot endpoints use this so POST/GET/REFRESH against different URL
   * :sessionId values read from the correct session, not the scope's default.
   */
  function getSessionManager(scopeInput: string | MemoryScope, sessionId: string): MemoryManager {
    const key = `${scopeKeyFor(scopeInput)}|session:${sessionId}`;
    const existing = sessionManagers.get(key);
    if (existing) {
      touchManagerCache(sessionManagers, key, existing, SESSION_MANAGER_CACHE_LIMIT);
      return existing;
    }

    const baseOptions: CreateMemoryOptions = buildHostedManagerOptions(scopeInput, sessionId);
    const manager = createMemoryWithAsyncAdapter({
      ...baseOptions,
      asyncAdapter: adapterResources.asyncAdapter,
      embeddingAdapter: adapterResources.embeddingAdapter,
      closeAdapter: false,
    });
    touchManagerCache(sessionManagers, key, manager, SESSION_MANAGER_CACHE_LIMIT);
    return manager;
  }

  const manager = getManager(config.scope ?? 'default');

  const server = createServer(async (req, res) => {
    // CORS
    if (enableCors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-admin-key, x-memory-tenant, x-memory-system, x-memory-workspace, x-memory-collaboration, x-memory-scope, Last-Event-ID',
      );
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth
    if (apiKey) {
      const auth = req.headers.authorization;
      if (!safeSecretEquals(auth, `Bearer ${apiKey}`)) {
        writeError(res, 401, 'Unauthorized');
        return;
      }
    }

    try {
      const url = req.url ?? '/';
      const path = normalizePath(url.split('?')[0]);
      const query = parseQuery(url);

      // POST /v1/turns
      if (path === '/v1/turns' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const turn = await requestManager.processTurn(
          requireEnum(body.role, ['user', 'assistant', 'system'], 'role'),
          requireString(body.content, 'content'),
          optionalString(body.actor, 'actor'),
        );
        writeJson(res, 201, { turnId: turn.id, role: turn.role });
        return;
      }

      // POST /v1/exchanges
      if (path === '/v1/exchanges' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const exchange = await requestManager.processExchange(
          requireString(body.userContent, 'userContent'),
          requireString(body.assistantContent, 'assistantContent'),
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
        const context = await requestManager.getContext(query.query || undefined, {
          view: parseContextViewPolicy(query.view),
          viewer: parseViewerFromQuery(query),
          includeCoordinationState: query.include_coordination === 'true',
        });
        writeJson(res, 200, serializeContextResponse(context, {
          includeDebug: query.debug === 'true',
        }));
        return;
      }

      // GET /v1/state
      if (path === '/v1/state' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const asOf = query.as_of != null ? Number(query.as_of) : undefined;
        if (asOf == null || !Number.isFinite(asOf)) {
          writeError(res, 400, 'Missing or invalid as_of parameter');
          return;
        }
        const state = await requestManager.getStateAt(asOf, {
          relevanceQuery: query.query || undefined,
          view: parseContextViewPolicy(query.view),
          viewer: parseViewerFromQuery(query),
          includeCoordinationState: query.include_coordination === 'true',
        });
        writeJson(res, 200, serializeTemporalState(state, {
          includeDebug: query.include_debug === 'true',
        }));
        return;
      }

      // GET /v1/timeline
      if (path === '/v1/timeline' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const startAt = query.start_at != null ? Number(query.start_at) : undefined;
        const endAt = query.end_at != null ? Number(query.end_at) : undefined;
        const cursor = parseOptionalTemporalId(query.cursor);
        const limit = parseLimit(query.limit);
        if (
          (query.start_at != null && !Number.isFinite(startAt)) ||
          (query.end_at != null && !Number.isFinite(endAt)) ||
          (query.cursor != null && cursor == null)
        ) {
          writeError(res, 400, 'Invalid timeline parameters');
          return;
        }
        const timeline = await requestManager.getTimeline({
          sessionId: query.session_id || undefined,
          entityKind: query.entity_kind as never,
          entityId: query.entity_id || undefined,
          startAt,
          endAt,
          limit,
          cursor,
        });
        writeJson(res, 200, serializeTimelineResult(timeline));
        return;
      }

      // GET /v1/state/diff
      if (path === '/v1/state/diff' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const from = query.from != null ? Number(query.from) : undefined;
        const to = query.to != null ? Number(query.to) : undefined;
        if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) {
          writeError(res, 400, 'Missing or invalid from/to parameters');
          return;
        }
        const diff = await requestManager.diffState(from, to, {
          sessionId: query.session_id || undefined,
          entityKind: query.entity_kind as never,
          entityId: query.entity_id || undefined,
        });
        writeJson(res, 200, diff);
        return;
      }

      // GET /v1/events/log
      if (path === '/v1/events/log' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const startAt = query.start_at != null ? Number(query.start_at) : undefined;
        const endAt = query.end_at != null ? Number(query.end_at) : undefined;
        const cursor = parseOptionalTemporalId(query.cursor);
        const limit = parseLimit(query.limit);
        if (
          (query.start_at != null && !Number.isFinite(startAt)) ||
          (query.end_at != null && !Number.isFinite(endAt)) ||
          (query.cursor != null && cursor == null)
        ) {
          writeError(res, 400, 'Invalid event log parameters');
          return;
        }
        const events = await requestManager.listMemoryEvents({
          sessionId: query.session_id || undefined,
          entityKind: query.entity_kind as never,
          entityId: query.entity_id || undefined,
          startAt,
          endAt,
          limit,
          cursor,
        });
        writeJson(res, 200, serializeTimelineResult(events));
        return;
      }

      // GET /v1/changes/stream
      if (path === '/v1/changes/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        let closed = false;
        const abortController = new AbortController();
        req.on('close', () => {
          closed = true;
          abortController.abort();
        });
        const cursor = parseOptionalTemporalId(query.cursor);
        const initialCursor = await requestManager.resolveChangeStreamCursor(cursor);
        const iterator = requestManager.streamChanges({
          cursor,
          sessionId: query.session_id || undefined,
          entityKind: query.entity_kind as never,
          entityId: query.entity_id || undefined,
          pollIntervalMs: 250,
          signal: abortController.signal,
        });
        void (async () => {
          res.write(`data: ${JSON.stringify({ type: 'connected', cursor: initialCursor })}\n\n`);
          try {
            for await (const event of iterator) {
              if (closed) break;
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          } catch (error) {
            if (!closed) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: String(error) })}\n\n`);
              res.end();
            }
          }
        })();
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
          query.limit ? { limit: parseLimit(query.limit) } : undefined,
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

      // GET /v1/search/cross-scope
      if (path === '/v1/search/cross-scope' && req.method === 'GET') {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const scopeLevel = parseScopeLevel(query.scope_level, 'scope_level', [
          'workspace',
          'system',
          'tenant',
        ]) ?? 'workspace';
        const results = await requestManager.searchCrossScope(
          query.q,
          scopeLevel,
          query.limit ? { limit: parseLimit(query.limit) } : undefined,
        );
        writeJson(res, 200, {
          knowledge: results.knowledge.map((r) => ({
            id: r.item.id,
            fact: r.item.fact,
            fact_type: r.item.fact_type,
            scope_id: r.item.scope_id,
            collaboration_id: r.item.collaboration_id,
            rank: r.rank,
          })),
        });
        return;
      }

      // GET /v1/inspect/knowledge
      if (path === '/v1/inspect/knowledge' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const limit = parseLimit(query.limit);
        const cursor = parseOptionalInteger(query.cursor);
        if ((query.limit && limit == null) || (query.cursor && cursor == null)) {
          writeError(res, 400, 'Invalid pagination parameters');
          return;
        }
        const knowledge = await requestManager.listKnowledge({
          limit,
          cursor,
        });
        writeJson(res, 200, knowledge);
        return;
      }

      const knowledgeInspectMatch = path.match(/^\/v1\/inspect\/knowledge\/(\d+)$/);
      if (knowledgeInspectMatch && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const detail = await requestManager.inspectKnowledge(Number(knowledgeInspectMatch[1]));
        if (!detail.knowledge) {
          writeError(res, 404, 'Knowledge not found');
          return;
        }
        writeJson(res, 200, detail);
        return;
      }

      // GET /v1/inspect/audits
      if (path === '/v1/inspect/audits' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const knowledgeId = parseOptionalInteger(query.knowledge_id);
        const limit = parseLimit(query.limit);
        if ((query.knowledge_id && knowledgeId == null) || (query.limit && limit == null)) {
          writeError(res, 400, 'Invalid audit inspection parameters');
          return;
        }
        const audits = await requestManager.getKnowledgeAudits({
          knowledgeId,
          limit,
        });
        writeJson(res, 200, { audits });
        return;
      }

      // GET /v1/inspect/monitor
      if (path === '/v1/inspect/monitor' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const [monitor, diagnostics] = await Promise.all([
          requestManager.getContextMonitor(),
          requestManager.getRuntimeDiagnostics(),
        ]);
        writeJson(res, 200, { monitor, diagnostics });
        return;
      }

      // GET /v1/inspect/compactions
      if (path === '/v1/inspect/compactions' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const limit = parseLimit(query.limit);
        if (query.limit && limit == null) {
          writeError(res, 400, 'Invalid compaction inspection parameters');
          return;
        }
        const logs = await requestManager.getRecentCompactionLogs(limit);
        writeJson(res, 200, { logs });
        return;
      }

      // GET /v1/inspect/context
      if (path === '/v1/inspect/context' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const asOf = query.as_of != null ? Number(query.as_of) : undefined;
        if (query.as_of != null && !Number.isFinite(asOf)) {
          writeError(res, 400, 'Invalid as_of parameter');
          return;
        }
        const context = asOf != null
          ? await requestManager.getContextAt(asOf, query.query || undefined)
          : await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, serializeContextResponse(context, { includeDebug: true }));
        return;
      }

      // GET /v1/inspect/session-state
      if (path === '/v1/inspect/session-state' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const asOf = query.as_of != null ? Number(query.as_of) : undefined;
        if (query.as_of != null && !Number.isFinite(asOf)) {
          writeError(res, 400, 'Invalid as_of parameter');
          return;
        }
        const context = asOf != null
          ? await requestManager.getContextAt(asOf, query.query || undefined)
          : await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, { sessionState: context.sessionState });
        return;
      }

      // GET /v1/inspect/retrieval
      if (path === '/v1/inspect/retrieval' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const asOf = query.as_of != null ? Number(query.as_of) : undefined;
        if (query.as_of != null && !Number.isFinite(asOf)) {
          writeError(res, 400, 'Invalid as_of parameter');
          return;
        }
        const context = asOf != null
          ? await requestManager.getContextAt(asOf, query.query || undefined)
          : await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, {
          sessionState: context.sessionState,
          knowledgeSelectionReasons: context.knowledgeSelectionReasons,
          debugTrace: context.debugTrace,
        });
        return;
      }

      // GET /v1/inspect/reverification
      if (path === '/v1/inspect/reverification' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const limit = parseOptionalInteger(query.limit);
        if (query.limit && limit == null) {
          writeError(res, 400, 'Invalid reverification inspection parameters');
          return;
        }
        const due = await requestManager.getDueReverification({ limit });
        writeJson(res, 200, { due });
        return;
      }

      // POST /v1/facts
      if (path === '/v1/facts' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const fact = await requestManager.learnFact(
          requireString(body.fact, 'fact'),
          requireEnum(body.factType, ['preference', 'entity', 'decision', 'constraint', 'reference'], 'factType') as FactType,
          (body.confidence == null
            ? 'high'
            : requireEnum(body.confidence, ['high', 'medium', 'low'], 'confidence')) as FactConfidence,
        );
        writeJson(res, 201, { knowledgeId: fact.id });
        return;
      }

      // POST /v1/work
      if (path === '/v1/work' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const item = await requestManager.trackWorkItem(
          requireString(body.title, 'title'),
          requireEnum(body.kind ?? 'objective', ['objective', 'unresolved_work', 'constraint'], 'kind') as
            | 'objective'
            | 'unresolved_work'
            | 'constraint',
          requireEnum(body.status ?? 'open', ['open', 'in_progress', 'blocked', 'done'], 'status') as
            | 'open'
            | 'in_progress'
            | 'blocked'
            | 'done',
          optionalString(body.detail, 'detail'),
          {
            visibilityClass:
              body.visibility_class == null
                ? undefined
                : requireEnum(
                    body.visibility_class,
                    MEMORY_VISIBILITY_CLASSES,
                    'visibility_class',
                  ),
          },
        );
        writeJson(res, 201, { workItemId: item.id });
        return;
      }

      const workItemMatch = path.match(/^\/v1\/work-items\/(\d+)$/);
      if (workItemMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const item = await requestManager.updateWorkItem(
          Number(workItemMatch[1]),
          {
            title: body.title != null ? requireString(body.title, 'title') : undefined,
            detail: body.detail != null ? optionalString(body.detail, 'detail') ?? null : undefined,
            status:
              body.status != null
                ? (requireEnum(body.status, ['open', 'in_progress', 'blocked', 'done'], 'status') as
                    | 'open'
                    | 'in_progress'
                    | 'blocked'
                    | 'done')
                : undefined,
            visibility_class:
              body.visibility_class != null
                ? requireEnum(body.visibility_class, MEMORY_VISIBILITY_CLASSES, 'visibility_class')
                : undefined,
          },
          {
            expectedVersion:
              body.expectedVersion != null ? Number(body.expectedVersion) : undefined,
          },
        );
        writeJson(res, 200, { workItem: item });
        return;
      }

      const claimMatch = path.match(/^\/v1\/work-items\/(\d+)\/claim$/);
      if (claimMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const claim = await requestManager.claimWorkItem({
          workItemId: Number(claimMatch[1]),
          actor,
          leaseSeconds: body.leaseSeconds != null ? Number(body.leaseSeconds) : undefined,
        });
        writeJson(res, 200, { claim: serializeWorkClaim(claim) });
        return;
      }

      const renewMatch = path.match(/^\/v1\/work-claims\/(\d+)\/renew$/);
      if (renewMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const claim = await requestManager.renewWorkClaim(
          Number(renewMatch[1]),
          actor,
          body.leaseSeconds != null ? Number(body.leaseSeconds) : undefined,
        );
        writeJson(res, 200, { claim: claim ? serializeWorkClaim(claim) : null });
        return;
      }

      const releaseMatch = path.match(/^\/v1\/work-claims\/(\d+)\/release$/);
      if (releaseMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const claim = await requestManager.releaseWorkClaim(
          Number(releaseMatch[1]),
          actor,
          optionalString(body.reason, 'reason'),
        );
        writeJson(res, 200, { claim: claim ? serializeWorkClaim(claim) : null });
        return;
      }

      if (path === '/v1/work-claims' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const claims = await requestManager.listWorkClaims();
        writeJson(res, 200, { claims: claims.map(serializeWorkClaim) });
        return;
      }

      const handoffCreateMatch = path.match(/^\/v1\/work-items\/(\d+)\/handoffs$/);
      if (handoffCreateMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const fromActor = parseActorRef(body.from_actor, 'from_actor');
        const toActor = parseActorRef(body.to_actor, 'to_actor');
        if (!fromActor || !toActor) {
          writeError(res, 400, 'Missing required field: from_actor/to_actor');
          return;
        }
        const handoff = await requestManager.handoffWorkItem({
          workItemId: Number(handoffCreateMatch[1]),
          fromActor,
          toActor,
          summary: requireString(body.summary, 'summary'),
          contextBundleRef: optionalString(body.context_bundle_ref, 'context_bundle_ref') ?? null,
          expiresAt: body.expires_at != null ? Number(body.expires_at) : null,
        });
        writeJson(res, 201, { handoff: serializeHandoffRecord(handoff) });
        return;
      }

      const handoffActionMatch = path.match(/^\/v1\/handoffs\/(\d+)\/(accept|reject|cancel)$/);
      if (handoffActionMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const id = Number(handoffActionMatch[1]);
        const action = handoffActionMatch[2];
        const reason = optionalString(body.reason, 'reason');
        const handoff =
          action === 'accept'
            ? await requestManager.acceptHandoff(id, actor, reason)
            : action === 'reject'
              ? await requestManager.rejectHandoff(id, actor, reason)
              : await requestManager.cancelHandoff(id, actor, reason);
        writeJson(res, 200, { handoff: handoff ? serializeHandoffRecord(handoff) : null });
        return;
      }

      if (path === '/v1/handoffs' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const handoffs = await requestManager.listPendingHandoffs({
          direction: (query.direction as 'inbound' | 'outbound' | 'all' | undefined) ?? 'all',
        });
        writeJson(res, 200, { handoffs: handoffs.map(serializeHandoffRecord) });
        return;
      }

      // POST /v1/compact
      if (path === '/v1/compact' && req.method === 'POST') {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
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
        const [context, diagnostics] = await Promise.all([
          requestManager.getContext(),
          requestManager.getRuntimeDiagnostics(),
        ]);
        writeJson(res, 200, {
          activeTurnCount: context.activeTurns.length,
          tokenEstimate: context.tokenEstimate,
          knowledgeCount: context.relevantKnowledge.length,
          objectiveCount: context.activeObjectives.length,
          unresolvedWorkCount: context.unresolvedWork.length,
          sessionStateUpdatedAt: context.sessionState.updatedAt,
          circuitBreakers: diagnostics.circuitBreakers,
        });
        return;
      }

      if ((path === '/healthz' || path === '/readyz') && req.method === 'GET') {
        writeJson(res, 200, { ok: true, scopes: managers.size });
        return;
      }

      // POST /v1/maintenance
      if (path === '/v1/maintenance' && req.method === 'POST') {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
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

      const reverificationMatch = path.match(/^\/v1\/reverification\/(\d+)$/);
      if (reverificationMatch && req.method === 'POST') {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const result = await requestManager.reverifyKnowledge(Number(reverificationMatch[1]));
        writeJson(res, 200, result);
        return;
      }

      // POST /v1/reverification/run
      if (path === '/v1/reverification/run' && req.method === 'POST') {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        let limit: number | undefined;
        if (body.limit != null) {
          if (typeof body.limit !== 'number' || !Number.isInteger(body.limit)) {
            throw new HttpRequestError(400, 'Invalid field: limit');
          }
          limit = body.limit;
        }
        const report = await requestManager.runReverification({ limit });
        writeJson(res, 200, report);
        return;
      }

      // GET /v1/changes
      if (path === '/v1/changes' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const sinceValue = query.since ? new Date(query.since) : new Date(0);
        if (Number.isNaN(sinceValue.valueOf())) {
          writeError(res, 400, 'Invalid since parameter');
          return;
        }
        const changes = await requestManager.pollForChanges(sinceValue, {
          scopeLevel: parseScopeLevel(query.scope_level, 'scope_level') ?? 'scope',
        });
        writeJson(res, 200, {
          changes: changes.map((knowledge) => ({
            id: knowledge.id,
            fact: knowledge.fact,
            fact_type: knowledge.fact_type,
            knowledge_state: knowledge.knowledge_state,
            scope_id: knowledge.scope_id,
            collaboration_id: knowledge.collaboration_id,
            created_at: knowledge.created_at,
          })),
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
        const scope = resolveRequestScope(config.scope, req, query);
        sseClients.add({
          response: res,
          scope: materializeScope(scope),
          scopeLevel: parseScopeLevel(query.scope_level, 'scope_level') ?? 'scope',
          eventTypes: parseEventTypes(query.event_types),
        });
        req.on('close', () => {
          for (const client of sseClients) {
            if (client.response === res) {
              sseClients.delete(client);
            }
          }
        });
        return;
      }

      // GET /v1/episodes
      if (path === '/v1/episodes' && req.method === 'GET') {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const detailLevel = query.detail
          ? requireEnum(query.detail, EPISODE_DETAIL_LEVELS, 'detail')
          : undefined;
        const episodeTimeRange = (query.start_at || query.end_at)
          ? {
              start_at: query.start_at ? Number(query.start_at) : undefined,
              end_at: query.end_at ? Number(query.end_at) : undefined,
            }
          : undefined;
        const episodes = await requestManager.searchEpisodes({
          query: query.q,
          detailLevel,
          limit: parseLimit(query.limit),
          timeRange: episodeTimeRange,
        });
        writeJson(res, 200, { episodes });
        return;
      }

      // POST /v1/episodes/summarize
      if (path === '/v1/episodes/summarize' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const sessionId = requireString(body.session_id, 'session_id');
        const detailLevel = body.detailLevel
          ? requireEnum(body.detailLevel, EPISODE_DETAIL_LEVELS, 'detailLevel')
          : undefined;
        const summary = await requestManager.summarizeEpisode(sessionId, { detailLevel });
        writeJson(res, 200, { episode: summary });
        return;
      }

      // POST /v1/reflect
      if (path === '/v1/reflect' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const reflectQuery = requireString(body.query, 'query');
        const detailLevel = body.detailLevel
          ? requireEnum(body.detailLevel, EPISODE_DETAIL_LEVELS, 'detailLevel')
          : undefined;
        const includeDeclarative = body.includeDeclarative != null ? Boolean(body.includeDeclarative) : undefined;
        const includeEpisodic = body.includeEpisodic != null ? Boolean(body.includeEpisodic) : undefined;
        const reflectLimit = parseOptionalNonNegativeInteger(body.limit, 'limit');
        const timeRange = isRecord(body.timeRange)
          ? {
              start_at: typeof body.timeRange.start_at === 'number' ? body.timeRange.start_at : undefined,
              end_at: typeof body.timeRange.end_at === 'number' ? body.timeRange.end_at : undefined,
            }
          : undefined;
        const result = await requestManager.reflect({
          query: reflectQuery,
          detailLevel,
          includeDeclarative,
          includeEpisodic,
          limit: reflectLimit,
          timeRange,
        });
        writeJson(res, 200, result);
        return;
      }

      // GET /v1/memory
      if (path === '/v1/memory' && req.method === 'GET') {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const types = query.types
          ? (query.types.split(',').map((t) => t.trim()).filter(Boolean) as CognitiveMemoryType[])
          : undefined;
        const cogMinTrust = query.minimumTrustScore != null && query.minimumTrustScore !== ''
          ? Number(query.minimumTrustScore)
          : undefined;
        const cogActiveOnly = query.activeOnly != null
          ? query.activeOnly === 'true'
          : undefined;
        const result = await requestManager.searchCognitive({
          query: query.q,
          types,
          limit: parseLimit(query.limit),
          minimumTrustScore: cogMinTrust,
          activeOnly: cogActiveOnly,
        });
        writeJson(res, 200, result);
        return;
      }

      // GET /v1/profile
      if (path === '/v1/profile' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const validViews: ProfileView[] = ['user', 'operator', 'workspace'];
        const view = query.view
          ? requireEnum(query.view, validViews, 'view')
          : undefined;
        const validSections: ProfileSection[] = ['identity', 'preferences', 'communication', 'constraints', 'workflows'];
        const sections = query.sections
          ? query.sections.split(',').map((s) => requireEnum(s.trim(), validSections, 'sections'))
          : undefined;
        const minTrust = query.min_trust != null && query.min_trust !== ''
          ? Number(query.min_trust)
          : undefined;
        if (minTrust != null && Number.isNaN(minTrust)) {
          writeError(res, 400, 'Invalid min_trust parameter');
          return;
        }
        const includeProvisional = query.includeProvisional === 'true' ? true : undefined;
        const includeDisputed = query.includeDisputed === 'true' ? true : undefined;
        const profile = await requestManager.getProfile({
          view,
          sections,
          minimumTrustScore: minTrust,
          includeProvisional,
          includeDisputed,
        });
        writeJson(res, 200, { profile });
        return;
      }

      // POST /v1/playbooks
      if (path === '/v1/playbooks' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const playbook = await requestManager.createPlaybook({
          title: requireString(body.title, 'title'),
          description: requireString(body.description, 'description'),
          instructions: requireString(body.instructions, 'instructions'),
          references: Array.isArray(body.references) ? body.references.map(String) : undefined,
          templates: Array.isArray(body.templates) ? body.templates.map(String) : undefined,
          scripts: Array.isArray(body.scripts) ? body.scripts.map(String) : undefined,
          assets: Array.isArray(body.assets) ? body.assets.map(String) : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          status: body.status ? requireEnum(body.status, PLAYBOOK_STATUSES, 'status') : undefined,
        });
        writeJson(res, 201, { playbook });
        return;
      }

      // GET /v1/playbooks
      if (path === '/v1/playbooks' && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        if (query.q) {
          const results = await requestManager.searchPlaybooks(
            query.q,
            query.limit ? { limit: parseLimit(query.limit) } : undefined,
          );
          writeJson(res, 200, {
            playbooks: results.map((r) => ({ ...r.item, rank: r.rank })),
          });
        } else {
          const playbooks = await requestManager.listPlaybooks();
          writeJson(res, 200, { playbooks });
        }
        return;
      }

      // POST /v1/playbooks/from-task
      if (path === '/v1/playbooks/from-task' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const playbook = await requestManager.createPlaybookFromTask({
          title: requireString(body.title, 'title'),
          description: requireString(body.description, 'description'),
          sessionId: requireString(body.sessionId, 'sessionId'),
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          sourceWorkingMemoryId: typeof body.sourceWorkingMemoryId === 'number' ? body.sourceWorkingMemoryId : undefined,
        });
        writeJson(res, 201, { playbook });
        return;
      }

      // GET /v1/playbooks/:id
      const playbookGetMatch = path.match(/^\/v1\/playbooks\/(\d+)$/);
      if (playbookGetMatch && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const playbook = await requestManager.getPlaybook(Number(playbookGetMatch[1]));
        if (!playbook) {
          writeError(res, 404, 'Playbook not found');
          return;
        }
        writeJson(res, 200, { playbook });
        return;
      }

      // PUT /v1/playbooks/:id
      if (playbookGetMatch && req.method === 'PUT') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const patch: Record<string, unknown> = {};
        if (body.title != null) patch.title = requireString(body.title, 'title');
        if (body.description != null) patch.description = requireString(body.description, 'description');
        if (body.instructions != null) patch.instructions = requireString(body.instructions, 'instructions');
        if (Array.isArray(body.references)) patch.references = body.references.map(String);
        if (Array.isArray(body.templates)) patch.templates = body.templates.map(String);
        if (Array.isArray(body.scripts)) patch.scripts = body.scripts.map(String);
        if (Array.isArray(body.assets)) patch.assets = body.assets.map(String);
        if (Array.isArray(body.tags)) patch.tags = body.tags.map(String);
        if (body.status != null) patch.status = requireEnum(body.status, PLAYBOOK_STATUSES, 'status');
        const updated = await requestManager.updatePlaybook(Number(playbookGetMatch[1]), patch);
        if (!updated) {
          writeError(res, 404, 'Playbook not found');
          return;
        }
        writeJson(res, 200, { playbook: updated });
        return;
      }

      // POST /v1/playbooks/:id/revise
      const playbookReviseMatch = path.match(/^\/v1\/playbooks\/(\d+)\/revise$/);
      if (playbookReviseMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const result = await requestManager.revisePlaybook(
          Number(playbookReviseMatch[1]),
          requireString(body.instructions, 'instructions'),
          requireString(body.revisionReason, 'revisionReason'),
          optionalString(body.sourceSessionId, 'sourceSessionId'),
        );
        writeJson(res, 200, result);
        return;
      }

      // POST /v1/playbooks/:id/use
      const playbookUseMatch = path.match(/^\/v1\/playbooks\/(\d+)\/use$/);
      if (playbookUseMatch && req.method === 'POST') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        await requestManager.recordPlaybookUse(Number(playbookUseMatch[1]));
        writeJson(res, 200, { recorded: true });
        return;
      }

      // POST /v1/associations
      if (path === '/v1/associations' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const sourceId = Number.isInteger(body.source_id) && (body.source_id as number) > 0
          ? (body.source_id as number)
          : (() => { throw new HttpRequestError(400, 'Missing or invalid field: source_id (must be positive integer)'); })();
        const targetId = Number.isInteger(body.target_id) && (body.target_id as number) > 0
          ? (body.target_id as number)
          : (() => { throw new HttpRequestError(400, 'Missing or invalid field: target_id (must be positive integer)'); })();
        let confidence: number | undefined;
        if (body.confidence !== undefined && body.confidence !== null) {
          if (typeof body.confidence !== 'number' || Number.isNaN(body.confidence) || body.confidence < 0 || body.confidence > 1) {
            throw new HttpRequestError(400, 'Invalid field: confidence (must be a number in [0, 1])');
          }
          confidence = body.confidence;
        }
        const association = await requestManager.addAssociation({
          source_kind: requireEnum(body.source_kind, ASSOCIATION_TARGET_KINDS, 'source_kind'),
          source_id: sourceId,
          target_kind: requireEnum(body.target_kind, ASSOCIATION_TARGET_KINDS, 'target_kind'),
          target_id: targetId,
          association_type: requireEnum(body.association_type, ASSOCIATION_TYPES, 'association_type'),
          confidence,
          auto_generated: typeof body.auto_generated === 'boolean' ? body.auto_generated : undefined,
        });
        writeJson(res, 201, { association });
        return;
      }

      // GET /v1/associations/:kind/:id
      const assocGetMatch = path.match(/^\/v1\/associations\/([a-z_]+)\/(\d+)$/);
      if (assocGetMatch && req.method === 'GET') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        const kind = requireEnum(assocGetMatch[1], ASSOCIATION_TARGET_KINDS, 'kind');
        const targetId = Number(assocGetMatch[2]);
        const result = await requestManager.getAssociations(kind, targetId);
        writeJson(res, 200, result);
        return;
      }

      // POST /v1/associations/traverse
      if (path === '/v1/associations/traverse' && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = getManager(resolveRequestScope(config.scope, req, query, body));
        const kind = requireEnum(body.kind, ASSOCIATION_TARGET_KINDS, 'kind');
        const id = Number.isInteger(body.id) && (body.id as number) > 0
          ? (body.id as number)
          : (() => { throw new HttpRequestError(400, 'Missing or invalid field: id (must be positive integer)'); })();
        const maxDepth = parseOptionalNonNegativeInteger(body.maxDepth, 'maxDepth');
        const maxNodes = parseOptionalNonNegativeInteger(body.maxNodes, 'maxNodes');
        const graph = await requestManager.traverseAssociations(kind, id, { maxDepth, maxNodes });
        writeJson(res, 200, graph);
        return;
      }

      // DELETE /v1/associations/:id
      const assocDeleteMatch = path.match(/^\/v1\/associations\/(\d+)$/);
      if (assocDeleteMatch && req.method === 'DELETE') {
        const requestManager = getManager(resolveRequestScope(config.scope, req, query));
        await requestManager.removeAssociation(Number(assocDeleteMatch[1]));
        writeJson(res, 200, { deleted: true });
        return;
      }

      // POST /v1/sessions/:sessionId/snapshot — capture a frozen snapshot
      const snapshotCaptureMatch = path.match(/^\/v1\/sessions\/([^/]+)\/snapshot$/);
      if (snapshotCaptureMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const sessionId = decodeURIComponent(snapshotCaptureMatch[1]);
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        // Use session-aware manager so getContext/getSessionBootstrap read
        // the session named in the URL, not the scope's bound default.
        const requestManager = getSessionManager(scopeInput, sessionId);
        const scopeKey = scopeKeyFor(scopeInput);
        const relevanceQuery = typeof body.relevanceQuery === 'string' ? body.relevanceQuery : undefined;
        const [bootstrap, context] = await Promise.all([
          requestManager.getSessionBootstrap(relevanceQuery),
          requestManager.getContext(relevanceQuery),
        ]);
        const events = await requestManager.listMemoryEvents({ limit: 1 });
        const snapshot = {
          scopeKey,
          snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          bootstrap,
          context,
          frozenAt: Math.floor(Date.now() / 1000),
          watermarkEventId: events.events[0]?.event_id ?? null,
        };
        touchSnapshot(`${scopeKey}:${sessionId}`, snapshot);
        const { scopeKey: _scopeKey, ...publicSnapshot } = snapshot;
        writeJson(res, 201, { snapshot: { ...publicSnapshot, sessionId } });
        return;
      }

      // GET /v1/sessions/:sessionId/snapshot — fetch cached snapshot
      if (snapshotCaptureMatch && req.method === 'GET') {
        const sessionId = decodeURIComponent(snapshotCaptureMatch[1]);
        const scopeInput = resolveRequestScope(config.scope, req, query);
        const scopeKey = scopeKeyFor(scopeInput);
        const snapshot = readSnapshot(`${scopeKey}:${sessionId}`);
        if (!snapshot) {
          writeError(res, 404, 'Snapshot not found');
          return;
        }
        const { scopeKey: _scopeKey, ...publicSnapshot } = snapshot;
        writeJson(res, 200, { snapshot: { ...publicSnapshot, sessionId } });
        return;
      }

      // POST /v1/sessions/:sessionId/refresh — re-capture and replace
      const snapshotRefreshMatch = path.match(/^\/v1\/sessions\/([^/]+)\/refresh$/);
      if (snapshotRefreshMatch && req.method === 'POST') {
        const body = await readBody(req, bodyLimitBytes);
        const sessionId = decodeURIComponent(snapshotRefreshMatch[1]);
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        const requestManager = getSessionManager(scopeInput, sessionId);
        const scopeKey = scopeKeyFor(scopeInput);
        const relevanceQuery = typeof body.relevanceQuery === 'string' ? body.relevanceQuery : undefined;
        const [bootstrap, context] = await Promise.all([
          requestManager.getSessionBootstrap(relevanceQuery),
          requestManager.getContext(relevanceQuery),
        ]);
        const events = await requestManager.listMemoryEvents({ limit: 1 });
        const snapshot = {
          scopeKey,
          snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          bootstrap,
          context,
          frozenAt: Math.floor(Date.now() / 1000),
          watermarkEventId: events.events[0]?.event_id ?? null,
        };
        touchSnapshot(`${scopeKey}:${sessionId}`, snapshot);
        const { scopeKey: _scopeKey, ...publicSnapshot } = snapshot;
        writeJson(res, 200, { snapshot: { ...publicSnapshot, sessionId } });
        return;
      }

      writeError(res, 404, `Not found: ${req.method} ${path}`);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeError(res, error.status, error.message);
        return;
      }
      if (isMemoryDomainError(error)) {
        writeError(res, error.status, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeError(res, 500, message);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        manager,
        async close() {
          for (const client of sseClients) {
            client.response.end();
          }
          sseClients.clear();
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
          managers.clear();
          sessionManagers.clear();
          sessionSnapshots.clear();
          await adapterResources.close();
        },
      });
    });
  });
}
