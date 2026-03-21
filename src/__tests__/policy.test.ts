import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { buildMemoryContext } from '../core/context.js';
import { assessContext } from '../core/monitor.js';
import { DEFAULT_MONITOR_POLICY } from '../contracts/policy.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('policy defaults and overrides', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
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

  it('applies context policy defaults and overrides', () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 3, { tokenEstimate: 400 });
    const context = buildMemoryContext(adapter, scope, {
      policy: {
        tokenBudget: 500,
      },
    });
    expect(context.tokenEstimate).toBeLessThanOrEqual(500);
  });
});
