import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMemoryContext } from '../core/context.js';
import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { makeScope, seedTurns } from './test-helpers.js';

describe('buildMemoryContext', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('assembles active turns, latest working memory, knowledge, and recent summaries', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 4);
    const firstSummary = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'Older summary',
      key_entities: ['docker'],
      topic_tags: ['infra'],
      turn_id_start: 1,
      turn_id_end: 2,
      turn_count: 2,
      compaction_trigger: 'soft',
    });
    const latestSummary = adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'Latest summary',
      key_entities: ['memory'],
      topic_tags: ['context'],
      turn_id_start: 3,
      turn_id_end: 4,
      turn_count: 2,
      compaction_trigger: 'manual',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The user prefers reusable memory layers',
      fact_type: 'preference',
      source: 'manual',
      confidence: 'high',
    });

    const context = await buildMemoryContext(asyncAdapter, scope);
    expect(context.activeTurns).toHaveLength(4);
    expect(context.workingMemory?.id).toBe(latestSummary.id);
    expect(context.recentSummaries.map((item) => item.id)).toContain(firstSummary.id);
    expect(context.relevantKnowledge).toHaveLength(1);
    expect(context.knowledgeSelectionReasons).toHaveLength(1);
    expect(context.tokenEstimate).toBeGreaterThan(0);
  });

  it('uses relevanceQuery to rank matching knowledge first', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    const postgres = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system uses postgres for durable storage',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The UI uses tailwind',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const context = await buildMemoryContext(asyncAdapter, scope, { relevanceQuery: 'postgres' });
    expect(context.relevantKnowledge[0].id).toBe(postgres.id);
  });

  it('reinforces knowledge selected into context', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The system uses postgres for durable storage',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const before = adapter.getKnowledgeMemoryById(knowledge.id)?.access_count ?? 0;
    const context = await buildMemoryContext(asyncAdapter, scope, { relevanceQuery: 'postgres' });
    const after = adapter.getKnowledgeMemoryById(knowledge.id)?.access_count ?? 0;

    expect(context.relevantKnowledge[0].id).toBe(knowledge.id);
    expect(after).toBeGreaterThan(before);
  });

  it('trims lower-priority turns first to meet the token budget', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 0);
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'user-1',
      role: 'user',
      content: 'high priority',
      priority: 1.5,
      token_estimate: 500,
    });
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'assistant-1',
      role: 'assistant',
      content: 'low priority',
      priority: 0.25,
      token_estimate: 500,
    });
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'user-1',
      role: 'user',
      content: 'keep me',
      priority: 1.2,
      token_estimate: 500,
    });

    const context = await buildMemoryContext(asyncAdapter, scope, { tokenBudget: 1200 });
    expect(context.activeTurns.map((turn) => turn.content)).not.toContain('low priority');
    expect(context.tokenEstimate).toBeLessThanOrEqual(1200);
  });

  it('supports temporal context snapshots with asOf', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 0);
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'user-1',
      role: 'user',
      content: 'early turn',
      created_at: 100,
    });
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'assistant-1',
      role: 'assistant',
      content: 'later turn',
      created_at: 200,
    });

    const context = await buildMemoryContext(asyncAdapter, scope, { asOf: 150 });
    expect(context.activeTurns).toHaveLength(1);
    expect(context.activeTurns[0]?.content).toBe('early turn');
  });

  it('filters future and already-resolved work items from historical context', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 1);

    const historicalObjective = adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'objective',
      title: 'Ship the rollback flow',
      status: 'open',
      created_at: 100,
    });
    const historicalBlocker = adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'unresolved_work',
      title: 'Audit rollback alarms',
      status: 'open',
      created_at: 110,
    });
    adapter.updateWorkItemStatus(historicalObjective.id, 'done');
    adapter.updateWorkItemStatus(historicalBlocker.id, 'done');

    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'unresolved_work',
      title: 'Already resolved before snapshot',
      status: 'done',
      created_at: 120,
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'unresolved_work',
      title: 'Future blocker',
      status: 'blocked',
      created_at: 200,
    });

    const context = await buildMemoryContext(asyncAdapter, scope, { asOf: 150 });
    expect(context.activeObjectives.map((item) => item.title)).toContain('Ship the rollback flow');
    expect(context.unresolvedWork).toContain('Audit rollback alarms');
    expect(context.unresolvedWork).not.toContain('Already resolved before snapshot');
    expect(context.unresolvedWork).not.toContain('Future blocker');
  });

  it('returns empty context gracefully', async () => {
    const context = await buildMemoryContext(asyncAdapter, makeScope());
    expect(context.activeTurns).toEqual([]);
    expect(context.workingMemory).toBeNull();
    expect(context.relevantKnowledge).toEqual([]);
    expect(context.recentSummaries).toEqual([]);
  });

  it('includes active objectives and unresolved work items', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'objective',
      title: 'Ship the memory layer',
      status: 'in_progress',
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      kind: 'unresolved_work',
      title: 'Fix retrieval edge cases',
      status: 'blocked',
    });

    const context = await buildMemoryContext(asyncAdapter, scope);
    expect(context.activeObjectives).toHaveLength(1);
    expect(context.unresolvedWork).toContain('Fix retrieval edge cases');
  });

  it('derives session state and explanation traces for prompt-facing short-term memory', async () => {
    const scope = makeScope();
    const { sessionId } = seedTurns(adapter, scope, 0);
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'user',
      role: 'user',
      content: 'Assume staging is current and we should decide on rollback ownership.',
    });
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: 'deploy-bot',
      role: 'assistant',
      content: 'Tool deploy-bot output: rollback rehearsal passed.',
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: sessionId,
      kind: 'unresolved_work',
      title: 'Wait for security approval',
      status: 'blocked',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Choose a single rollback owner before deploy',
      fact_type: 'decision',
      source: 'manual',
      confidence: 'high',
    });

    const context = await buildMemoryContext(asyncAdapter, scope, { relevanceQuery: 'rollback owner' });
    expect(context.sessionState.currentObjective).toBeTruthy();
    expect(context.sessionState.blockers).toContain('Wait for security approval');
    expect(context.sessionState.assumptions.join(' ')).toContain('Assume staging is current');
    expect(context.sessionState.pendingDecisions.join(' ')).toContain('decide on rollback ownership');
    expect(context.sessionState.activeTools).toContain('deploy-bot');
    expect(context.sessionState.recentOutputs.join(' ')).toContain('rollback rehearsal passed');
    expect(context.debugTrace.scope.scopeSource).toBe('local');
    expect(context.debugTrace.selectedKnowledge).toEqual(context.knowledgeSelectionReasons);
  });

  it('caps associated knowledge expansion and records truncated candidates', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 1);
    const seed = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Primary rollback plan lives in ops/runbook.md',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    for (let index = 0; index < 15; index += 1) {
      const related = adapter.insertKnowledgeMemory({
        ...scope,
        fact: `Associated rollback note ${index}`,
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
      });
      adapter.insertAssociation({
        ...scope,
        source_kind: 'knowledge',
        source_id: seed.id,
        target_kind: 'knowledge',
        target_id: related.id,
        association_type: 'supports',
        confidence: 0.9,
      });
    }

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'rollback runbook',
      maxKnowledgeItems: 1,
    });
    expect(context.associatedKnowledge.length).toBeLessThanOrEqual(12);
    expect(context.debugTrace.associationExpansion.candidateKnowledgeIds.length).toBe(15);
    expect(context.debugTrace.associationExpansion.truncatedKnowledgeIds.length).toBeGreaterThan(0);
  });

  it('ranks extracted-provenance associations above inferred ones', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 1);
    const seed = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Primary deployment pipeline runs on CI',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    // Create an inferred association with high confidence
    const inferredTarget = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Inferred: deployment uses Docker containers',
      fact_type: 'entity',
      source: 'user_stated',
      confidence: 'high',
    });
    adapter.insertAssociation({
      ...scope,
      source_kind: 'knowledge',
      source_id: seed.id,
      target_kind: 'knowledge',
      target_id: inferredTarget.id,
      association_type: 'supports',
      provenance: 'inferred',
      confidence: 0.9,
    });

    // Create an extracted association with the same confidence
    const extractedTarget = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Extracted: CI pipeline pushes to staging first',
      fact_type: 'entity',
      source: 'user_stated',
      confidence: 'high',
    });
    adapter.insertAssociation({
      ...scope,
      source_kind: 'knowledge',
      source_id: seed.id,
      target_kind: 'knowledge',
      target_id: extractedTarget.id,
      association_type: 'supports',
      provenance: 'extracted',
      confidence: 0.9,
    });

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'deployment pipeline CI',
      maxKnowledgeItems: 1,
    });

    // Both should be included (no exclusion by confidence)
    expect(context.associatedKnowledge.length).toBe(2);

    // Extracted should rank above inferred (extracted weight=1.0, inferred weight=0.7)
    const ids = context.associatedKnowledge.map((k) => k.id);
    expect(ids.indexOf(extractedTarget.id)).toBeLessThan(ids.indexOf(inferredTarget.id));
  });

  it('applies context contract filters and injects invariants separately from ranked knowledge', async () => {
    const scope = makeScope();
    seedTurns(adapter, scope, 2);
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Never skip the deployment checklist',
      fact_type: 'constraint',
      knowledge_class: 'constraint',
      trust_score: 0.95,
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The project codename is Atlas',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      trust_score: 0.95,
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Weakly supported rollback rule',
      fact_type: 'constraint',
      knowledge_class: 'constraint',
      source: 'manual',
      confidence: 'low',
      trust_score: 0.3,
    });

    const context = await buildMemoryContext(asyncAdapter, scope, {
      contract: {
        name: 'constraint_focus',
        knowledgeClasses: ['constraint'],
        minimumTrustScore: 0.8,
        maxKnowledgeItems: 5,
      },
      invariants: [
        {
          id: 'prod-data',
          title: 'Production data safety',
          instruction: 'Never delete production data without explicit approval.',
          severity: 'critical',
        },
      ],
    });

    expect(context.appliedContract?.name).toBe('constraint_focus');
    expect(context.appliedContract?.knowledgeClasses).toEqual(['constraint']);
    expect(context.relevantKnowledge.map((item) => item.fact)).toEqual([
      'Never skip the deployment checklist',
    ]);
    expect(context.warnings).toContainEqual(
      expect.objectContaining({
        code: 'contract_filtered',
        severity: 'info',
      }),
    );
    expect(context.invariants).toEqual([
      expect.objectContaining({
        id: 'prod-data',
        severity: 'critical',
        scopeLevel: 'scope',
      }),
    ]);
  });

  it('drops lower-priority invariants before critical ones when over token budget', async () => {
    const scope = makeScope();
    const context = await buildMemoryContext(asyncAdapter, scope, {
      tokenBudget: 70,
      tokenEstimator: (text) => text.length,
      invariants: [
        {
          id: 'critical',
          title: 'Critical rule',
          instruction: 'Never delete production data.',
          severity: 'critical',
          scopeLevel: 'workspace',
        },
        {
          id: 'advisory',
          title: 'Advisory rule',
          instruction: 'Prefer concise changelog wording.',
          severity: 'advisory',
          scopeLevel: 'tenant',
        },
      ],
    });

    expect(context.invariants?.map((item) => item.id)).toEqual(['critical']);
    expect(context.debugTrace.tokenTrimming.droppedInvariantIds).toEqual(['advisory']);
    expect(context.degradedContext?.isDegraded).toBe(true);
    expect(context.warnings).toContainEqual(
      expect.objectContaining({
        code: 'invariants_trimmed',
        severity: 'warning',
      }),
    );
  });
});
