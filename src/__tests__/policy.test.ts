import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { buildMemoryContext } from '../core/context.js';
import { assessContext } from '../core/monitor.js';
import { MEMORY_MANAGER_PRESETS, resolveMemoryManagerPreset } from '../core/presets.js';
import { rankKnowledge } from '../core/retrieval.js';
import { DEFAULT_CONTEXT_POLICY, DEFAULT_MONITOR_POLICY } from '../contracts/policy.js';
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

  it('uses importanceWeight when ranking knowledge', () => {
    const scope = makeScope();
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Important maintenance checklist',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.2,
    });
    const neutralPolicy = {
      ...DEFAULT_CONTEXT_POLICY,
      lexicalWeight: 0,
      semanticWeight: 0,
      recencyWeight: 0,
      importanceWeight: 0,
      trustWeight: 0,
      durabilityWeight: 0,
      evidenceWeight: 0,
      objectiveLinkWeight: 0,
      scopeRelationWeight: 0,
      contradictionPenalty: 0,
      provisionalPenalty: 0,
      localTrustedBonus: 0,
      lineageWeight: 0,
      unrelatedLineagePenalty: 0,
    };
    const weightedPolicy = {
      ...neutralPolicy,
      importanceWeight: 2,
    };

    const neutral = rankKnowledge({
      knowledge,
      lexicalScore: 0,
      semanticScore: 0,
      recencyScore: 0,
      importanceScore: 1,
      policy: neutralPolicy,
      scope,
    });
    const weighted = rankKnowledge({
      knowledge,
      lexicalScore: 0,
      semanticScore: 0,
      recencyScore: 0,
      importanceScore: 1,
      policy: weightedPolicy,
      scope,
    });

    expect(neutral.finalScore).toBe(0);
    expect(weighted.finalScore).toBeGreaterThan(neutral.finalScore);
  });

  it('lets policy control the lineage inclusion threshold', async () => {
    const childScope = makeScope({ workspace_id: 'shared', scope_id: 'project/root/child' });
    const parentScope = makeScope({ workspace_id: 'shared', scope_id: 'project/root' });
    adapter.insertKnowledgeMemory({
      ...parentScope,
      fact: 'Parent deploy checklist must be reviewed.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
      // P6: workspace-visible so it can surface to the child scope; the test
      // exercises the lineage-score threshold, not the visibility gate.
      visibility_class: 'workspace',
    });

    const included = await buildMemoryContext(asyncAdapter, childScope, {
      crossScopeLevel: 'workspace',
      relevanceQuery: 'deploy checklist',
      policy: { minimumLineageScore: 0.6 },
    });
    const excluded = await buildMemoryContext(asyncAdapter, childScope, {
      crossScopeLevel: 'workspace',
      relevanceQuery: 'deploy checklist',
      policy: { minimumLineageScore: 0.7 },
    });

    expect(included.relevantKnowledge.map((item) => item.fact)).toContain(
      'Parent deploy checklist must be reviewed.',
    );
    expect(excluded.relevantKnowledge.map((item) => item.fact)).not.toContain(
      'Parent deploy checklist must be reviewed.',
    );
  });

  it('exposes workload presets for drop-in manager setup', () => {
    expect(MEMORY_MANAGER_PRESETS.ai_ide.contextPolicy.mode).toBe('coding');
    expect(resolveMemoryManagerPreset('autonomous_agent').crossScopeLevel).toBe('workspace');
  });
});
