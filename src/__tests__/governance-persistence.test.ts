import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import type { MemoryScope } from '../contracts/identity.js';

const require = createRequire(import.meta.url);

type BetterSqliteConstructor = typeof import('better-sqlite3');

function loadBetterSqlite3(): BetterSqliteConstructor {
  return require('better-sqlite3') as BetterSqliteConstructor;
}

function makeScope(): MemoryScope {
  return {
    tenant_id: 'test-tenant',
    system_id: 'test-system',
    scope_id: 'test-scope',
  };
}

describe('governance persistence', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function createDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memory-layer-gov-'));
    cleanupPaths.push(dir);
    return join(dir, 'memory.db');
  }

  function createManager(dbPath: string, configOverrides: Record<string, unknown> = {}) {
    const adapter = createSQLiteAdapterWithEmbeddings(dbPath);
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
      ...configOverrides,
    });
    return { adapter, manager };
  }

  async function closeInstance(instance: ReturnType<typeof createManager>) {
    await instance.manager.close();
    instance.adapter.close();
  }

  it('persists governance state across close/reopen', async () => {
    const dbPath = createDbPath();

    // First session: set governance state
    const first = createManager(dbPath);
    await first.manager.setDefaultContextContract({
      view: 'local_only',
      tokenBudget: 1500,
    });
    await first.manager.putContextContract('executor', {
      tokenBudget: 2000,
      knowledgeClasses: ['constraint'],
    });
    await first.manager.putContextInvariant({
      id: 'english-only',
      title: 'Language',
      instruction: 'All responses must be in English.',
      severity: 'important',
    });
    await first.manager.setContextEscalationPolicy({
      defaultDecision: 'allow',
      byChange: { increase_token_budget: 'deny' },
    });
    await closeInstance(first);

    // Second session: verify state survived
    const second = createManager(dbPath);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract?.view).toBe('local_only');
    expect(snapshot.defaultContract?.tokenBudget).toBe(1500);
    expect(snapshot.contracts.executor.tokenBudget).toBe(2000);
    expect(snapshot.contracts.executor.knowledgeClasses).toEqual(['constraint']);
    expect(snapshot.invariants).toHaveLength(1);
    expect(snapshot.invariants[0].id).toBe('english-only');
    expect(snapshot.escalationPolicy.defaultDecision).toBe('allow');
    expect(snapshot.escalationPolicy.byChange?.increase_token_budget).toBe('deny');
    await closeInstance(second);
  });

  it('persists delete operations across close/reopen', async () => {
    const dbPath = createDbPath();

    // Create then delete
    const first = createManager(dbPath);
    await first.manager.putContextContract('temp', { tokenBudget: 500 });
    await first.manager.putContextInvariant({
      id: 'temp-inv',
      title: 'Temp',
      instruction: 'Temporary.',
    });
    await first.manager.deleteContextContract('temp');
    await first.manager.deleteContextInvariant('temp-inv');
    await closeInstance(first);

    // Verify deletions survived
    const second = createManager(dbPath);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.contracts.temp).toBeUndefined();
    expect(snapshot.invariants.find((i) => i.id === 'temp-inv')).toBeUndefined();
    await closeInstance(second);
  });

  it('uses config defaults when no persisted governance exists', async () => {
    const dbPath = createDbPath();
    const instance = createManager(dbPath, {
      contextContract: { tokenBudget: 3000 },
      contextContracts: { reader: { view: 'local_only' } },
      invariants: [{ id: 'config-inv', title: 'From Config', instruction: 'Config-provided.' }],
    });

    const snapshot = await instance.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(3000);
    expect(snapshot.contracts.reader.view).toBe('local_only');
    expect(snapshot.invariants.find((i) => i.id === 'config-inv')).toBeTruthy();
    await closeInstance(instance);
  });

  it('persisted default contracts override config defaults without erasing config governance', async () => {
    const dbPath = createDbPath();
    const config = {
      contextContract: { tokenBudget: 1000 },
      contextContracts: { reader: { view: 'local_only' } },
      invariants: [{ id: 'config-inv', title: 'From Config', instruction: 'Config-provided.' }],
    };

    const first = createManager(dbPath, config);
    await first.manager.setDefaultContextContract({ tokenBudget: 5000 });
    await closeInstance(first);

    const second = createManager(dbPath, config);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(5000);
    expect(snapshot.contracts.reader.view).toBe('local_only');
    expect(snapshot.invariants.find((i) => i.id === 'config-inv')).toBeTruthy();
    await closeInstance(second);
  });

  it('persists named contract overlays without erasing config governance', async () => {
    const dbPath = createDbPath();
    const config = {
      contextContract: { tokenBudget: 1000 },
      contextContracts: { reader: { view: 'local_only' } },
      invariants: [{ id: 'config-inv', title: 'From Config', instruction: 'Config-provided.' }],
    };

    const first = createManager(dbPath, config);
    await first.manager.putContextContract('executor', {
      tokenBudget: 2000,
      knowledgeClasses: ['constraint'],
    });
    await closeInstance(first);

    const second = createManager(dbPath, config);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(1000);
    expect(snapshot.contracts.reader.view).toBe('local_only');
    expect(snapshot.contracts.executor.tokenBudget).toBe(2000);
    expect(snapshot.contracts.executor.knowledgeClasses).toEqual(['constraint']);
    expect(snapshot.invariants.find((i) => i.id === 'config-inv')).toBeTruthy();
    await closeInstance(second);
  });

  it('persists invariant overlays without erasing config governance', async () => {
    const dbPath = createDbPath();
    const config = {
      contextContract: { tokenBudget: 1000 },
      contextContracts: { reader: { view: 'local_only' } },
      invariants: [{ id: 'config-inv', title: 'From Config', instruction: 'Config-provided.' }],
    };

    const first = createManager(dbPath, config);
    await first.manager.putContextInvariant({
      id: 'runtime-inv',
      title: 'Runtime',
      instruction: 'Runtime-provided.',
      severity: 'important',
    });
    await closeInstance(first);

    const second = createManager(dbPath, config);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(1000);
    expect(snapshot.contracts.reader.view).toBe('local_only');
    expect(snapshot.invariants.map((inv) => inv.id).sort()).toEqual(['config-inv', 'runtime-inv']);
    await closeInstance(second);
  });

  it('persists clearing a config-backed default contract across reopen', async () => {
    const dbPath = createDbPath();
    const config = {
      contextContract: { tokenBudget: 1000 },
    };

    const first = createManager(dbPath, config);
    await first.manager.setDefaultContextContract(null);
    await closeInstance(first);

    const second = createManager(dbPath, config);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract).toBeNull();
    await closeInstance(second);
  });

  it('persists deleting a config-backed named contract without removing unrelated config contracts', async () => {
    const dbPath = createDbPath();
    const config = {
      contextContracts: {
        reader: { view: 'local_only' },
        writer: { tokenBudget: 2200 },
      },
    };

    const first = createManager(dbPath, config);
    await expect(first.manager.deleteContextContract('reader')).resolves.toBe(true);
    await closeInstance(first);

    const second = createManager(dbPath, config);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.contracts.reader).toBeUndefined();
    expect(snapshot.contracts.writer.tokenBudget).toBe(2200);
    await closeInstance(second);
  });

  it('persists deleting a config-backed invariant without removing unrelated config invariants', async () => {
    const dbPath = createDbPath();
    const config = {
      invariants: [
        { id: 'keep-me', title: 'Keep', instruction: 'Keep this invariant.' },
        { id: 'delete-me', title: 'Delete', instruction: 'Delete this invariant.' },
      ],
    };

    const first = createManager(dbPath, config);
    await expect(first.manager.deleteContextInvariant('delete-me')).resolves.toBe(true);
    await closeInstance(first);

    const second = createManager(dbPath, config);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.invariants.find((inv) => inv.id === 'delete-me')).toBeUndefined();
    expect(snapshot.invariants.find((inv) => inv.id === 'keep-me')).toBeTruthy();
    await closeInstance(second);
  });

  it('re-adding deleted contracts and invariants removes persisted tombstones', async () => {
    const dbPath = createDbPath();

    const first = createManager(dbPath);
    await first.manager.putContextContract('temp', { tokenBudget: 500 });
    await first.manager.putContextInvariant({
      id: 'temp-inv',
      title: 'Temp',
      instruction: 'Temporary.',
    });
    await first.manager.deleteContextContract('temp');
    await first.manager.deleteContextInvariant('temp-inv');
    await first.manager.putContextContract('temp', { tokenBudget: 900 });
    await first.manager.putContextInvariant({
      id: 'temp-inv',
      title: 'Temp Restored',
      instruction: 'Restored.',
      severity: 'important',
    });
    await closeInstance(first);

    const second = createManager(dbPath);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.contracts.temp.tokenBudget).toBe(900);
    expect(snapshot.invariants.find((inv) => inv.id === 'temp-inv')?.title).toBe('Temp Restored');
    await closeInstance(second);
  });

  it('allows a named contract called __default__ to coexist with the default contract', async () => {
    const dbPath = createDbPath();

    const first = createManager(dbPath);
    await first.manager.setDefaultContextContract({ tokenBudget: 1500 });
    await first.manager.putContextContract('__default__', { view: 'local_only' });
    await closeInstance(first);

    const second = createManager(dbPath);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(1500);
    expect(snapshot.contracts.__default__.view).toBe('local_only');
    await closeInstance(second);
  });

  it('migrates v17 governance rows to v18 without losing persisted state', async () => {
    const dbPath = createDbPath();
    const bootstrap = createManager(dbPath);
    await closeInstance(bootstrap);

    const BetterSqlite3 = loadBetterSqlite3();
    const raw = new BetterSqlite3(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS context_contracts;
      DROP TABLE IF EXISTS context_invariants;

      CREATE TABLE context_contracts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id         TEXT    NOT NULL,
        system_id         TEXT    NOT NULL,
        workspace_id      TEXT    NOT NULL DEFAULT 'default',
        collaboration_id  TEXT    NOT NULL DEFAULT '',
        scope_id          TEXT    NOT NULL,
        name              TEXT    NOT NULL,
        is_default        INTEGER NOT NULL DEFAULT 0,
        contract_json     TEXT    NOT NULL,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_ctx_contract_scope_name
        ON context_contracts(tenant_id, system_id, workspace_id, collaboration_id, scope_id, name);

      CREATE TABLE context_invariants (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id         TEXT    NOT NULL,
        system_id         TEXT    NOT NULL,
        workspace_id      TEXT    NOT NULL DEFAULT 'default',
        collaboration_id  TEXT    NOT NULL DEFAULT '',
        scope_id          TEXT    NOT NULL,
        invariant_id      TEXT    NOT NULL,
        title             TEXT    NOT NULL,
        instruction       TEXT    NOT NULL,
        severity          TEXT,
        scope_level       TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_ctx_invariant_scope_id
        ON context_invariants(tenant_id, system_id, workspace_id, collaboration_id, scope_id, invariant_id);
    `);

    raw.prepare(
      `INSERT INTO context_contracts
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, name, is_default, contract_json, created_at, updated_at)
       VALUES (?, ?, 'default', '', ?, '__default__', 1, ?, 1, 1)`,
    ).run('test-tenant', 'test-system', 'test-scope', JSON.stringify({ tokenBudget: 1600 }));
    raw.prepare(
      `INSERT INTO context_contracts
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, name, is_default, contract_json, created_at, updated_at)
       VALUES (?, ?, 'default', '', ?, 'executor', 0, ?, 1, 1)`,
    ).run('test-tenant', 'test-system', 'test-scope', JSON.stringify({ view: 'local_only' }));
    raw.prepare(
      `INSERT INTO context_invariants
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, invariant_id, title, instruction, severity, scope_level, created_at, updated_at)
       VALUES (?, ?, 'default', '', ?, 'english-only', 'Language', 'Respond in English.', 'important', 'workspace', 1, 1)`,
    ).run('test-tenant', 'test-system', 'test-scope');
    raw.prepare(
      `INSERT INTO context_escalation_policies
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, policy_json, created_at, updated_at)
       VALUES (?, ?, 'default', '', ?, ?, 1, 1)`,
    ).run(
      'test-tenant',
      'test-system',
      'test-scope',
      JSON.stringify({ defaultDecision: 'allow', byChange: { increase_token_budget: 'deny' } }),
    );
    raw.prepare('UPDATE schema_meta SET schema_version = 17 WHERE id = 1').run();
    raw.close();

    const migrated = createManager(dbPath);
    const snapshot = await migrated.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(1600);
    expect(snapshot.contracts.executor.view).toBe('local_only');
    expect(snapshot.invariants.find((inv) => inv.id === 'english-only')?.instruction).toBe(
      'Respond in English.',
    );
    expect(snapshot.escalationPolicy.byChange?.increase_token_budget).toBe('deny');
    await closeInstance(migrated);

    const inspected = new BetterSqlite3(dbPath);
    const defaultRow = inspected
      .prepare(
        `SELECT name, is_default, is_deleted
         FROM context_contracts
         WHERE tenant_id = ? AND system_id = ? AND workspace_id = 'default'
           AND collaboration_id = '' AND scope_id = ? AND is_default = 1`,
      )
      .get('test-tenant', 'test-system', 'test-scope') as {
      name: string | null;
      is_default: number;
      is_deleted: number;
    };
    inspected.close();
    expect(defaultRow.name).toBeNull();
    expect(defaultRow.is_default).toBe(1);
    expect(defaultRow.is_deleted).toBe(0);
  });
});
