import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createSQLiteSchema, CURRENT_SCHEMA_VERSION } from '../adapters/sqlite/schema.js';
import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';

/**
 * Build a database at schema version 17 with a v17-shaped context_contracts
 * table holding the legacy `__default__` sentinel rows, so the v17→v18 rebuild
 * has real data to migrate. Only the governance tables and schema_meta are
 * pre-created; createSQLiteSchema creates everything else via IF NOT EXISTS.
 */
function seedV17Database(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE context_contracts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      name              TEXT,
      is_default        INTEGER NOT NULL DEFAULT 0,
      is_deleted        INTEGER NOT NULL DEFAULT 0,
      contract_json     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE TABLE context_invariants (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         TEXT    NOT NULL,
      system_id         TEXT    NOT NULL,
      workspace_id      TEXT    NOT NULL DEFAULT 'default',
      collaboration_id  TEXT    NOT NULL DEFAULT '',
      scope_id          TEXT    NOT NULL,
      invariant_id      TEXT    NOT NULL,
      title             TEXT,
      instruction       TEXT,
      severity          TEXT,
      scope_level       TEXT,
      is_deleted        INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO schema_meta (id, schema_version, updated_at) VALUES (1, 17, 0)').run();
  db.prepare(
    `INSERT INTO context_contracts
      (tenant_id, system_id, scope_id, name, is_default, is_deleted, contract_json, created_at, updated_at)
     VALUES ('acme', 'assistant', 'thread-1', '__default__', 1, 0, '{"v":1}', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO context_contracts
      (tenant_id, system_id, scope_id, name, is_default, is_deleted, contract_json, created_at, updated_at)
     VALUES ('acme', 'assistant', 'thread-1', 'named', 0, 0, '{"v":2}', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO context_invariants
      (tenant_id, system_id, scope_id, invariant_id, title, instruction, severity, scope_level, is_deleted, created_at, updated_at)
     VALUES ('acme', 'assistant', 'thread-1', 'inv-1', 'No secrets', 'Never leak secrets', 'high', 'scope', 0, 1, 1)`,
  ).run();
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name),
  );
}

function schemaVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get() as {
      schema_version: number;
    }
  ).schema_version;
}

describe('SQLite migrations (plan 0.3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-mig-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps a fresh database at the current schema version', () => {
    const db = new Database(join(dir, 'fresh.db'));
    createSQLiteSchema(db);
    expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableExists(db, 'work_claims_current')).toBe(true);
    expect(tableExists(db, 'work_claims_history')).toBe(true);
    db.close();
  });

  it('is stamped at v21 for the embedding model/dimensions versioning (2.4)', () => {
    const db = new Database(join(dir, 'v21.db'));
    createSQLiteSchema(db);
    expect(CURRENT_SCHEMA_VERSION).toBe(21);
    expect(schemaVersion(db)).toBe(21);
    db.close();
  });

  function embeddingColumns(db: Database.Database): string[] {
    return (db.prepare("PRAGMA table_info('knowledge_embeddings')").all() as Array<{
      name: string;
    }>).map((c) => c.name);
  }

  it('createSQLiteSchema alone (no embedding adapter) produces the v21 model/dimensions columns (item 6)', () => {
    // Regression: v21 must be a REAL migration in schema.ts, not a bare version
    // stamp. Before the fix, the columns lived only in ensureEmbeddingSchema
    // (run when the embedding adapter is constructed), so a plain
    // createSQLiteSchema stamped v21 without the columns — and the Phase 0
    // downgrade guard then blocked reopening with 4.2.x for no real change.
    const db = new Database(join(dir, 'plain-v21.db'));
    createSQLiteSchema(db);
    expect(schemaVersion(db)).toBe(21);
    const columns = embeddingColumns(db);
    expect(columns).toContain('model');
    expect(columns).toContain('dimensions');
    db.close();
  });

  it('migrates a v20 db: adds model, backfills dimensions from blob length, and reopen no-ops (item 6)', () => {
    const path = join(dir, 'v20.db');
    const seed = new Database(path);
    // A pre-v21 (v20) database: stamped at 20 with a legacy knowledge_embeddings
    // table that lacks the `model` column and has a NULL-dimensions row
    // (a 3-float vector = 12 bytes). createSQLiteSchema builds the rest via
    // IF NOT EXISTS.
    seed.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE knowledge_embeddings (
        knowledge_memory_id INTEGER PRIMARY KEY,
        vector BLOB NOT NULL,
        dimensions INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    seed.prepare('INSERT INTO schema_meta (id, schema_version, updated_at) VALUES (1, 20, 0)').run();
    const buf = Buffer.from(new Float32Array([1, 0, 0]).buffer);
    seed
      .prepare('INSERT INTO knowledge_embeddings (knowledge_memory_id, vector, dimensions, created_at) VALUES (?, ?, NULL, 0)')
      .run(1, buf);
    seed.close();

    // First open runs the v21 migration: adds `model`, backfills dimensions
    // (12 bytes / 4 = 3), stamps v21.
    const first = new Database(path);
    createSQLiteSchema(first);
    expect(schemaVersion(first)).toBe(21);
    expect(embeddingColumns(first)).toContain('model');
    const row = first
      .prepare('SELECT dimensions, model FROM knowledge_embeddings WHERE knowledge_memory_id = 1')
      .get() as { dimensions: number; model: string };
    expect(row.dimensions).toBe(3);
    expect(row.model).toBe('unknown');
    first.close();

    // Reopen is a no-op (idempotent): the row is untouched and version stays v21.
    const second = new Database(path);
    createSQLiteSchema(second);
    expect(schemaVersion(second)).toBe(21);
    const reRow = second
      .prepare('SELECT dimensions, model FROM knowledge_embeddings WHERE knowledge_memory_id = 1')
      .get() as { dimensions: number; model: string };
    expect(reRow).toEqual({ dimensions: 3, model: 'unknown' });
    second.close();
  });

  it('the embedding adapter path also carries the model/dimensions columns (2.4)', () => {
    // The defensive ensureEmbeddingSchema still yields the same shape when the
    // embedding adapter is constructed on a fresh database.
    const path = join(dir, 'adapter-embeddings.db');
    const adapter = createSQLiteAdapterWithEmbeddings(path);
    const raw = adapter as unknown as { close(): void };
    const inner = new Database(path);
    const columns = embeddingColumns(inner);
    expect(columns).toContain('model');
    expect(columns).toContain('dimensions');
    inner.close();
    raw.close();
  });

  it('completes the v17→v18 rebuild and stamps the version last', () => {
    const path = join(dir, 'v17.db');
    const seed = new Database(path);
    seedV17Database(seed);
    seed.close();

    const db = new Database(path);
    createSQLiteSchema(db);

    // Data transformed: the sentinel default row now has NULL name + is_default,
    // the named row survives, and no _v17 tables are stranded.
    expect(tableExists(db, 'context_contracts_v17')).toBe(false);
    expect(tableExists(db, 'context_invariants_v17')).toBe(false);
    const rows = db
      .prepare('SELECT name, is_default FROM context_contracts ORDER BY is_default DESC')
      .all() as Array<{ name: string | null; is_default: number }>;
    expect(rows).toEqual([
      { name: null, is_default: 1 },
      { name: 'named', is_default: 0 },
    ]);
    expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('preserves user-written live rows and quarantines stranded _v17 data (0.3c)', () => {
    // Reviewer scenario: an OLD-code v17→v18 migration stamped the schema version
    // BEFORE the rebuild ran, then crashed. On reopen the user wrote rows into the
    // live tables. Result: live context_contracts/context_invariants hold recent
    // user rows AND stale *_v17 tables are still present. The recovery path must
    // NOT drop/overwrite the live rows — it must quarantine the _v17 tables.
    const path = join(dir, 'stranded.db');
    const seed = new Database(path);
    seedV17Database(seed);
    // Old code already advanced the version despite not finishing the rebuild.
    seed.prepare('UPDATE schema_meta SET schema_version = 18 WHERE id = 1').run();
    // Simulate the interrupted RENAME step: the pre-migration governance data is
    // stranded under *_v17. (seedV17Database created v17-shaped live tables; move
    // them aside to mimic the crash-after-rename state.)
    seed.exec(`
      ALTER TABLE context_contracts RENAME TO context_contracts_v17;
      ALTER TABLE context_invariants RENAME TO context_invariants_v17;
    `);
    // The user then reopened with new code and wrote fresh rows into freshly
    // created live tables (v18 shape). Recreate that live-table state here.
    seed.exec(`
      CREATE TABLE context_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, system_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        collaboration_id TEXT NOT NULL DEFAULT '',
        scope_id TEXT NOT NULL, name TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        contract_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE context_invariants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, system_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        collaboration_id TEXT NOT NULL DEFAULT '',
        scope_id TEXT NOT NULL, invariant_id TEXT NOT NULL,
        title TEXT, instruction TEXT, severity TEXT, scope_level TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    seed.prepare(
      `INSERT INTO context_contracts
        (tenant_id, system_id, scope_id, name, is_default, is_deleted, contract_json, created_at, updated_at)
       VALUES ('acme', 'assistant', 'thread-1', 'user-written', 0, 0, '{"v":99}', 500, 500)`,
    ).run();
    seed.prepare(
      `INSERT INTO context_invariants
        (tenant_id, system_id, scope_id, invariant_id, title, instruction, severity, scope_level, is_deleted, created_at, updated_at)
       VALUES ('acme', 'assistant', 'thread-1', 'user-inv', 'User rule', 'Do the thing', 'high', 'scope', 0, 500, 500)`,
    ).run();
    seed.close();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const db = new Database(path);
      createSQLiteSchema(db);

      // The user-written rows survived untouched.
      const contracts = db
        .prepare('SELECT name FROM context_contracts ORDER BY name')
        .all() as Array<{ name: string | null }>;
      expect(contracts).toEqual([{ name: 'user-written' }]);
      const invariants = db
        .prepare('SELECT invariant_id FROM context_invariants ORDER BY invariant_id')
        .all() as Array<{ invariant_id: string }>;
      expect(invariants).toEqual([{ invariant_id: 'user-inv' }]);

      // The stale _v17 tables were quarantined (renamed aside), not dropped.
      expect(tableExists(db, 'context_contracts_v17')).toBe(false);
      expect(tableExists(db, 'context_invariants_v17')).toBe(false);
      expect(tableExists(db, 'context_contracts_v17_orphaned')).toBe(true);
      expect(tableExists(db, 'context_invariants_v17_orphaned')).toBe(true);
      // The orphaned copy still holds the original pre-migration rows.
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM context_contracts_v17_orphaned').get() as { n: number }).n,
      ).toBe(2);

      // The operator was warned for both tables.
      expect(warnings.some((w) => w.includes('context_contracts_v17_orphaned'))).toBe(true);
      expect(warnings.some((w) => w.includes('context_invariants_v17_orphaned'))).toBe(true);
      db.close();

      // Subsequent opens no longer trigger recovery: no new _v17 tables appear
      // and the user rows remain intact.
      warnings.length = 0;
      const reopened = new Database(path);
      createSQLiteSchema(reopened);
      expect(tableExists(reopened, 'context_contracts_v17')).toBe(false);
      expect(tableExists(reopened, 'context_invariants_v17')).toBe(false);
      expect(
        (reopened.prepare('SELECT COUNT(*) AS n FROM context_contracts').get() as { n: number }).n,
      ).toBe(1);
      expect(warnings).toHaveLength(0);
      reopened.close();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('rolls back atomically on a mid-rebuild failure, leaving no stranded _v17 data', () => {
    const path = join(dir, 'crash.db');
    const seed = new Database(path);
    seedV17Database(seed);
    seed.close();

    // Open and inject a fault into the copy step of the v17→v18 rebuild by
    // making exec throw the first time it runs an INSERT into the rebuilt
    // context_contracts table.
    const db = new Database(path);
    const realExec = db.exec.bind(db);
    let faulted = false;
    (db as unknown as { exec: (sql: string) => Database.Database }).exec = (sql: string) => {
      if (!faulted && /INSERT INTO context_contracts\b/i.test(sql)) {
        faulted = true;
        throw new Error('simulated crash mid-rebuild');
      }
      return realExec(sql);
    };

    expect(() => createSQLiteSchema(db)).toThrow('simulated crash mid-rebuild');

    // Restore exec and inspect: the transaction rolled back. The original v17
    // table and data are intact; no _v17 table was left stranded; the version
    // was NOT advanced.
    (db as unknown as { exec: typeof realExec }).exec = realExec;
    expect(tableExists(db, 'context_contracts_v17')).toBe(false);
    expect(tableExists(db, 'context_contracts')).toBe(true);
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM context_contracts').get() as { n: number }
    ).n;
    expect(count).toBe(2);
    expect(schemaVersion(db)).toBe(17);
    db.close();

    // Re-opening cleanly (no fault) completes the migration.
    const reopened = new Database(path);
    createSQLiteSchema(reopened);
    expect(schemaVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableExists(reopened, 'context_contracts_v17')).toBe(false);
    expect(
      (reopened.prepare('SELECT COUNT(*) AS n FROM context_contracts').get() as { n: number }).n,
    ).toBe(2);
    reopened.close();
  });

  it('throws when opening a database created by a newer version (downgrade guard)', () => {
    const path = join(dir, 'newer.db');
    const setup = new Database(path);
    createSQLiteSchema(setup);
    setup
      .prepare('UPDATE schema_meta SET schema_version = ? WHERE id = 1')
      .run(CURRENT_SCHEMA_VERSION + 1);
    setup.close();

    const db = new Database(path);
    expect(() => createSQLiteSchema(db)).toThrow(/newer version/i);
    db.close();
  });

  it('rethrows a real ALTER failure instead of swallowing it', () => {
    // A locked/disk error surfaces as a non-"duplicate column"/"no such table"
    // message; the probe filter must not swallow it. We simulate by making exec
    // throw a disk-full-like error on the first ALTER probe.
    const db = new Database(join(dir, 'realfail.db'));
    const realExec = db.exec.bind(db);
    (db as unknown as { exec: (sql: string) => Database.Database }).exec = (sql: string) => {
      if (/ALTER TABLE knowledge_memory ADD COLUMN/i.test(sql)) {
        throw new Error('database or disk is full');
      }
      return realExec(sql);
    };
    expect(() => createSQLiteSchema(db)).toThrow(/disk is full/i);
    db.close();
  });
});
