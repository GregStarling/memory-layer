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
    // Simulate a pre-v16 database so the backfill runs on next open
    raw.prepare('UPDATE schema_meta SET schema_version = 15 WHERE id = 1').run();
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

  it('rewrites legacy source collaboration ids to the canonical empty string and stays idempotent across reopen', () => {
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
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type, source,
         confidence, source_system_id, source_scope_id, source_collaboration_id, created_at, last_accessed_at)
       VALUES (?, ?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, 'default', ?, ?)`,
    ).run(
      scope.tenant_id,
      scope.system_id,
      scope.workspace_id,
      scope.scope_id,
      'Legacy sourced fact',
      'reference',
      'manual',
      'high',
      scope.system_id,
      scope.scope_id,
      1,
      1,
    );
    // Simulate a pre-v16 database so the backfill runs on next open
    raw.prepare('UPDATE schema_meta SET schema_version = 15 WHERE id = 1').run();
    raw.close();

    const repaired = createSQLiteAdapter(dbPath);
    repaired.close();

    const inspected = new BetterSqlite3(dbPath);
    const row = inspected
      .prepare('SELECT collaboration_id, source_collaboration_id FROM knowledge_memory LIMIT 1')
      .get() as { collaboration_id: string; source_collaboration_id: string | null };
    inspected.close();

    expect(row.collaboration_id).toBe('');
    expect(row.source_collaboration_id).toBe('');

    const reopened = createSQLiteAdapter(dbPath);
    try {
      const knowledge = reopened.getActiveKnowledgeMemory(scope);
      expect(knowledge).toHaveLength(1);
      expect(knowledge[0].source_collaboration_id).toBe('');
    } finally {
      reopened.close();
    }
  });

  it('preserves non-empty collaboration ids while repairing only legacy defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-layer-collab-'));
    cleanupPaths.push(dir);
    const dbPath = join(dir, 'memory.db');
    const scope: MemoryScope = {
      tenant_id: 'acme',
      system_id: 'assistant',
      workspace_id: 'shared',
      collaboration_id: 'team-alpha',
      scope_id: 'thread-1',
    };

    const bootstrap = createSQLiteAdapter(dbPath);
    bootstrap.close();

    const BetterSqlite3 = loadBetterSqlite3();
    const raw = new BetterSqlite3(dbPath);
    raw.prepare(
      `INSERT INTO knowledge_memory
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type, source, confidence, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.tenant_id,
      scope.system_id,
      scope.workspace_id,
      scope.collaboration_id,
      scope.scope_id,
      'Team-specific fact',
      'reference',
      'manual',
      'high',
      1,
      1,
    );
    raw.close();

    const repaired = createSQLiteAdapter(dbPath);
    try {
      const exactScope = repaired.getActiveKnowledgeMemory(scope);
      expect(exactScope).toHaveLength(1);
      expect(exactScope[0].collaboration_id).toBe('team-alpha');

      const defaultScope = repaired.getActiveKnowledgeMemory({
        tenant_id: scope.tenant_id,
        system_id: scope.system_id,
        workspace_id: scope.workspace_id,
        scope_id: scope.scope_id,
      });
      expect(defaultScope).toHaveLength(0);
    } finally {
      repaired.close();
    }
  });
});
