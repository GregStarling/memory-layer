import { normalizeScope, type MemoryScope } from '../contracts/identity.js';
import type { MemoryManager } from '../core/manager.js';

export function scopeKeyFor(scopeInput: string | MemoryScope): string {
  return typeof scopeInput === 'string'
    ? `scope:${scopeInput}`
    : JSON.stringify(normalizeScope(scopeInput));
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
