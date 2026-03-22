export const DEFAULT_WORKSPACE_ID = 'default';
export type ScopeLevel = 'scope' | 'workspace' | 'system' | 'tenant';

export interface MemoryScope {
  tenant_id: string;
  system_id: string;
  workspace_id?: string;
  scope_id: string;
}

export interface NormalizedMemoryScope {
  tenant_id: string;
  system_id: string;
  workspace_id: string;
  scope_id: string;
}

export interface ScopeQuery {
  scope: MemoryScope;
  level: ScopeLevel;
}

function assertScopeValue(value: string | undefined, name: keyof MemoryScope): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Memory validation: '${name}' must not be empty`);
  }
  return value.trim();
}

export function normalizeScope(scope: MemoryScope): NormalizedMemoryScope {
  return {
    tenant_id: assertScopeValue(scope.tenant_id, 'tenant_id'),
    system_id: assertScopeValue(scope.system_id, 'system_id'),
    workspace_id: scope.workspace_id?.trim() || DEFAULT_WORKSPACE_ID,
    scope_id: assertScopeValue(scope.scope_id, 'scope_id'),
  };
}

export function scopeValues(scope: MemoryScope): [string, string, string, string] {
  const normalized = normalizeScope(scope);
  return [
    normalized.tenant_id,
    normalized.system_id,
    normalized.workspace_id,
    normalized.scope_id,
  ];
}

export function widenScope(scope: MemoryScope, level: ScopeLevel): ScopeQuery {
  return {
    scope: normalizeScope(scope),
    level,
  };
}
