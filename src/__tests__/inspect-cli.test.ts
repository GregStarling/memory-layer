import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMemory } from '../core/quick.js';
import { runInspectCommand } from '../cli/inspect.js';

describe('inspect CLI helpers', () => {
  const paths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      paths.splice(0, paths.length).map(async (dbPath) => {
        await fs.rm(dbPath, { force: true });
      }),
    );
  });

  async function createDbPath(): Promise<string> {
    const dbPath = path.join(
      os.tmpdir(),
      `memory-layer-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    paths.push(dbPath);
    return dbPath;
  }

  it('lists stored knowledge', async () => {
    const dbPath = await createDbPath();
    const manager = createMemory({ path: dbPath, scope: 'default' });
    await manager.learnFact('The incident runbook lives in docs/incidents.md', 'reference');
    await manager.close();

    const output = await runInspectCommand('knowledge', { dbPath, limit: 10 });
    expect(output).toContain('docs/incidents.md');
    expect(output).toContain('hasMore=');
  });

  it('shows knowledge detail and recent changes', async () => {
    const dbPath = await createDbPath();
    const manager = createMemory({ path: dbPath, scope: 'default' });
    const since = new Date().toISOString();
    const knowledge = await manager.learnFact('Use the rollback checklist before restoring traffic', 'reference');
    await manager.close();

    const detail = await runInspectCommand('knowledge', { dbPath, id: knowledge.id });
    expect(detail).toContain(`Knowledge ${knowledge.id}`);
    expect(detail).toContain('Audits');

    const changes = await runInspectCommand('changes', { dbPath, since });
    expect(changes).toContain('rollback checklist');
  });
});
