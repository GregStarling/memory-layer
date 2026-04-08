import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import type { MemoryScope } from '../contracts/identity.js';

const require = createRequire(import.meta.url);

type BetterSqliteConstructor = typeof import('better-sqlite3');

function loadBetterSqlite3(): BetterSqliteConstructor {
  return require('better-sqlite3') as BetterSqliteConstructor;
}

describe('sqlite collaboration_id migration repair', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      rmSync(cleanupPaths.pop()!, { force: true, recursive: true });
    }
  });

  it('repairs legacy default collaboration rows so they are visible through default-scope reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-layer-collab-'));
    cleanupPaths.push(dir);
    const dbPath = join(dir, 'memory.db');
    const scope: MemoryScope = {
      tenant_id: 'acme',
      system_id: 'assistant',
      workspace_id: 'shared',
      scope_id: 'thread-1',
    };

    const bootstrap = createSQLiteAdapter(dbPath);
    bootstrap.close();

    const BetterSqlite3 = loadBetterSqlite3();
    const raw = new BetterSqlite3(dbPath);
    raw.prepare(
      `INSERT INTO knowledge_memory
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type, source, confidence, created_at, last_accessed_at)
       VALUES (?, ?, ?, 'default', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.tenant_id,
      scope.system_id,
      scope.workspace_id,
      scope.scope_id,
      'Legacy shared fact',
      'reference',
      'manual',
      'high',
      1,
      1,
    );
    raw.close();

    const repaired = createSQLiteAdapter(dbPath);
    try {
      const knowledge = repaired.getActiveKnowledgeMemory(scope);
      expect(knowledge).toHaveLength(1);
      expect(knowledge[0].fact).toBe('Legacy shared fact');
      expect(knowledge[0].collaboration_id).toBe('');
    } finally {
      repaired.close();
    }
  });
});
