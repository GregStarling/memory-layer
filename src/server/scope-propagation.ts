import { normalizeScope, type MemoryScope } from '../contracts/identity.js';
import type { MemoryManager } from '../core/manager.js';

function materializeScope(scopeInput: string | MemoryScope): MemoryScope {
  return typeof scopeInput === 'string'
    ? {
        tenant_id: 'default',
        system_id: 'default',
        scope_id: scopeInput,
      }
    : scopeInput;
}

export function scopeKeyFor(scopeInput: string | MemoryScope): string {
  return JSON.stringify(normalizeScope(materializeScope(scopeInput)));
}

/**
 * Apply a callback to the base manager and all session-scoped managers
 * that share the same scope prefix. Works with both sync and async
 * manager resolution.
 */
export async function withScopeManagers(
  scopeInput: string | MemoryScope,
  sessionManagers: Map<string, MemoryManager>,
  getBaseManager: (input: string | MemoryScope) => MemoryManager | Promise<MemoryManager>,
  callback: (manager: MemoryManager) => Promise<void>,
): Promise<void> {
  const baseKey = scopeKeyFor(scopeInput);
  const seen = new Set<MemoryManager>();
  const scopedManagers: MemoryManager[] = [await getBaseManager(scopeInput)];
  for (const [key, manager] of sessionManagers.entries()) {
    if (key.startsWith(`${baseKey}|session:`)) {
      scopedManagers.push(manager);
    }
  }
  for (const manager of scopedManagers) {
    if (seen.has(manager)) continue;
    seen.add(manager);
    await callback(manager);
  }
}
