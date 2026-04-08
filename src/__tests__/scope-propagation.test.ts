import { describe, it, expect } from 'vitest';
import { scopeKeyFor, withScopeManagers } from '../server/scope-propagation.js';
import type { MemoryManager } from '../core/manager.js';

function stubManager(id: string): MemoryManager {
  return { _id: id } as unknown as MemoryManager;
}

describe('scopeKeyFor', () => {
  it('normalizes string input to the default scope key', () => {
    expect(scopeKeyFor('default')).toBe(
      scopeKeyFor({
        tenant_id: 'default',
        system_id: 'default',
        scope_id: 'default',
      }),
    );
  });

  it('returns JSON for MemoryScope input', () => {
    const key = scopeKeyFor({
      tenant_id: 't',
      system_id: 's',
      scope_id: 'sc',
    });
    expect(key).toContain('"tenant_id"');
    expect(key).toContain('"system_id"');
  });
});

describe('withScopeManagers', () => {
  it('invokes callback on the base manager', async () => {
    const base = stubManager('base');
    const visited: MemoryManager[] = [];
    await withScopeManagers(
      'default',
      new Map(),
      () => base,
      async (m) => { visited.push(m); },
    );
    expect(visited).toEqual([base]);
  });

  it('invokes callback on session-scoped managers matching the base key', async () => {
    const base = stubManager('base');
    const session1 = stubManager('s1');
    const session2 = stubManager('s2');
    const unrelated = stubManager('other');
    const defaultKey = scopeKeyFor('default');
    const sessions = new Map<string, MemoryManager>([
      [`${defaultKey}|session:a`, session1],
      [`${defaultKey}|session:b`, session2],
      [`${scopeKeyFor('other')}|session:c`, unrelated],
    ]);
    const visited: MemoryManager[] = [];
    await withScopeManagers(
      'default',
      sessions,
      () => base,
      async (m) => { visited.push(m); },
    );
    expect(visited).toEqual([base, session1, session2]);
  });

  it('deduplicates when base manager appears in session map', async () => {
    const shared = stubManager('shared');
    const sessions = new Map<string, MemoryManager>([
      [`${scopeKeyFor('default')}|session:a`, shared],
    ]);
    const visited: MemoryManager[] = [];
    await withScopeManagers(
      'default',
      sessions,
      () => shared,
      async (m) => { visited.push(m); },
    );
    expect(visited).toEqual([shared]);
  });

  it('works with async getBaseManager', async () => {
    const base = stubManager('async-base');
    const visited: MemoryManager[] = [];
    await withScopeManagers(
      'default',
      new Map(),
      async () => base,
      async (m) => { visited.push(m); },
    );
    expect(visited).toEqual([base]);
  });
});
