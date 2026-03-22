import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { buildMemoryContext } from '../core/context.js';
import { assessContext } from '../core/monitor.js';
import { MEMORY_MANAGER_PRESETS, resolveMemoryManagerPreset } from '../core/presets.js';
import { DEFAULT_MONITOR_POLICY } from '../contracts/policy.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('policy defaults and overrides', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('keeps current monitor behavior through defaults', () => {
    const scope = makeScope();
    const { turns } = seedTurns(adapter, scope, 20, { tokenEstimate: 210 });
    const report = assessContext(
      {
        scope,
        session_id: 's1',
        active_turns: turns,
      },
      DEFAULT_MONITOR_POLICY,
    );
    expect(report.recommendation.action).toBe('soft');
  });

  it('allows custom thresholds to change compaction recommendations', () => {
    const scope = makeScope();
    const { turns } = seedTurns(adapter, scope, 8, { tokenEstimate: 100 });
    const report = assessContext(
      {
        scope,
        session_id: 's1',
        active_turns: turns,
      },
      {
        floorTurns: 4,
        floorTokens: 100,
        softTurnThreshold: 4,
        hardTurnThreshold: 8,
        softTokenThreshold: 400,
        hardTokenThreshold: 800,
      },
    );
    expect(report.recommendation.action).not.toBe('none');
  });

  it('applies context policy defaults and overrides', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 3, { tokenEstimate: 400 });
    const context = await buildMemoryContext(asyncAdapter, scope, {
      policy: {
        tokenBudget: 500,
      },
    });
    expect(context.tokenEstimate).toBeLessThanOrEqual(500);
  });

  it('exposes workload presets for drop-in manager setup', () => {
    expect(MEMORY_MANAGER_PRESETS.ai_ide.contextPolicy.mode).toBe('coding');
    expect(resolveMemoryManagerPreset('autonomous_agent').crossScopeLevel).toBe('workspace');
  });
});
