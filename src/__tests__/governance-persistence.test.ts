import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import type { MemoryScope } from '../contracts/identity.js';

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
    await first.manager.close();
    first.adapter.close();

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
    await second.manager.close();
    second.adapter.close();
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
    await first.manager.close();
    first.adapter.close();

    // Verify deletions survived
    const second = createManager(dbPath);
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.contracts.temp).toBeUndefined();
    expect(snapshot.invariants.find((i) => i.id === 'temp-inv')).toBeUndefined();
    await second.manager.close();
    second.adapter.close();
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
    await instance.manager.close();
    instance.adapter.close();
  });

  it('persisted values override config defaults on reopen', async () => {
    const dbPath = createDbPath();

    // First session: override config default
    const first = createManager(dbPath, {
      contextContract: { tokenBudget: 1000 },
    });
    await first.manager.setDefaultContextContract({ tokenBudget: 5000 });
    await first.manager.close();
    first.adapter.close();

    // Second session: same config, but persisted value wins
    const second = createManager(dbPath, {
      contextContract: { tokenBudget: 1000 },
    });
    const snapshot = await second.manager.getContextGovernance();
    expect(snapshot.defaultContract?.tokenBudget).toBe(5000);
    await second.manager.close();
    second.adapter.close();
  });
});
