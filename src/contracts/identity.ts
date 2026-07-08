import { ValidationError } from './errors.js';

export const DEFAULT_WORKSPACE_ID = 'default';
export type ScopeLevel = 'scope' | 'workspace' | 'system' | 'tenant';

export interface MemoryScope {
  /** Multi-tenant partition. */
  tenant_id: string;
  /** Calling agent or system identity, not a shared-memory boundary. */
  system_id: string;
  /** Workspace or project boundary. */
  workspace_id?: string;
  /** Explicit shared-memory boundary across multiple systems or agents. */
  collaboration_id?: string;
  /** Task, thread, or branch boundary within a workspace/collaboration. */
  scope_id: string;
}

export interface NormalizedMemoryScope {
  tenant_id: string;
  system_id: string;
  workspace_id: string;
  collaboration_id: string;
  scope_id: string;
}

export interface ScopeQuery {
  scope: MemoryScope;
  level: ScopeLevel;
}

function assertScopeValue(value: string | undefined, name: keyof MemoryScope): string {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`Memory validation: '${name}' must not be empty`);
  }
  return value.trim();
}

export function normalizeScope(scope: MemoryScope): NormalizedMemoryScope {
  const workspaceId = scope.workspace_id?.trim() || DEFAULT_WORKSPACE_ID;
  return {
    tenant_id: assertScopeValue(scope.tenant_id, 'tenant_id'),
    system_id: assertScopeValue(scope.system_id, 'system_id'),
    workspace_id: workspaceId,
    collaboration_id: scope.collaboration_id?.trim() || '',
    scope_id: assertScopeValue(scope.scope_id, 'scope_id'),
  };
}

export function scopeValues(scope: MemoryScope): [string, string, string, string, string] {
  const normalized = normalizeScope(scope);
  return [
    normalized.tenant_id,
    normalized.system_id,
    normalized.workspace_id,
    normalized.collaboration_id,
    normalized.scope_id,
  ];
}

export function matchesScope(leftScope: MemoryScope, rightScope: MemoryScope): boolean {
  const left = normalizeScope(leftScope);
  const right = normalizeScope(rightScope);
  return (
    left.tenant_id === right.tenant_id &&
    left.system_id === right.system_id &&
    left.workspace_id === right.workspace_id &&
    left.collaboration_id === right.collaboration_id &&
    left.scope_id === right.scope_id
  );
}

/**
 * Scope-widening match (Phase 3.9). Decides whether `itemScope` falls within the
 * breadth requested by `targetScope` at `level`. This is the BREADTH dimension
 * only; it is ANDed with the visibility ACCESS gate
 * (`shared/visibility.isBaseVisible`) on every cross-scope read path (P6).
 *
 * Widening matrix (fields compared as normalized; workspace_id defaults to
 * `'default'`, collaboration_id defaults to `''`):
 *
 * | level       | tenant_id | system_id | workspace_id | collaboration_id | scope_id |
 * |-------------|-----------|-----------|--------------|------------------|----------|
 * | `tenant`    | =         | (ignored) | (ignored)    | (ignored)        | (ignored)|
 * | `system`    | =         | =         | (ignored)    | (ignored)        | (ignored)|
 * | `workspace` | =         | (ignored) | =            | (ignored)        | (ignored)|
 * | `scope`     | =         | =         | =            | =                | =        |
 *
 * Two deliberate caveats, documented rather than silently relied upon:
 *  - `workspace` widening IGNORES `system_id` — a workspace is shared across the
 *    agents/systems working in it. Cross-system leakage of NON-workspace-visible
 *    records is prevented by the visibility gate, not by this function.
 *  - NO level filters on `collaboration_id`. `shared_collaboration` records are
 *    gated by collaboration_id at the VISIBILITY layer
 *    (`isBaseVisible` requires a matching non-empty collaboration_id), which is
 *    how "shared_collaboration items don't surface outside their collaboration"
 *    (3.9 AC) is enforced — the collaboration dimension lives in visibility, not
 *    in the widening level.
 *  - `workspace_id` defaults to `'default'`, so unrelated systems that never set
 *    a workspace co-mingle at `workspace` widening. Callers isolating tenants
 *    across systems should set an explicit `workspace_id`.
 *
 * See docs/SCOPE_MODEL.md for the full model.
 */
export function matchesScopeLevel(
  itemScope: MemoryScope,
  targetScope: MemoryScope,
  level: ScopeLevel,
): boolean {
  const item = normalizeScope(itemScope);
  const target = normalizeScope(targetScope);
  if (item.tenant_id !== target.tenant_id) return false;
  if (level === 'tenant') return true;
  if (level === 'workspace') return item.workspace_id === target.workspace_id;
  if (item.system_id !== target.system_id) return false;
  if (level === 'system') return true;
  return matchesScope(item, target);
}

export function widenScope(scope: MemoryScope, level: ScopeLevel): ScopeQuery {
  return {
    scope: normalizeScope(scope),
    level,
  };
}
