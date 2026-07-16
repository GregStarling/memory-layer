import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { type CreateMemoryOptions } from '../composition/quick.js';
import type { MemoryManager } from '../core/manager.js';
import type {
  ContextContract,
  ContextInvariant,
  ContextEscalationPolicy,
} from '../contracts/context-contract.js';
import type {
  TemporalIdInput,
} from '../contracts/temporal.js';
import type {
  ActorRef,
  ContextViewPolicy,
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
import type { LintCategory } from '../contracts/lint.js';
import { ACTOR_KINDS, CONTEXT_VIEW_POLICIES, MEMORY_VISIBILITY_CLASSES } from '../contracts/coordination.js';
import {
  CONTEXT_ESCALATION_RULE_DECISIONS,
  CONTEXT_REQUEST_REASONS,
} from '../contracts/context-contract.js';
import type { CognitiveMemoryType } from '../contracts/cognitive.js';
import type { ProfileSection, ProfileView } from '../contracts/profile.js';
import {
  parseOptionalFiniteInteger,
  parseOptionalFiniteNumber,
  parseOptionalTemporalIdValue,
  isRecord,
  createParsers,
  serializeContextGovernance,
} from './parsing.js';
import {
  DEFAULT_DEGRADED_CONTEXT,
  resolveDiffEventCaps,
  serializeActorRef,
  serializeWorkClaim,
  serializeHandoffRecord,
  serializeTimelineResult,
  serializeContextResponse,
  serializeTemporalState,
} from './serialization.js';
import { scopeKeyFor, withScopeManagers } from './scope-propagation.js';
import { createServerContext } from './server-context.js';
import { OPERATIONS } from './operations/registry.js';
import { createOperationMatcher } from './operations/types.js';
import { normalizeAliasMap, normalizeOntologyConfig } from '../core/scope-config.js';
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
  /**
   * Tenant-bound API key registry. Each entry maps a bearer key to the tenant
   * it may act on (or `'*'` for all tenants), the widest cross-scope level it
   * may request, and whether it may reach admin endpoints. When set, callers
   * whose resolved scope names a different tenant — or who request a wider
   * cross-scope level than the key allows — are rejected with 403.
   *
   * Prefer this over the single `apiKey` for any multi-tenant deployment.
   * Corresponding env var: `MEMORY_API_KEYS` (see parseApiKeyRegistryEnv).
   */
  apiKeys?: ApiKeyRegistryEntry[];
  /** Separate admin API key for compaction and maintenance endpoints. */
  adminApiKey?: string;
  /** Enable CORS headers. Defaults to true. */
  cors?: boolean;
  /**
   * Cross-origin policy for `Access-Control-Allow-Origin` (1.2). When unset (the
   * default), NO CORS origin header is emitted at all — the browser blocks
   * cross-origin reads (same-origin only). Set to a specific origin (or a
   * comma-separated allowlist) to echo `Access-Control-Allow-Origin` only for a
   * matching `Origin`. The literal `'*'` enables the wildcard (insecure with
   * tenant data — a startup warning is logged). Corresponding env var:
   * `MEMORY_CORS_ORIGIN`.
   */
  corsOrigin?: string;
  /** Host to bind to. Defaults to 127.0.0.1. */
  host?: string;
  /** Maximum accepted request body size in bytes. Defaults to 1 MiB. */
  bodyLimitBytes?: number;
  /** Optional redaction hook for stored turns/facts/work items. */
  redactText?: CreateMemoryOptions['redactText'];
  /** Optional Postgres connection string for hosted deployments. */
  databaseUrl?: string;
  /** Optional injected async adapter for tests or embedded hosting. */
  asyncAdapter?: AsyncStorageAdapter;
  /** Optional embedding adapter paired with an injected async adapter. */
  embeddingAdapter?: EmbeddingAdapter;
  /** Optional cleanup hook paired with an injected async adapter. */
  closeAdapterResources?: () => Promise<void>;
  /** Quality mode applied to hosted managers. */
  qualityMode?: CreateMemoryOptions['qualityMode'];
  /** Legacy quality tier mapping. */
  qualityTier?: CreateMemoryOptions['qualityTier'];
  /** Cross-scope retrieval level for hosted managers. */
  crossScopeLevel?: ScopeLevel;
  /** Default context contract applied to server-backed managers. */
  contextContract?: CreateMemoryOptions['contextContract'];
  /** Named context contracts available to server-backed managers. */
  contextContracts?: CreateMemoryOptions['contextContracts'];
  /** Invariants injected into assembled contexts. */
  invariants?: CreateMemoryOptions['invariants'];
  /** Policy used to approve, review, or deny context expansion requests. */
  escalationPolicy?: CreateMemoryOptions['escalationPolicy'];
  /** Auto-detect workspace from git remote or cwd when no scope provided. */
  autoDetectWorkspace?: boolean;
  /** Structured generation client for episodic recall, playbooks, and reflect. */
  structuredClient?: CreateMemoryOptions['structuredClient'];
  /** Default event cap for diff/reporting endpoints. Defaults to 5000. */
  defaultDiffMaxEvents?: number;
  /** Hard maximum event cap for diff/reporting endpoints. Defaults to 20000. */
  maxDiffMaxEvents?: number;
  /**
   * Sustained request rate per credential (per API key, or per remote address
   * when keyless). Undefined disables rate limiting entirely (the default, for
   * backward compatibility). Hosted deployments should set this. `/healthz` and
   * `/readyz` are always exempt.
   */
  requestsPerMinute?: number;
  /**
   * Token-bucket burst capacity. Defaults to `requestsPerMinute` when rate
   * limiting is enabled. Ignored when `requestsPerMinute` is undefined.
   */
  burst?: number;
}

/**
 * One entry in the tenant-bound API key registry.
 *
 * `tenantId: '*'` grants access to every tenant (the wildcard/back-compat mode).
 * A concrete `tenantId` binds the key: requests resolving to any other tenant
 * are rejected with 403.
 */
export interface ApiKeyRegistryEntry {
  /** The bearer secret (compared timing-safely). */
  key: string;
  /** Tenant this key may act on, or `'*'` for all tenants. */
  tenantId: string | '*';
  /**
   * Widest cross-scope level this key may request. Requests asking for a wider
   * level are rejected with 403. Defaults to `'tenant'` (no ceiling).
   */
  maxCrossScopeLevel?: ScopeLevel;
  /** Whether this key may reach admin-gated endpoints. Defaults to false. */
  admin?: boolean;
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
function failHttpValidation(message: string): never {
  throw new HttpRequestError(400, message);
}

const {
  requireString, optionalString, requireStringArray, requireEnum,
  parseOptionalNonNegativeInteger, parseContextViewPolicy, parseContextContract,
  parseContextInvariant, parseContextEscalationPolicy, parseActorRef, parseLimit,
} = createParsers(failHttpValidation);

const FACT_TYPES = ['preference', 'entity', 'decision', 'constraint', 'reference'] as const;
const FACT_CONFIDENCES = ['high', 'medium', 'low'] as const;
const LINT_CATEGORIES = [
  'orphan_knowledge',
  'evidence_concentration',
  'trust_distribution',
  'contradiction_cluster',
  'stale_provisional',
  'ontology_violation',
] as const;
const MARKDOWN_GROUP_BY = ['knowledge_class', 'topic', 'tag', 'flat'] as const;

function safeSecretEquals(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const providedBuffer = createHash('sha256').update(provided).digest();
  const expectedBuffer = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * The authenticated caller for a single request.
 *
 * `tenantId: '*'` is the wildcard principal (legacy single-key mode, or a
 * registry entry bound to all tenants). A concrete `tenantId` binds the
 * principal to exactly one tenant.
 */
interface RequestPrincipal {
  tenantId: string | '*';
  maxCrossScopeLevel: ScopeLevel;
  admin: boolean;
}

const SCOPE_LEVEL_RANK: Record<ScopeLevel, number> = {
  scope: 1,
  workspace: 2,
  system: 3,
  tenant: 4,
};

function scopeLevelRank(level: ScopeLevel | undefined): number {
  return level ? SCOPE_LEVEL_RANK[level] : SCOPE_LEVEL_RANK.scope;
}

/**
 * Parses the `MEMORY_API_KEYS` env var into registry entries.
 *
 * Encoding: comma-separated entries, each `key:tenant[:maxCrossScopeLevel][:admin]`.
 *   - `key`     the bearer secret (may not contain `:` or `,`)
 *   - `tenant`  a tenant id, or `*` for all tenants
 *   - `maxCrossScopeLevel` (optional) one of scope|workspace|system|tenant
 *   - `admin`   (optional) the literal `admin` to grant admin access
 *
 * Examples:
 *   "k1:tenantA:workspace"        → k1 bound to tenantA, may widen up to workspace
 *   "k2:*,k3:tenantB:tenant:admin" → k2 wildcard; k3 bound to tenantB, admin
 */
export function parseApiKeyRegistryEnv(raw: string | undefined): ApiKeyRegistryEntry[] {
  if (!raw || !raw.trim()) return [];
  const entries: ApiKeyRegistryEntry[] = [];
  for (const chunk of raw.split(',')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    const key = parts[0]?.trim();
    const tenantId = parts[1]?.trim();
    if (!key || !tenantId) {
      throw new Error(
        `Invalid MEMORY_API_KEYS entry "${trimmed}": expected "key:tenant[:level][:admin]"`,
      );
    }
    let maxCrossScopeLevel: ScopeLevel | undefined;
    let admin = false;
    for (const extra of parts.slice(2)) {
      const token = extra.trim();
      if (!token) continue;
      if (token === 'admin') {
        admin = true;
      } else if (token === 'scope' || token === 'workspace' || token === 'system' || token === 'tenant') {
        maxCrossScopeLevel = token;
      } else {
        throw new Error(
          `Invalid MEMORY_API_KEYS token "${token}" in entry "${trimmed}": expected a scope level or "admin"`,
        );
      }
    }
    entries.push({ key, tenantId, maxCrossScopeLevel, admin });
  }
  return entries;
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function writeError(
  res: ServerResponse,
  status: number,
  message: string,
  code?: string,
): void {
  writeJson(res, status, code ? { error: message, code } : { error: message });
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
  return parseOptionalTemporalIdValue(value, 'cursor', failHttpValidation);
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
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

/**
 * Per-request authenticated principal, keyed by the incoming message. Set by
 * the dispatcher immediately after authentication; read by resolveRequestScope
 * so every one of its ~80 call sites inherits tenant-binding enforcement
 * without a signature change.
 */
const requestPrincipals = new WeakMap<IncomingMessage, RequestPrincipal>();

/**
 * Rejects a request whose resolved scope names a tenant the authenticated key
 * is not bound to. Wildcard principals ('*') pass unconditionally.
 */
function enforcePrincipalTenant(
  req: IncomingMessage,
  resolved: string | MemoryScope,
): void {
  const principal = requestPrincipals.get(req);
  if (!principal || principal.tenantId === '*') return;
  const tenantId =
    typeof resolved === 'string' ? 'default' : requireString(resolved.tenant_id, 'scope.tenant_id');
  if (tenantId !== principal.tenantId) {
    throw new HttpRequestError(
      403,
      `API key is bound to tenant '${principal.tenantId}' and may not act on tenant '${tenantId}'`,
    );
  }
}

/**
 * Rejects a request asking for a wider cross-scope level than the authenticated
 * key permits. Inspects the `scope_level` query param and any body-supplied
 * `crossScopeLevel` (top-level or inside a `contract`). Wildcard principals with
 * the default 'tenant' ceiling pass everything.
 */
function enforcePrincipalCeiling(
  req: IncomingMessage,
  query: Record<string, string>,
  body?: Record<string, unknown>,
): void {
  const principal = requestPrincipals.get(req);
  if (!principal) return;
  const ceiling = scopeLevelRank(principal.maxCrossScopeLevel);
  const requested: Array<unknown> = [query.scope_level];
  if (body) {
    requested.push(body.crossScopeLevel);
    if (isRecord(body.contract)) requested.push(body.contract.crossScopeLevel);
  }
  for (const value of requested) {
    if (value == null || value === '') continue;
    const level =
      value === 'scope' || value === 'workspace' || value === 'system' || value === 'tenant'
        ? (value as ScopeLevel)
        : undefined;
    if (level && scopeLevelRank(level) > ceiling) {
      throw new HttpRequestError(
        403,
        `API key may not request cross-scope level '${level}' (ceiling: '${principal.maxCrossScopeLevel}')`,
      );
    }
  }
}

function resolveRequestScope(
  fallbackScope: string | MemoryScope | undefined,
  req: IncomingMessage,
  query: Record<string, string>,
  body?: Record<string, unknown>,
): string | MemoryScope {
  const resolved = resolveRequestScopeRaw(fallbackScope, req, query, body);
  // Bind the client-supplied five-tuple to the authenticated principal: a
  // tenant-bound key may not name a different tenant (1.1). Wildcard/legacy
  // keys and keyless mode pass through unchanged.
  enforcePrincipalTenant(req, resolved);
  enforcePrincipalCeiling(req, query, body);
  return resolved;
}

function resolveRequestScopeRaw(
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
    const validated: MemoryScope = {
      tenant_id: requireString(bodyScope.tenant_id, 'scope.tenant_id'),
      system_id: requireString(bodyScope.system_id, 'scope.system_id'),
      scope_id: requireString(bodyScope.scope_id, 'scope.scope_id'),
      workspace_id: optionalString(bodyScope.workspace_id, 'scope.workspace_id'),
      collaboration_id: optionalString(bodyScope.collaboration_id, 'scope.collaboration_id'),
    };
    normalizeScope(validated);
    return validated;
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
 * Extracts the raw bearer secret from an Authorization header value, or
 * undefined when absent/malformed. The value itself is compared timing-safely
 * by callers; this only strips the "Bearer " prefix.
 */
function extractBearer(auth: string | string[] | undefined): string | undefined {
  if (typeof auth !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : undefined;
}

/**
 * Resolves the authenticated principal for a request against the key registry.
 *
 * Returns:
 *  - a RequestPrincipal when a registered key matches,
 *  - `null` when auth is configured but the request presents no valid key,
 *  - `undefined` when no auth is configured (keyless mode).
 *
 * Every registered key is compared timing-safely (SHA-256 + timingSafeEqual);
 * we iterate all entries rather than hashing-then-looking-up so a raw-key map
 * lookup can never short-circuit the comparison.
 */
function authenticatePrincipal(
  req: IncomingMessage,
  registry: ApiKeyRegistryEntry[],
  legacyApiKey: string | undefined,
): RequestPrincipal | null | undefined {
  if (registry.length > 0) {
    const presented = extractBearer(req.headers.authorization);
    let matched: ApiKeyRegistryEntry | undefined;
    // Iterate every entry timing-safely; do not early-exit on first match so
    // the comparison cost does not leak which/whether a key matched.
    for (const entry of registry) {
      if (safeSecretEquals(presented, entry.key)) {
        matched = entry;
      }
    }
    if (!matched) return null;
    return {
      tenantId: matched.tenantId,
      maxCrossScopeLevel: matched.maxCrossScopeLevel ?? 'tenant',
      admin: matched.admin ?? false,
    };
  }
  if (legacyApiKey) {
    const auth = req.headers.authorization;
    if (!safeSecretEquals(auth, `Bearer ${legacyApiKey}`)) return null;
    // Legacy single-key mode: wildcard tenant, no ceiling, no implicit admin.
    return { tenantId: '*', maxCrossScopeLevel: 'tenant', admin: false };
  }
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === '::1' ||
    host === 'localhost' ||
    host.startsWith('127.')
  );
}

/**
 * Resolved cross-origin policy (1.2).
 *   - `mode: 'none'`     no `Access-Control-Allow-Origin` header ever (default;
 *                        browsers block cross-origin reads / same-origin only).
 *   - `mode: 'wildcard'` echo `*` (explicit `MEMORY_CORS_ORIGIN=*` only).
 *   - `mode: 'allowlist'` echo the request's `Origin` only when it matches one
 *                        of the configured origins.
 */
type CorsPolicy =
  | { mode: 'none' }
  | { mode: 'wildcard' }
  | { mode: 'allowlist'; origins: Set<string> };

/**
 * Parses the `corsOrigin` config / `MEMORY_CORS_ORIGIN` env into a policy.
 * Undefined/empty → same-origin-only (no CORS headers). The literal `'*'` →
 * wildcard. Anything else → a comma-separated allowlist of exact origins.
 */
function resolveCorsPolicy(raw: string | undefined): CorsPolicy {
  if (raw == null) return { mode: 'none' };
  const trimmed = raw.trim();
  if (trimmed === '') return { mode: 'none' };
  if (trimmed === '*') return { mode: 'wildcard' };
  const origins = new Set(
    trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (origins.size === 0) return { mode: 'none' };
  return { mode: 'allowlist', origins };
}

/**
 * Applies the resolved CORS policy to a response for the given request Origin.
 * Sets `Access-Control-Allow-*` only when the policy permits this origin.
 * Returns nothing; the header is simply absent when cross-origin reads are
 * disallowed (the browser then blocks the read).
 */
function applyCors(
  res: ServerResponse,
  policy: CorsPolicy,
  origin: string | string[] | undefined,
): void {
  if (policy.mode === 'none') return;
  let allowOrigin: string | undefined;
  if (policy.mode === 'wildcard') {
    allowOrigin = '*';
  } else {
    const requestOrigin = typeof origin === 'string' ? origin : undefined;
    if (requestOrigin && policy.origins.has(requestOrigin)) {
      allowOrigin = requestOrigin;
      // A specific echoed origin must be paired with Vary: Origin so caches
      // don't serve one origin's allowance to another.
      res.setHeader('Vary', 'Origin');
    }
  }
  if (!allowOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-key, x-memory-tenant, x-memory-system, x-memory-workspace, x-memory-collaboration, x-memory-scope, Last-Event-ID',
  );
}

/**
 * In-process per-credential token-bucket rate limiter (1.4). Buckets are keyed
 * by API key (or remote address when keyless) so distinct keys never share a
 * budget. Disabled entirely when requestsPerMinute is undefined.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;
  /**
   * Cap on distinct tracked buckets. Keyless mode keys by remote address, so a
   * rotating set of source IPs would otherwise grow this map without bound
   * (memory DoS). We prune fully-refilled (idle) buckets first, then fall back
   * to evicting the oldest, whenever the map would exceed this cap.
   */
  private readonly maxBuckets: number;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly burst: number,
    maxBuckets = 10_000,
  ) {
    this.refillPerMs = requestsPerMinute / 60_000;
    this.maxBuckets = Math.max(1, maxBuckets);
  }

  /** Distinct tracked buckets (test/introspection hook). */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Consumes one token for `key`. Returns `{ ok: true }` when allowed, or
   * `{ ok: false, retryAfterSeconds }` when the bucket is empty.
   */
  take(key: string, now: number = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        this.evict(now);
      }
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.updatedAt;
      if (elapsed > 0) {
        bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.refillPerMs);
        bucket.updatedAt = now;
      }
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / this.refillPerMs / 1000));
    return { ok: false, retryAfterSeconds };
  }

  /**
   * Lazy, allocation-light eviction. First pass removes idle buckets (fully
   * refilled to `burst` after accounting for elapsed time — an idle bucket is
   * indistinguishable from a fresh one, so dropping it changes nothing). If none
   * are idle, evict the oldest (first-inserted) entry so the map still shrinks.
   */
  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const refilled = Math.min(
        this.burst,
        bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs,
      );
      if (refilled >= this.burst) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
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
  const apiKeyRegistry = config.apiKeys ?? parseApiKeyRegistryEnv(process.env.MEMORY_API_KEYS);
  const adminApiKey = config.adminApiKey ?? process.env.MEMORY_ADMIN_API_KEY;
  const enableCors = config.cors ?? true;
  // CORS policy (1.2): secure-by-default is same-origin only (no ACAO header).
  // Wildcard requires an explicit MEMORY_CORS_ORIGIN=* opt-in. When CORS is
  // disabled entirely via `cors: false`, force the 'none' policy.
  const corsPolicy = enableCors
    ? resolveCorsPolicy(config.corsOrigin ?? process.env.MEMORY_CORS_ORIGIN)
    : ({ mode: 'none' } as CorsPolicy);
  const bodyLimitBytes = config.bodyLimitBytes ?? 1_048_576;

  // Rate limiter (1.4): off unless requestsPerMinute is configured.
  const requestsPerMinute = config.requestsPerMinute;
  const rateLimiter =
    requestsPerMinute != null && requestsPerMinute > 0
      ? new TokenBucketLimiter(requestsPerMinute, config.burst ?? requestsPerMinute)
      : undefined;

  // Startup posture warnings (1.1 back-compat + 1.2 server-side check).
  const hasWildcardRegistryKey = apiKeyRegistry.some((entry) => entry.tenantId === '*');
  if (apiKeyRegistry.length === 0 && apiKey) {
    console.warn(
      '[memory-layer] Using legacy single MEMORY_API_KEY (wildcard, all tenants). ' +
        'Set MEMORY_API_KEYS to bind keys to tenants and enforce cross-tenant isolation.',
    );
  }
  if (!isLoopbackHost(host) && apiKeyRegistry.length === 0 && !apiKey) {
    // 1.2 server-side part: warn (do not hard-fail; Docker entrypoint hard-fails).
    console.warn(
      `[memory-layer] SECURITY: server is binding to non-loopback host '${host}' with NO ` +
        'authentication configured. Set MEMORY_API_KEYS (or MEMORY_API_KEY) before exposing this server.',
    );
  } else if (!isLoopbackHost(host) && hasWildcardRegistryKey) {
    console.warn(
      `[memory-layer] SECURITY: a wildcard ('*') API key is serving non-loopback host '${host}'. ` +
        'Bind keys to specific tenants for cross-tenant isolation.',
    );
  }
  if (corsPolicy.mode === 'wildcard') {
    console.warn(
      "[memory-layer] SECURITY: CORS is set to wildcard ('*'). Any web origin can read " +
        'responses from this server; this is insecure with tenant data. Set MEMORY_CORS_ORIGIN ' +
        'to a specific origin (or comma-separated allowlist) instead.',
    );
  }
  const { defaultDiffMaxEvents, maxDiffMaxEvents } = resolveDiffEventCaps(
    config.defaultDiffMaxEvents,
    config.maxDiffMaxEvents,
  );
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

  const sseClients = new Set<{
    response: ServerResponse;
    scope?: MemoryScope;
    scopeLevel?: ScopeLevel;
    eventTypes?: Set<MemoryEventType>;
  }>();

  const serverContext = createServerContext({
    dbPath: config.dbPath,
    databaseUrl,
    asyncAdapter: config.asyncAdapter,
    embeddingAdapter: config.embeddingAdapter,
    closeAdapterResources: config.closeAdapterResources,
    managerCacheLimit: MANAGER_CACHE_LIMIT,
    sessionManagerCacheLimit: SESSION_MANAGER_CACHE_LIMIT,
    buildManagerOptions(scopeInput, sessionId) {
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
        contextContract: config.contextContract,
        contextContracts: config.contextContracts,
        invariants: config.invariants,
        escalationPolicy: config.escalationPolicy,
        autoDetectWorkspace: config.autoDetectWorkspace,
        structuredClient: config.structuredClient,
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
    },
  });

  function requireAdmin(req: IncomingMessage): void {
    if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
      throw new HttpRequestError(403, 'Admin key required');
    }
  }

  const propagateToManagers = (
    scopeInput: string | MemoryScope,
    callback: (manager: MemoryManager) => Promise<void>,
  ) => serverContext.withScopeManagers(scopeInput, callback);
  const getManager = (scopeInput: string | MemoryScope) => serverContext.getManager(scopeInput);
  const getSessionManager = (scopeInput: string | MemoryScope, sessionId: string) =>
    serverContext.getSessionManager(scopeInput, sessionId);

  const manager = await serverContext.getManager(config.scope ?? 'default');

  type RegisteredHttpRouteContext = {
    req: IncomingMessage;
    res: ServerResponse;
    query: Record<string, string>;
    params: Record<string, string>;
    readJsonBody: () => Promise<Record<string, unknown>>;
  };
  type RegisteredHttpRouteHandler = (context: RegisteredHttpRouteContext) => Promise<void>;

  const opHandlers: Record<string, RegisteredHttpRouteHandler> = {
    discover: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const maxResults = parseOptionalFiniteInteger(query.max_results, { name: 'max_results', min: 0 }, failHttpValidation);
      const minScore = parseOptionalFiniteNumber(query.min_score, { name: 'min_score' }, failHttpValidation);
      const maxDepth = parseOptionalFiniteInteger(query.max_depth, { name: 'max_depth', min: 0 }, failHttpValidation);
      const report = await requestManager.graph.discover({
        maxResults: maxResults ?? undefined,
        minSurpriseScore: minScore ?? undefined,
        maxDepth: maxDepth ?? undefined,
      });
      writeJson(res, 200, report);
    },
    getReport: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const report = await requestManager.graph.getGraphReport({
        tokenBudget: parseOptionalInteger(query.token_budget) ?? undefined,
        includeSections: query.sections ? query.sections.split(',') : undefined,
        filterByTags: query.tags ? query.tags.split(',') : undefined,
      });
      writeJson(res, 200, report);
    },
    getFactsAt: async ({ req, res, query }) => {
      const timestamp = parseOptionalFiniteNumber(query.timestamp, { name: 'timestamp' }, failHttpValidation);
      if (timestamp == null) {
        writeError(res, 400, 'Missing or invalid timestamp parameter');
        return;
      }
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const result = await requestManager.temporal.getFactsAt(timestamp);
      writeJson(res, 200, result);
    },
    reflectKnowledge: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
      const result = await requestManager.curation.reflectOnKnowledge({
        maxFacts: typeof body.maxFacts === 'number' ? body.maxFacts : undefined,
        includePlaybooks: typeof body.includePlaybooks === 'boolean' ? body.includePlaybooks : undefined,
        rateLimitKey: typeof body.rateLimitKey === 'string' ? body.rateLimitKey : undefined,
      });
      writeJson(res, 200, result);
    },
    derive: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
      const outputs = await requestManager.curation.derive({
        outputTypes: Array.isArray(body.outputTypes) ? body.outputTypes : undefined,
        maxOutputs: typeof body.maxOutputs === 'number' ? body.maxOutputs : undefined,
      });
      writeJson(res, 200, { outputs });
    },
    getCuration: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const summary = await requestManager.curation.getCurationSummary(undefined, {
        since: parseOptionalFiniteNumber(query.since, { name: 'since' }, failHttpValidation) ?? undefined,
        limit: parseOptionalInteger(query.limit) ?? undefined,
        actionTypes: query.action_types ? query.action_types.split(',') as import('../contracts/curation.js').CurationActionType[] : undefined,
      });
      writeJson(res, 200, summary);
    },
    getCoreMemory: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const bundle = await requestManager.curation.getCoreMemory({
        tokenBudget: parseOptionalInteger(query.token_budget) ?? undefined,
      });
      writeJson(res, 200, bundle);
    },
    setAliases: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      // Resolve scope (and enforce tenant binding) before body-shape validation
      // so a cross-tenant caller is rejected with 403, not a 400 that leaks the
      // route accepts the request at all.
      const scopeInput = resolveRequestScope(config.scope, req, query, body);
      if (!isRecord(body.aliasMap)) {
        writeError(res, 400, 'Missing or invalid field: aliasMap');
        return;
      }
      const aliasMap = normalizeAliasMap(body.aliasMap, 'aliasMap');
      await serverContext.saveAliases(
        scopeInput,
        aliasMap,
      );
      writeJson(res, 200, { ok: true });
    },
    getAliases: async ({ req, res, query }) => {
      const scopeInput = resolveRequestScope(config.scope, req, query);
      await serverContext.refreshScopeConfig(scopeInput);
      const requestManager = await getManager(scopeInput);
      const aliases = requestManager.curation.getAliases();
      writeJson(res, 200, { aliasMap: aliases ?? {} });
    },
    getAliasCandidates: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const candidates = await requestManager.curation.getAliasCandidates({
        threshold: parseOptionalFiniteNumber(query.min_similarity, { name: 'min_similarity' }, failHttpValidation) ?? undefined,
        maxCandidates: parseOptionalInteger(query.max_candidates) ?? undefined,
      });
      writeJson(res, 200, { candidates });
    },
    setOntology: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      // Resolve scope (and enforce tenant binding) before body-shape validation.
      const scopeInput = resolveRequestScope(config.scope, req, query, body);
      if (!isRecord(body.ontology)) {
        writeError(res, 400, 'Missing or invalid field: ontology');
        return;
      }
      const ontology = normalizeOntologyConfig(body.ontology, 'ontology');
      await serverContext.saveOntology(
        scopeInput,
        ontology,
      );
      writeJson(res, 200, { ok: true });
    },
    getOntology: async ({ req, res, query }) => {
      const scopeInput = resolveRequestScope(config.scope, req, query);
      await serverContext.refreshScopeConfig(scopeInput);
      const requestManager = await getManager(scopeInput);
      const ontology = requestManager.curation.getOntology();
      writeJson(res, 200, { ontology: ontology ?? null });
    },
    exportBundle: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
      const name = requireString(body.name, 'name');
      const result = requestManager.curation.exportBundle(name, {
        knowledgeClassFilter: Array.isArray(body.knowledgeClassFilter) ? body.knowledgeClassFilter : undefined,
        includeTags: Array.isArray(body.includeTags) ? body.includeTags : undefined,
      });
      writeJson(res, 200, result);
    },
    importBundle: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const scopeInput = resolveRequestScope(config.scope, req, query, body);
      const requestManager = await getManager(scopeInput);
      if (!isRecord(body.bundle)) {
        writeError(res, 400, 'Missing or invalid field: bundle');
        return;
      }
      const resolution = requireEnum(
        body.conflictResolution ?? 'skip',
        ['skip', 'overwrite', 'merge', 'trust_higher'],
        'conflictResolution',
      );
      const result = requestManager.curation.importBundle(
        body.bundle as unknown as import('../contracts/bundles.js').MemoryBundle,
        {
          conflictResolution: resolution as import('../contracts/bundles.js').BundleConflictResolution,
          targetScope: materializeScope(scopeInput),
          preserveTrust: body.preserveTrust === true,
        },
      );
      writeJson(res, 200, result);
    },
    refreshDocuments: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
      if (!Array.isArray(body.documents)) {
        writeError(res, 400, 'Missing or invalid field: documents');
        return;
      }
      const documents = body.documents.map((d: unknown) => {
        if (!isRecord(d)) throw new HttpRequestError(400, 'Each document must be an object');
        return {
          title: requireString(d.title, 'documents[].title'),
          contentHash: requireString(d.contentHash, 'documents[].contentHash'),
          content: typeof d.content === 'string' ? d.content : undefined,
        };
      });
      const result = requestManager.curation.refreshDocuments(documents);
      writeJson(res, 200, result);
    },
    promoteResponse: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
      if (typeof body.turnId !== 'number' || !Number.isInteger(body.turnId)) {
        failHttpValidation('Missing or invalid field: turnId');
      }
      const factTypes = Array.isArray(body.factTypes)
        ? body.factTypes.map((t) => requireEnum(t, FACT_TYPES, 'factTypes[]') as FactType)
        : undefined;
      const minConfidence =
        body.minConfidence == null
          ? undefined
          : (requireEnum(body.minConfidence, FACT_CONFIDENCES, 'minConfidence') as FactConfidence);
      const knowledge = await requestManager.curation.promoteResponse(body.turnId as number, {
        factTypes,
        minConfidence,
      });
      writeJson(res, 200, { knowledge });
    },
    ingestDocument: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
      const content = requireString(body.content, 'content');
      const title = requireString(body.title, 'title');
      const result = await requestManager.curation.ingestDocument(content, {
        title,
        url: optionalString(body.url, 'url'),
        mimeType: optionalString(body.mimeType, 'mimeType'),
        metadata: isRecord(body.metadata)
          ? (body.metadata as Record<string, string>)
          : undefined,
      });
      writeJson(res, 201, result);
    },
    listDocuments: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const limit = parseLimit(query.limit);
      if (query.limit && limit == null) {
        writeError(res, 400, 'Invalid limit parameter');
        return;
      }
      const cursor = parseOptionalInteger(query.cursor);
      if (query.cursor && cursor == null) {
        writeError(res, 400, 'Invalid cursor parameter');
        return;
      }
      const result = await requestManager.curation.listSourceDocuments({
        limit: limit ?? undefined,
        cursor: cursor ?? undefined,
      });
      writeJson(res, 200, result);
    },
    exportMarkdown: async ({ req, res, query }) => {
      const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
      const boolParam = (value: string | undefined): boolean | undefined =>
        value == null ? undefined : value === 'true';
      const changelogLimit = parseOptionalInteger(query.changelogLimit);
      if (query.changelogLimit && changelogLimit == null) {
        writeError(res, 400, 'Invalid changelogLimit parameter');
        return;
      }
      const groupBy =
        query.groupBy == null
          ? undefined
          : (requireEnum(query.groupBy, MARKDOWN_GROUP_BY, 'groupBy') as
              | 'knowledge_class'
              | 'topic'
              | 'tag'
              | 'flat');
      const filterByTags = query.tags
        ? query.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      const result = await requestManager.curation.exportAsMarkdown({
        includeEvidence: boolParam(query.includeEvidence),
        includeTrustMetadata: boolParam(query.includeTrustMetadata),
        includeChangelog: boolParam(query.includeChangelog),
        changelogLimit: changelogLimit ?? undefined,
        groupBy,
        filterByTags,
        includeSourceDocuments: boolParam(query.includeSourceDocuments),
      });
      // MarkdownExportResult.files is a Map; serialize it as a JSON object.
      writeJson(res, 200, {
        files: Object.fromEntries(result.files),
        stats: result.stats,
      });
    },
    lintKnowledge: async ({ req, res, query, readJsonBody }) => {
      const body = await readJsonBody();
      // Resolve (and enforce) scope before shape validation so a cross-tenant
      // caller is rejected with 403, not a 400 that leaks route acceptance.
      const scopeInput = resolveRequestScope(config.scope, req, query, body);
      const categories = Array.isArray(body.categories)
        ? body.categories.map((c) => requireEnum(c, LINT_CATEGORIES, 'categories[]') as LintCategory)
        : undefined;
      const maxIssues = typeof body.maxIssues === 'number' ? body.maxIssues : undefined;
      const minOrphanAgeDays =
        typeof body.minOrphanAgeDays === 'number' ? body.minOrphanAgeDays : undefined;
      const filterByTags = Array.isArray(body.filterByTags)
        ? body.filterByTags.filter((t): t is string => typeof t === 'string')
        : undefined;
      const report = await serverContext.lintKnowledge(scopeInput, {
        categories,
        maxIssues,
        minOrphanAgeDays,
        filterByTags,
      });
      writeJson(res, 200, report);
    },
    storeTurn: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const turn = await requestManager.processTurn(
          requireEnum(body.role, ['user', 'assistant', 'system'], 'role'),
          requireString(body.content, 'content'),
          optionalString(body.actor, 'actor'),
        );
        writeJson(res, 201, { turnId: turn.id, role: turn.role });
        return;
    },
    storeExchange: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
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
    },
    getContext: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const context = await requestManager.getContext(query.query || undefined, {
          view: parseContextViewPolicy(query.view),
          viewer: parseViewerFromQuery(query),
          includeCoordinationState: query.include_coordination === 'true',
          contract: query.contract || undefined,
        });
        writeJson(res, 200, serializeContextResponse(context, {
          includeDebug: query.debug === 'true',
        }));
        return;
    },
    requestContext: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const resolution = await requestManager.governance.requestContextExpansion(
          {
            reason: requireEnum(body.reason, CONTEXT_REQUEST_REASONS, 'reason'),
            note: optionalString(body.note, 'note'),
            contract: parseContextContract(body.contract, 'contract'),
          },
          {
            currentContract: optionalString(body.currentContract, 'currentContract'),
          },
        );
        writeJson(res, 200, resolution);
        return;
    },
    getContextConfig: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const scopeInput = resolveRequestScope(config.scope, req, query);
        const requestManager = await getManager(scopeInput);
        const snapshot = await requestManager.governance.getContextGovernance();
        writeJson(res, 200, serializeContextGovernance(snapshot));
        return;
    },
    setDefaultContract: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const body = await readBody(req, bodyLimitBytes);
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        const contract = parseContextContract(body.contract, 'contract');
        await propagateToManagers(scopeInput, async (managed) => {
          await managed.governance.setDefaultContextContract(contract ?? null);
        });
        const snapshot = await (await getManager(scopeInput)).governance.getContextGovernance();
        writeJson(res, 200, serializeContextGovernance(snapshot));
        return;
    },
    deleteDefaultContract: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const scopeInput = resolveRequestScope(config.scope, req, query);
        await propagateToManagers(scopeInput, async (managed) => {
          await managed.governance.setDefaultContextContract(null);
        });
        const snapshot = await (await getManager(scopeInput)).governance.getContextGovernance();
        writeJson(res, 200, serializeContextGovernance(snapshot));
        return;
    },
    putContract: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const body = await readBody(req, bodyLimitBytes);
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        const name = params.name;
        const contract = parseContextContract(body.contract, 'contract');
        if (!contract) {
          writeError(res, 400, 'Missing contract');
          return;
        }
        await propagateToManagers(scopeInput, async (managed) => {
          await managed.governance.putContextContract(name, contract);
        });
        const snapshot = await (await getManager(scopeInput)).governance.getContextGovernance();
        writeJson(res, 200, serializeContextGovernance(snapshot));
        return;
    },
    deleteContract: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const scopeInput = resolveRequestScope(config.scope, req, query);
        const name = params.name;
        let deleted = false;
        await propagateToManagers(scopeInput, async (managed) => {
          deleted = (await managed.governance.deleteContextContract(name)) || deleted;
        });
        writeJson(res, 200, { deleted, name });
        return;
    },
    putInvariant: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const body = await readBody(req, bodyLimitBytes);
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        const invariantId = params.id;
        const invariant = parseContextInvariant(
          {
            ...(isRecord(body.invariant) ? body.invariant : {}),
            id: invariantId,
          },
          'invariant',
        );
        await propagateToManagers(scopeInput, async (managed) => {
          await managed.governance.putContextInvariant(invariant);
        });
        const snapshot = await (await getManager(scopeInput)).governance.getContextGovernance();
        writeJson(res, 200, serializeContextGovernance(snapshot));
        return;
    },
    deleteInvariant: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const scopeInput = resolveRequestScope(config.scope, req, query);
        const invariantId = params.id;
        let deleted = false;
        await propagateToManagers(scopeInput, async (managed) => {
          deleted = (await managed.governance.deleteContextInvariant(invariantId)) || deleted;
        });
        writeJson(res, 200, { deleted, id: invariantId });
        return;
    },
    setEscalationPolicy: async ({ req, res, query, params, readJsonBody }) => {
        requireAdmin(req);
        const body = await readBody(req, bodyLimitBytes);
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        const policy = parseContextEscalationPolicy(body.policy, 'policy');
        await propagateToManagers(scopeInput, async (managed) => {
          await managed.governance.setContextEscalationPolicy(policy);
        });
        const snapshot = await (await getManager(scopeInput)).governance.getContextGovernance();
        writeJson(res, 200, serializeContextGovernance(snapshot));
        return;
    },
    getStateAt: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const asOf = parseOptionalFiniteNumber(query.as_of, { name: 'as_of' }, failHttpValidation);
        if (asOf == null) {
          writeError(res, 400, 'Missing or invalid as_of parameter');
          return;
        }
        const state = await requestManager.temporal.getStateAt(asOf, {
          relevanceQuery: query.query || undefined,
          view: parseContextViewPolicy(query.view),
          viewer: parseViewerFromQuery(query),
          includeCoordinationState: query.include_coordination === 'true',
          contract: query.contract || undefined,
        });
        writeJson(res, 200, serializeTemporalState(state, {
          includeDebug: query.include_debug === 'true',
        }));
        return;
    },
    getTimeline: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const startAt = parseOptionalFiniteNumber(query.start_at, { name: 'start_at' }, failHttpValidation);
        const endAt = parseOptionalFiniteNumber(query.end_at, { name: 'end_at' }, failHttpValidation);
        const cursor = parseOptionalTemporalId(query.cursor);
        const limit = parseLimit(query.limit);
        const timeline = await requestManager.temporal.getTimeline({
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
    },
    diffState: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const from = parseOptionalFiniteNumber(query.from, { name: 'from' }, failHttpValidation);
        const to = parseOptionalFiniteNumber(query.to, { name: 'to' }, failHttpValidation);
        const maxEvents = parseOptionalFiniteInteger(
          query.max_events,
          { name: 'max_events', min: 1, max: maxDiffMaxEvents },
          failHttpValidation,
        );
        if (from == null || to == null) {
          writeError(res, 400, 'Missing or invalid from/to parameters');
          return;
        }
        const diff = await requestManager.temporal.diffState(from, to, {
          sessionId: query.session_id || undefined,
          entityKind: query.entity_kind as never,
          entityId: query.entity_id || undefined,
          maxEvents: maxEvents ?? defaultDiffMaxEvents,
        });
        writeJson(res, 200, diff);
        return;
    },
    listEvents: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const startAt = parseOptionalFiniteNumber(query.start_at, { name: 'start_at' }, failHttpValidation);
        const endAt = parseOptionalFiniteNumber(query.end_at, { name: 'end_at' }, failHttpValidation);
        const cursor = parseOptionalTemporalId(query.cursor);
        const limit = parseLimit(query.limit);
        const events = await requestManager.temporal.listMemoryEvents({
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
    },
    streamChanges: async ({ req, res, query, params, readJsonBody }) => {
        // Resolve (and tenant-check) the scope BEFORE committing a 200 stream.
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let closed = false;
        const abortController = new AbortController();
        req.on('close', () => {
          closed = true;
          abortController.abort();
        });
        const cursor = parseOptionalTemporalId(query.cursor);
        const initialCursor = await requestManager.temporal.resolveChangeStreamCursor(cursor);
        const iterator = requestManager.temporal.streamChanges({
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
              // SSE-phase errors happen after writeHead(200), so they bypass the
              // request-level 1.3 sanitizer. Sanitize here the same way: emit a
              // generic error event with a request id, and log the real error
              // server-side under that id. Domain errors carry a safe message.
              if (isMemoryDomainError(error)) {
                res.write(
                  `event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: error.message,
                    code: error.code,
                  })}\n\n`,
                );
              } else {
                const requestId = randomBytes(6).toString('hex');
                console.error(
                  `[memory-layer] stream error (request ${requestId}):`,
                  error,
                );
                res.write(
                  `event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: 'internal error',
                    requestId,
                  })}\n\n`,
                );
              }
              res.end();
            }
          }
        })();
        return;
    },
    search: async ({ req, res, query, params, readJsonBody }) => {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const searchOpts: import('../contracts/types.js').SearchOptions = {};
        if (query.limit) searchOpts.limit = parseLimit(query.limit);
        if (query.tags) searchOpts.tags = query.tags.split(',');
        const results = await requestManager.search(query.q, searchOpts);
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
    },
    searchCrossScope: async ({ req, res, query, params, readJsonBody }) => {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const scopeLevel = parseScopeLevel(query.scope_level, 'scope_level', [
          'workspace',
          'system',
          'tenant',
        ]) ?? 'workspace';
        const crossOpts: import('../contracts/types.js').SearchOptions = {};
        if (query.limit) crossOpts.limit = parseLimit(query.limit);
        if (query.tags) crossOpts.tags = query.tags.split(',');
        const results = await requestManager.searchCrossScope(
          query.q,
          scopeLevel,
          crossOpts,
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
    },
    inspectKnowledgeList: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const limit = parseLimit(query.limit);
        const cursor = parseOptionalInteger(query.cursor);
        if ((query.limit && limit == null) || (query.cursor && cursor == null)) {
          writeError(res, 400, 'Invalid pagination parameters');
          return;
        }
        const knowledge = await requestManager.curation.listKnowledge({
          limit,
          cursor,
        });
        writeJson(res, 200, knowledge);
        return;
    },
    inspectKnowledgeItem: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const detail = await requestManager.curation.inspectKnowledge(Number(params.knowledgeId));
        if (!detail.knowledge) {
          writeError(res, 404, 'Knowledge not found');
          return;
        }
        writeJson(res, 200, detail);
        return;
    },
    inspectAudits: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const knowledgeId = parseOptionalInteger(query.knowledge_id);
        const limit = parseLimit(query.limit);
        if ((query.knowledge_id && knowledgeId == null) || (query.limit && limit == null)) {
          writeError(res, 400, 'Invalid audit inspection parameters');
          return;
        }
        const audits = await requestManager.curation.getKnowledgeAudits({
          knowledgeId,
          limit,
        });
        writeJson(res, 200, { audits });
        return;
    },
    inspectMonitor: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const [monitor, diagnostics] = await Promise.all([
          requestManager.temporal.getContextMonitor(),
          requestManager.getRuntimeDiagnostics(),
        ]);
        writeJson(res, 200, { monitor, diagnostics });
        return;
    },
    inspectCompactions: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const limit = parseLimit(query.limit);
        if (query.limit && limit == null) {
          writeError(res, 400, 'Invalid compaction inspection parameters');
          return;
        }
        const logs = await requestManager.temporal.getRecentCompactionLogs(limit);
        writeJson(res, 200, { logs });
        return;
    },
    inspectContext: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const asOf = parseOptionalFiniteNumber(query.as_of, { name: 'as_of' }, failHttpValidation);
        const context = asOf != null
          ? await requestManager.temporal.getContextAt(asOf, query.query || undefined)
          : await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, serializeContextResponse(context, { includeDebug: true }));
        return;
    },
    inspectSessionState: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const asOf = parseOptionalFiniteNumber(query.as_of, { name: 'as_of' }, failHttpValidation);
        const context = asOf != null
          ? await requestManager.temporal.getContextAt(asOf, query.query || undefined)
          : await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, { sessionState: context.sessionState });
        return;
    },
    inspectRetrieval: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const asOf = parseOptionalFiniteNumber(query.as_of, { name: 'as_of' }, failHttpValidation);
        const context = asOf != null
          ? await requestManager.temporal.getContextAt(asOf, query.query || undefined)
          : await requestManager.getContext(query.query || undefined);
        writeJson(res, 200, {
          sessionState: context.sessionState,
          knowledgeSelectionReasons: context.knowledgeSelectionReasons,
          debugTrace: context.debugTrace,
        });
        return;
    },
    inspectReverification: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const limit = parseOptionalInteger(query.limit);
        if (query.limit && limit == null) {
          writeError(res, 400, 'Invalid reverification inspection parameters');
          return;
        }
        const due = await requestManager.curation.getDueReverification({ limit });
        writeJson(res, 200, { due });
        return;
    },
    learnFact: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const fact = await requestManager.learnFact(
          requireString(body.fact, 'fact'),
          requireEnum(body.factType, ['preference', 'entity', 'decision', 'constraint', 'reference'], 'factType') as FactType,
          (body.confidence == null
            ? 'high'
            : requireEnum(body.confidence, ['high', 'medium', 'low'], 'confidence')) as FactConfidence,
          undefined,
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
        writeJson(res, 201, { knowledgeId: fact.id });
        return;
    },
    trackWork: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
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
    },
    updateWorkItem: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const item = await requestManager.coordination.updateWorkItem(
          Number(params.id),
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
            expectedVersion: parseOptionalFiniteInteger(
              body.expectedVersion,
              { name: 'expectedVersion', min: 0 },
              failHttpValidation,
            ),
          },
        );
        writeJson(res, 200, { workItem: item });
        return;
    },
    claimWorkItem: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const claim = await requestManager.coordination.claimWorkItem({
          workItemId: Number(params.id),
          actor,
          leaseSeconds: parseOptionalFiniteInteger(
            body.leaseSeconds,
            { name: 'leaseSeconds', min: 1 },
            failHttpValidation,
          ),
        });
        writeJson(res, 200, { claim: serializeWorkClaim(claim) });
        return;
    },
    renewWorkClaim: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const claim = await requestManager.coordination.renewWorkClaim(
          Number(params.id),
          actor,
          parseOptionalFiniteInteger(
            body.leaseSeconds,
            { name: 'leaseSeconds', min: 1 },
            failHttpValidation,
          ),
        );
        writeJson(res, 200, { claim: claim ? serializeWorkClaim(claim) : null });
        return;
    },
    releaseWorkClaim: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const claim = await requestManager.coordination.releaseWorkClaim(
          Number(params.id),
          actor,
          optionalString(body.reason, 'reason'),
        );
        writeJson(res, 200, { claim: claim ? serializeWorkClaim(claim) : null });
        return;
    },
    listWorkClaims: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const claims = await requestManager.coordination.listWorkClaims();
        writeJson(res, 200, { claims: claims.map(serializeWorkClaim) });
        return;
    },
    handoffWorkItem: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const fromActor = parseActorRef(body.from_actor, 'from_actor');
        const toActor = parseActorRef(body.to_actor, 'to_actor');
        if (!fromActor || !toActor) {
          writeError(res, 400, 'Missing required field: from_actor/to_actor');
          return;
        }
        const handoff = await requestManager.coordination.handoffWorkItem({
          workItemId: Number(params.id),
          fromActor,
          toActor,
          summary: requireString(body.summary, 'summary'),
          contextBundleRef: optionalString(body.context_bundle_ref, 'context_bundle_ref') ?? null,
          expiresAt:
            parseOptionalFiniteInteger(
              body.expires_at,
              { name: 'expires_at', min: 0 },
              failHttpValidation,
            ) ?? null,
        });
        writeJson(res, 201, { handoff: serializeHandoffRecord(handoff) });
        return;
    },
    acceptHandoff: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const id = Number(params.id);
        const action = ('accept' as string);
        const reason = optionalString(body.reason, 'reason');
        const handoff =
          action === 'accept'
            ? await requestManager.coordination.acceptHandoff(id, actor, reason)
            : action === 'reject'
              ? await requestManager.coordination.rejectHandoff(id, actor, reason)
              : await requestManager.coordination.cancelHandoff(id, actor, reason);
        writeJson(res, 200, { handoff: handoff ? serializeHandoffRecord(handoff) : null });
        return;
    },
    rejectHandoff: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const id = Number(params.id);
        const action = ('reject' as string);
        const reason = optionalString(body.reason, 'reason');
        const handoff =
          action === 'accept'
            ? await requestManager.coordination.acceptHandoff(id, actor, reason)
            : action === 'reject'
              ? await requestManager.coordination.rejectHandoff(id, actor, reason)
              : await requestManager.coordination.cancelHandoff(id, actor, reason);
        writeJson(res, 200, { handoff: handoff ? serializeHandoffRecord(handoff) : null });
        return;
    },
    cancelHandoff: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const actor = parseActorRef(body.actor, 'actor');
        if (!actor) {
          writeError(res, 400, 'Missing required field: actor');
          return;
        }
        const id = Number(params.id);
        const action = ('cancel' as string);
        const reason = optionalString(body.reason, 'reason');
        const handoff =
          action === 'accept'
            ? await requestManager.coordination.acceptHandoff(id, actor, reason)
            : action === 'reject'
              ? await requestManager.coordination.rejectHandoff(id, actor, reason)
              : await requestManager.coordination.cancelHandoff(id, actor, reason);
        writeJson(res, 200, { handoff: handoff ? serializeHandoffRecord(handoff) : null });
        return;
    },
    listPendingHandoffs: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const handoffs = await requestManager.coordination.listPendingHandoffs({
          direction: (query.direction as 'inbound' | 'outbound' | 'all' | undefined) ?? 'all',
        });
        writeJson(res, 200, { handoffs: handoffs.map(serializeHandoffRecord) });
        return;
    },
    forceCompact: async ({ req, res, query, params, readJsonBody }) => {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const result = await requestManager.forceCompact();
        writeJson(res, 200, {
          compacted: result !== null,
          archivedTurnCount: result?.archivedTurnIds.length ?? 0,
        });
        return;
    },
    getHealth: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
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
    },
    runMaintenance: async ({ req, res, query, params, readJsonBody }) => {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const report = await requestManager.runMaintenance();
        writeJson(res, 200, {
          expiredWorkingMemory: report.expiredWorkingMemoryIds.length,
          retiredKnowledge: report.retiredKnowledgeIds.length,
          deletedWorkItems: report.deletedWorkItemIds.length,
          deletedAssociationIds: report.deletedAssociationIds,
        });
        return;
    },
    reverifyKnowledgeItem: async ({ req, res, query, params, readJsonBody }) => {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const result = await requestManager.curation.reverifyKnowledge(Number(params.knowledgeId));
        writeJson(res, 200, result);
        return;
    },
    reverifyKnowledge: async ({ req, res, query, params, readJsonBody }) => {
        if (adminApiKey && !safeSecretEquals(req.headers['x-admin-key'], adminApiKey)) {
          writeError(res, 403, 'Admin key required');
          return;
        }
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        let limit: number | undefined;
        if (body.limit != null) {
          if (typeof body.limit !== 'number' || !Number.isInteger(body.limit)) {
            throw new HttpRequestError(400, 'Invalid field: limit');
          }
          limit = body.limit;
        }
        const report = await requestManager.curation.runReverification({ limit });
        writeJson(res, 200, report);
        return;
    },
    listChanges: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const cursor = parseOptionalTemporalId(query.cursor);
        const sinceValue = query.since ? new Date(query.since) : new Date(0);
        if (cursor == null && Number.isNaN(sinceValue.valueOf())) {
          writeError(res, 400, 'Invalid since parameter');
          return;
        }
        const page = await requestManager.temporal.listKnowledgeChanges({
          cursor,
          since: cursor == null ? sinceValue : undefined,
          scopeLevel: parseScopeLevel(query.scope_level, 'scope_level') ?? 'scope',
        });
        writeJson(res, 200, {
          changes: page.changes.map((change) => ({
            event_id: change.event_id,
            event_type: change.event_type,
            change_at: change.created_at,
            id: change.knowledge.id,
            fact: change.knowledge.fact,
            fact_type: change.knowledge.fact_type,
            knowledge_state: change.knowledge.knowledge_state,
            verification_status: change.knowledge.verification_status,
            trust_score: change.knowledge.trust_score,
            workspace_id: change.knowledge.workspace_id,
            scope_id: change.knowledge.scope_id,
            retired_at: change.knowledge.retired_at,
            superseded_at: change.knowledge.superseded_at,
            superseded_by_id: change.knowledge.superseded_by_id,
            created_at: change.knowledge.created_at,
            last_accessed_at: change.knowledge.last_accessed_at,
            collaboration_id: change.knowledge.collaboration_id,
          })),
          nextCursor: page.nextCursor,
        });
        return;
    },
    eventsStream: async ({ req, res, query, params, readJsonBody }) => {
        // Resolve (and tenant-check) the scope BEFORE committing a 200 stream,
        // so a cross-tenant request is rejected with 403 rather than leaking an
        // open stream bound to a tenant the key may not access.
        const scope = resolveRequestScope(config.scope, req, query);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"type":"connected"}\n\n');
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
    },
    searchEpisodes: async ({ req, res, query, params, readJsonBody }) => {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const detailLevel = query.detail
          ? requireEnum(query.detail, EPISODE_DETAIL_LEVELS, 'detail')
          : undefined;
        const episodeStartAt = parseOptionalFiniteNumber(
          query.start_at,
          { name: 'start_at' },
          failHttpValidation,
        );
        const episodeEndAt = parseOptionalFiniteNumber(
          query.end_at,
          { name: 'end_at' },
          failHttpValidation,
        );
        const episodes = await requestManager.curation.searchEpisodes({
          query: query.q,
          detailLevel,
          limit: parseLimit(query.limit),
          timeRange:
            episodeStartAt != null || episodeEndAt != null
              ? {
                  start_at: episodeStartAt,
                  end_at: episodeEndAt,
                }
              : undefined,
        });
        writeJson(res, 200, { episodes });
        return;
    },
    summarizeEpisode: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const sessionId = requireString(body.session_id, 'session_id');
        const detailLevel = body.detailLevel
          ? requireEnum(body.detailLevel, EPISODE_DETAIL_LEVELS, 'detailLevel')
          : undefined;
        const summary = await requestManager.curation.summarizeEpisode(sessionId, { detailLevel });
        writeJson(res, 200, { episode: summary });
        return;
    },
    reflect: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const reflectQuery = requireString(body.query, 'query');
        const detailLevel = body.detailLevel
          ? requireEnum(body.detailLevel, EPISODE_DETAIL_LEVELS, 'detailLevel')
          : undefined;
        const includeDeclarative = body.includeDeclarative != null ? Boolean(body.includeDeclarative) : undefined;
        const includeEpisodic = body.includeEpisodic != null ? Boolean(body.includeEpisodic) : undefined;
        const reflectLimit = parseOptionalNonNegativeInteger(body.limit, 'limit');
        const timeRange = isRecord(body.timeRange)
          ? {
              start_at: parseOptionalFiniteNumber(
                body.timeRange.start_at,
                { name: 'timeRange.start_at' },
                failHttpValidation,
              ),
              end_at: parseOptionalFiniteNumber(
                body.timeRange.end_at,
                { name: 'timeRange.end_at' },
                failHttpValidation,
              ),
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
    },
    searchCognitive: async ({ req, res, query, params, readJsonBody }) => {
        if (!query.q) {
          writeError(res, 400, 'Missing required query parameter: q');
          return;
        }
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const types = query.types
          ? (query.types.split(',').map((t) => t.trim()).filter(Boolean) as CognitiveMemoryType[])
          : undefined;
        const cogMinTrust = parseOptionalFiniteNumber(
          query.minimumTrustScore,
          { name: 'minimumTrustScore', min: 0, max: 1 },
          failHttpValidation,
        );
        const cogActiveOnly = query.activeOnly != null
          ? query.activeOnly === 'true'
          : undefined;
        const result = await requestManager.curation.searchCognitive({
          query: query.q,
          types,
          limit: parseLimit(query.limit),
          minimumTrustScore: cogMinTrust,
          activeOnly: cogActiveOnly,
        });
        writeJson(res, 200, result);
        return;
    },
    getProfile: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const validViews: ProfileView[] = ['user', 'operator', 'workspace'];
        const view = query.view
          ? requireEnum(query.view, validViews, 'view')
          : undefined;
        const validSections: ProfileSection[] = ['identity', 'preferences', 'communication', 'constraints', 'workflows'];
        const sections = query.sections
          ? query.sections.split(',').map((s) => requireEnum(s.trim(), validSections, 'sections'))
          : undefined;
        const minTrust = parseOptionalFiniteNumber(
          query.min_trust,
          { name: 'min_trust', min: 0, max: 1 },
          failHttpValidation,
        );
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
    },
    createPlaybook: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const playbook = await requestManager.playbooks.createPlaybook({
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
    },
    listPlaybooks: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        if (query.q) {
          const results = await requestManager.playbooks.searchPlaybooks(
            query.q,
            query.limit ? { limit: parseLimit(query.limit) } : undefined,
          );
          writeJson(res, 200, {
            playbooks: results.map((r) => ({ ...r.item, rank: r.rank })),
          });
        } else {
          const playbooks = await requestManager.playbooks.listPlaybooks();
          writeJson(res, 200, { playbooks });
        }
        return;
    },
    createPlaybookFromTask: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const playbook = await requestManager.playbooks.createPlaybookFromTask({
          title: requireString(body.title, 'title'),
          description: requireString(body.description, 'description'),
          sessionId: requireString(body.sessionId, 'sessionId'),
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          sourceWorkingMemoryId: parseOptionalFiniteInteger(
            body.sourceWorkingMemoryId,
            { name: 'sourceWorkingMemoryId', min: 1 },
            failHttpValidation,
          ),
        });
        writeJson(res, 201, { playbook });
        return;
    },
    getPlaybook: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const playbook = await requestManager.playbooks.getPlaybook(Number(params.playbookId));
        if (!playbook) {
          writeError(res, 404, 'Playbook not found');
          return;
        }
        writeJson(res, 200, { playbook });
        return;
    },
    updatePlaybook: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
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
        const updated = await requestManager.playbooks.updatePlaybook(Number(params.playbookId), patch);
        if (!updated) {
          writeError(res, 404, 'Playbook not found');
          return;
        }
        writeJson(res, 200, { playbook: updated });
        return;
    },
    revisePlaybook: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const result = await requestManager.playbooks.revisePlaybook(
          Number(params.playbookId),
          requireString(body.instructions, 'instructions'),
          requireString(body.revisionReason, 'revisionReason'),
          optionalString(body.sourceSessionId, 'sourceSessionId'),
        );
        writeJson(res, 200, result);
        return;
    },
    usePlaybook: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const playbookId = Number(params.playbookId);
        await requestManager.playbooks.recordPlaybookUse(playbookId);
        const playbook = await requestManager.playbooks.getPlaybook(playbookId);
        writeJson(res, 200, { recorded: true, playbook });
        return;
    },
    addAssociation: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
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
        const association = await requestManager.graph.addAssociation({
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
    },
    getAssociations: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const kind = requireEnum(params.kind, ASSOCIATION_TARGET_KINDS, 'kind');
        const targetId = Number(params.id);
        const result = await requestManager.graph.getAssociations(kind, targetId);
        writeJson(res, 200, result);
        return;
    },
    traverseAssociations: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query, body));
        const kind = requireEnum(body.kind, ASSOCIATION_TARGET_KINDS, 'kind');
        const id = Number.isInteger(body.id) && (body.id as number) > 0
          ? (body.id as number)
          : (() => { throw new HttpRequestError(400, 'Missing or invalid field: id (must be positive integer)'); })();
        const maxDepth = parseOptionalNonNegativeInteger(body.maxDepth, 'maxDepth');
        const maxNodes = parseOptionalNonNegativeInteger(body.maxNodes, 'maxNodes');
        const graph = await requestManager.graph.traverseAssociations(kind, id, { maxDepth, maxNodes });
        writeJson(res, 200, graph);
        return;
    },
    removeAssociation: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        await requestManager.graph.removeAssociation(Number(params.id));
        writeJson(res, 200, { deleted: true });
        return;
    },
    getDocument: async ({ req, res, query, params, readJsonBody }) => {
        const requestManager = await getManager(resolveRequestScope(config.scope, req, query));
        const doc = await requestManager.curation.getSourceDocument(Number(params.id));
        if (!doc) {
          writeError(res, 404, 'Document not found');
          return;
        }
        writeJson(res, 200, doc);
        return;
    },
    captureSnapshot: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const sessionId = params.id;
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        // Use session-aware manager so getContext/getSessionBootstrap read
        // the session named in the URL, not the scope's bound default.
        const requestManager = await getSessionManager(scopeInput, sessionId);
        const scopeKey = scopeKeyFor(scopeInput);
        const relevanceQuery = typeof body.relevanceQuery === 'string' ? body.relevanceQuery : undefined;
        const snapshotData = await requestManager.temporal.captureSnapshot(relevanceQuery, {
          contract:
            typeof body.contract === 'string'
              ? body.contract
              : typeof query.contract === 'string'
                ? query.contract
                : undefined,
        });
        const snapshot = {
          scopeKey,
          snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          bootstrap: snapshotData.bootstrap,
          context: snapshotData.context,
          frozenAt: snapshotData.frozenAt,
          watermarkEventId: snapshotData.watermarkEventId,
        };
        touchSnapshot(`${scopeKey}:${sessionId}`, snapshot);
        const { scopeKey: _scopeKey, ...publicSnapshot } = snapshot;
        writeJson(res, 201, { snapshot: { ...publicSnapshot, sessionId } });
        return;
    },
    getSnapshot: async ({ req, res, query, params, readJsonBody }) => {
        const sessionId = params.id;
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
    },
    refreshSnapshot: async ({ req, res, query, params, readJsonBody }) => {
        const body = await readBody(req, bodyLimitBytes);
        const sessionId = params.id;
        const scopeInput = resolveRequestScope(config.scope, req, query, body);
        const requestManager = await getSessionManager(scopeInput, sessionId);
        const scopeKey = scopeKeyFor(scopeInput);
        const relevanceQuery = typeof body.relevanceQuery === 'string' ? body.relevanceQuery : undefined;
        const snapshotData = await requestManager.temporal.captureSnapshot(relevanceQuery, {
          contract:
            typeof body.contract === 'string'
              ? body.contract
              : typeof query.contract === 'string'
                ? query.contract
                : undefined,
        });
        const snapshot = {
          scopeKey,
          snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          bootstrap: snapshotData.bootstrap,
          context: snapshotData.context,
          frozenAt: snapshotData.frozenAt,
          watermarkEventId: snapshotData.watermarkEventId,
        };
        touchSnapshot(`${scopeKey}:${sessionId}`, snapshot);
        const { scopeKey: _scopeKey, ...publicSnapshot } = snapshot;
        writeJson(res, 200, { snapshot: { ...publicSnapshot, sessionId } });
        return;
    },
  };

  // Dispatch is a loop over the registry (Phase 6.3): the matcher resolves
  // (method, path) to an operation and its path params; the handler above is
  // invoked by operation name. Completeness is enforced by construction — a
  // registry op with no handler (or vice versa) fails startup here.
  const matchOperation = createOperationMatcher(OPERATIONS);
  {
    const handlerNames = new Set(Object.keys(opHandlers));
    for (const op of OPERATIONS) {
      if (!handlerNames.has(op.name)) {
        throw new Error(`Missing HTTP handler for registry operation: ${op.name}`);
      }
    }
    for (const handlerName of handlerNames) {
      if (!OPERATIONS.some((op) => op.name === handlerName)) {
        throw new Error(`HTTP handler has no registry operation: ${handlerName}`);
      }
    }
  }

  const server = createServer(async (req, res) => {
    // CORS (1.2): apply the resolved policy. Default is same-origin only — no
    // Access-Control-Allow-Origin header at all, so browsers block cross-origin
    // reads. Only an explicit MEMORY_CORS_ORIGIN opens it up. Preflight OPTIONS
    // reflects the same policy (applyCors runs before the OPTIONS short-circuit).
    applyCors(res, corsPolicy, req.headers.origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = req.url ?? '/';
    const requestPath = normalizePath(requestUrl.split('?')[0]);
    const isHealthProbe =
      (requestPath === '/healthz' || requestPath === '/readyz') && req.method === 'GET';

    // Liveness/readiness probes must never require auth (1.2): they leak nothing
    // and orchestrators (Docker/k8s) probe them without credentials. Handle them
    // before authentication so a keyless probe returns 200 even when keys are
    // configured. They are also exempt from the rate limiter below.
    if (isHealthProbe) {
      writeJson(res, 200, { ok: true, scopes: serverContext.getCacheSizes().managers });
      return;
    }

    // Auth (1.1): resolve the principal against the tenant-bound registry, or
    // fall back to the legacy single key. A configured-but-unmatched request is
    // 401; keyless mode yields an undefined principal (no enforcement).
    const principal = authenticatePrincipal(req, apiKeyRegistry, apiKey);
    if (principal === null) {
      writeError(res, 401, 'Unauthorized');
      return;
    }
    if (principal) {
      requestPrincipals.set(req, principal);
    }

    // Rate limiting (1.4): per-key token bucket, keyed by the presented key or
    // the remote address when keyless. Health probes are always exempt.
    if (rateLimiter && !isHealthProbe) {
      const bucketKey =
        extractBearer(req.headers.authorization) ??
        req.socket.remoteAddress ??
        'unknown';
      const decision = rateLimiter.take(bucketKey);
      if (!decision.ok) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        writeError(res, 429, 'Too Many Requests');
        return;
      }
    }

    try {
      const url = requestUrl;
      const path = requestPath;
      const query = parseQuery(url);
      let cachedBody: Record<string, unknown> | undefined;
      const readJsonBody = async () => {
        if (cachedBody) return cachedBody;
        cachedBody = await readBody(req, bodyLimitBytes);
        return cachedBody;
      };
      const matched = matchOperation(req.method ?? 'GET', path);
      if (matched) {
        if (matched.spec.auth === 'admin') {
          requireAdmin(req);
        }
        await opHandlers[matched.spec.name]({ req, res, query, params: matched.params, readJsonBody });
        return;
      }
      // Do not echo the attacker-controlled method/path back into the body.
      writeError(res, 404, 'Not found');
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeError(res, error.status, error.message);
        return;
      }
      if (isMemoryDomainError(error)) {
        writeError(res, error.status, error.message, error.code);
        return;
      }
      // 1.3: never leak internal error text or stacks to clients. Return a
      // generic body with a short random request id and log the real error
      // (with the same id) server-side for correlation.
      const requestId = randomBytes(6).toString('hex');
      console.error(`[memory-layer] internal error (request ${requestId}):`, error);
      writeJson(res, 500, { error: 'internal error', requestId });
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
          sessionSnapshots.clear();
          await serverContext.close();
        },
      });
    });
  });
}
