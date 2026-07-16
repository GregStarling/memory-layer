/**
 * Operation registry types (Phase 6.3).
 *
 * The registry is the single structural source of truth for the server's
 * transport surface. Each entry declares one HTTP operation — its method,
 * path (OpenAPI-style `{param}` templates with an optional `:type` matcher
 * hint), authentication tier, and (optionally) the MCP tool it is exposed as.
 *
 * The registry is pure data with zero server coupling: `http-server.ts`
 * imports it to drive dispatch by construction (a loop over the entries),
 * `mcp-server.ts` imports it to curate the advertised tool list, and the
 * OpenAPI parity test imports it to assert spec ⇆ registry path coverage.
 *
 * Manager decision D-REG (scoped down from the plan text): the registry drives
 * HTTP dispatch and MCP tool *membership* by construction; `openapi.yaml`
 * remains the authored source of truth for request/response *shapes* (full
 * YAML generation is deferred). Parity is therefore structural — registry ⇆
 * spec path/method sets are asserted bidirectionally in tests.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** Authentication tier enforced by the HTTP dispatcher before the handler runs. */
export type OperationAuth =
  /** Tenant-scoped: the handler resolves scope via resolveRequestScope (tenant binding). */
  | 'tenant'
  /** Admin: requires the x-admin-key header (requireAdmin) in addition to scope resolution. */
  | 'admin'
  /** Unauthenticated: handled before the auth gate (health probes only). */
  | 'none';

/**
 * MCP exposure for an operation.
 *
 * D-REG note: the rich `description`/`inputSchema` for each tool stay authored
 * next to their `callTool` dispatch in `mcp-server.ts` (moving ~900 lines of
 * hand-written JSON Schema carries more risk than the parity it buys — the
 * same reasoning that deferred generated `openapi.yaml`). The registry owns
 * tool *membership* and *curation* (`core`), joined to the authored schema by
 * `toolName`, with a bidirectional parity test guarding drift.
 */
export interface OperationMcp {
  /** The MCP tool name (e.g. `memory_get_context`). */
  toolName: string;
  /**
   * Whether this tool is in the default "core" set (the daily drivers). Core
   * tools are always advertised; non-core tools require the admin/full set to
   * be enabled (MEMORY_MCP_ADMIN_TOOLS=1 / config.adminTools / --admin-tools).
   */
  core: boolean;
}

export interface OperationSpec {
  /** Unique, stable internal name for the operation. */
  name: string;
  http: {
    method: HttpMethod;
    /**
     * Path template. Parameters use `{name}` (OpenAPI-compatible) with an
     * optional matcher hint: `{id:int}` → digits, `{kind:slug}` → `[a-z_]+`,
     * `{name}` / `{name:str}` → any non-slash segment.
     */
    path: string;
  };
  auth: OperationAuth;
  mcp?: OperationMcp;
}

/** Collapse every `{...}` path parameter to `{}` so a registry path and its
 * documented spec path compare equal regardless of param name or matcher hint.
 * Mirrors the normalization used by the OpenAPI parity test. */
export function normalizeOperationPath(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

interface CompiledMatcher {
  spec: OperationSpec;
  regexp: RegExp;
  paramNames: string[];
}

function paramPattern(hint: string | undefined): string {
  switch (hint) {
    case 'int':
      return '(\\d+)';
    case 'slug':
      return '([a-z_]+)';
    default:
      return '([^/]+)';
  }
}

function compile(spec: OperationSpec): CompiledMatcher {
  const paramNames: string[] = [];
  const source = spec.http.path.replace(/\{([^}]+)\}/g, (_full, inner: string) => {
    const [rawName, hint] = inner.split(':');
    paramNames.push(rawName);
    return paramPattern(hint);
  });
  return {
    spec,
    regexp: new RegExp(`^${source}$`),
    paramNames,
  };
}

export interface OperationMatch {
  spec: OperationSpec;
  params: Record<string, string>;
}

/**
 * Build a matcher over a set of operations. Returns a function that resolves
 * a `(method, path)` pair to the matching operation and its extracted path
 * params, or `undefined` when nothing matches. Matching is order-preserving
 * (first match wins), mirroring the original if-chain semantics.
 */
export function createOperationMatcher(
  operations: readonly OperationSpec[],
): (method: string, path: string) => OperationMatch | undefined {
  const compiled = operations.map(compile);
  return (method, path) => {
    for (const entry of compiled) {
      if (entry.spec.http.method !== method) continue;
      const match = entry.regexp.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      entry.paramNames.forEach((paramName, index) => {
        params[paramName] = decodeURIComponent(match[index + 1]);
      });
      return { spec: entry.spec, params };
    }
    return undefined;
  };
}
