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

export function widenScope(scope: MemoryScope, level: ScopeLevel): ScopeQuery {
  return {
    scope: normalizeScope(scope),
    level,
  };
}
