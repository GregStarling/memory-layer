import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { createMemoryEventEmitter } from '../core/events.js';
import { createMemoryManager } from '../core/manager.js';
import { createClaudeMemoryManager } from '../composition/provider-managers.js';
import { createRegexExtractor } from '../core/extractor.js';
import { makeScope } from './test-helpers.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';

describe('memory manager', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('processes turns and auto-compacts with extraction', async () => {
    const onEvent = vi.fn();
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: `The user prefers Rust after ${turns.length} turns.`,
        key_entities: ['Rust'],
        topic_tags: ['memory'],
      }),
      extractor: createRegexExtractor(),
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async (texts) => texts.map(() => new Float32Array([1, 0])),
      onEvent,
      monitorPolicy: {
        floorTurns: 2,
        floorTokens: 1,
        softTurnThreshold: 10,
        hardTurnThreshold: 2,
        softTokenThreshold: 5000,
        hardTokenThreshold: 10,
      },
    });

    await manager.processTurn('user', 'I prefer Rust for memory systems.');
    await manager.processTurn('assistant', 'Understood.');

    expect(adapter.getActiveWorkingMemory(makeScope()).length).toBeGreaterThan(0);
    expect(adapter.getActiveKnowledgeMemory(makeScope()).length).toBeGreaterThan(0);
    expect(onEvent).toHaveBeenCalled();
    await manager.close();
  });

  it('returns prompt-ready context', async () => {
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
    });

    await manager.processTurn('user', 'hello');
    const context = await manager.getContext();
    expect(context.activeTurns).toHaveLength(1);
    await manager.close();
  });

  it('resolves named context contracts through the manager API', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
      contextContract: {
        maxKnowledgeItems: 10,
      },
      contextContracts: {
        constraints_only: {
          knowledgeClasses: ['constraint'],
          minimumTrustScore: 0.8,
        },
      },
      invariants: [
        {
          id: 'english-only',
          title: 'Language',
          instruction: 'All responses must be in English.',
          severity: 'important',
        },
      ],
    });

    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Never bypass the approval gate',
      fact_type: 'constraint',
      knowledge_class: 'constraint',
      trust_score: 0.95,
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The codename is Atlas',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      trust_score: 0.95,
      source: 'manual',
      confidence: 'high',
    });

    const context = await manager.getContext(undefined, { contract: 'constraints_only' });

    expect(context.appliedContract?.name).toBe('constraints_only');
    expect(context.relevantKnowledge.map((item) => item.fact)).toEqual([
      'Never bypass the approval gate',
    ]);
    expect(context.invariants?.map((item) => item.id)).toEqual(['english-only']);
    await manager.close();
  });

  it('keeps named contract boundaries consistent across context, state, and bootstrap surfaces', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
      contextContracts: {
        constraints_only: {
          knowledgeClasses: ['constraint'],
          minimumTrustScore: 0.8,
        },
      },
    });

    await manager.processTurn('user', 'Please remember the deploy rules.');
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Never bypass the approval gate',
      fact_type: 'constraint',
      knowledge_class: 'constraint',
      trust_score: 0.95,
      source: 'manual',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The codename is Atlas',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      trust_score: 0.95,
      source: 'manual',
      confidence: 'high',
    });

    const asOf = Math.floor(Date.now() / 1000) + 1;
    const [context, historicalContext, state, bootstrap] = await Promise.all([
      manager.getContext(undefined, { contract: 'constraints_only' }),
      manager.getContextAt(asOf, undefined, { contract: 'constraints_only' }),
      manager.getStateAt(asOf, { contract: 'constraints_only' }),
      manager.getSessionBootstrap(undefined, { contract: 'constraints_only' }),
    ]);
    const bootstrapFacts = Object.values(bootstrap.profile?.sections ?? {}).flat().map((entry) => entry.fact);

    expect(context.relevantKnowledge.map((item) => item.fact)).toEqual([
      'Never bypass the approval gate',
    ]);
    expect(historicalContext.relevantKnowledge.map((item) => item.fact)).toEqual([
      'Never bypass the approval gate',
    ]);
    expect(state.knowledge.map((item) => item.fact)).toEqual([
      'Never bypass the approval gate',
    ]);
    expect(bootstrapFacts).toEqual(['Never bypass the approval gate']);
    await manager.close();
  });

  it('returns a first-class context expansion request resolution for blocked agents', async () => {
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
      contextContracts: {
        executor: {
          view: 'local_only',
          crossScopeLevel: 'scope',
          knowledgeClasses: ['constraint'],
          minimumTrustScore: 0.8,
        },
      },
    });

    const resolution = await manager.requestContextExpansion(
      {
        reason: 'missing_workspace_context',
        note: 'Need workspace-wide rollback procedure context.',
        contract: {
          view: 'workspace_shared',
          crossScopeLevel: 'workspace',
          knowledgeClasses: ['constraint', 'procedure'],
        },
      },
      { currentContract: 'executor' },
    );

    expect(resolution.requiresEscalation).toBe(true);
    expect(resolution.decision).toBe('requires_approval');
    expect(resolution.proposedContract.view).toBe('workspace_shared');
    expect(resolution.proposedContract.crossScopeLevel).toBe('workspace');
    expect(resolution.rationale.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('manages governance state and enforces escalation policy decisions', async () => {
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
    });

    await manager.setDefaultContextContract({ maxKnowledgeItems: 5 });
    await manager.putContextContract('executor', {
      view: 'local_only',
      crossScopeLevel: 'scope',
      tokenBudget: 2000,
      knowledgeClasses: ['constraint'],
    });
    await manager.putContextInvariant({
      id: 'english-only',
      title: 'Language',
      instruction: 'All responses must be in English.',
      severity: 'important',
      scopeLevel: 'workspace',
    });
    await manager.setContextEscalationPolicy({
      defaultDecision: 'allow',
      byChange: {
        increase_token_budget: 'deny',
      },
      maxScopeLevel: 'workspace',
    });

    const snapshot = await manager.getContextGovernance();
    expect(snapshot.defaultContract?.maxKnowledgeItems).toBe(5);
    expect(snapshot.contracts.executor?.knowledgeClasses).toEqual(['constraint']);
    expect(snapshot.invariants.map((item) => item.id)).toEqual(['english-only']);
    expect(snapshot.escalationPolicy.defaultDecision).toBe('allow');

    const denied = await manager.requestContextExpansion(
      {
        reason: 'need_higher_budget',
        contract: {
          tokenBudget: 6000,
        },
      },
      { currentContract: 'executor' },
    );

    expect(denied.decision).toBe('denied');
    expect(denied.requiresEscalation).toBe(false);

    expect(await manager.deleteContextInvariant('english-only')).toBe(true);
    expect(await manager.deleteContextContract('executor')).toBe(true);
    const afterDelete = await manager.getContextGovernance();
    expect(afterDelete.contracts.executor).toBeUndefined();
    expect(afterDelete.invariants).toHaveLength(0);
    await manager.close();
  });

  it('can build temporal snapshots with getContextAt', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    await manager.processTurn('user', 'first');
    const cutoff = Math.floor(Date.now() / 1000);
    await manager.processTurn('assistant', 'second');

    const context = await manager.getContextAt(cutoff);
    expect(context.activeTurns.map((turn) => turn.content)).toContain('first');
    await manager.close();
  });

  it('ignores future turns when deriving historical semantic context', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async (texts) =>
        texts.map((text) =>
          text.includes('postgres')
            ? new Float32Array([1, 0])
            : text.includes('redis')
              ? new Float32Array([0, 1])
              : new Float32Array([0, 0]),
        ),
    });
    const cutoff = Math.floor(Date.now() / 1000) + 1;

    adapter.insertTurn({
      ...scope,
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'Need the redis cache rollout notes',
      created_at: cutoff - 10,
    });
    adapter.insertTurn({
      ...scope,
      session_id: 'session-1',
      actor: 'assistant',
      role: 'assistant',
      content: 'Also keep the postgres migration handy',
      created_at: cutoff + 10,
    });

    const redis = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Redis cache rollout checklist',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const postgres = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Postgres migration checklist',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(redis.id, new Float32Array([0, 1]));
    adapter.embeddings.storeEmbedding(postgres.id, new Float32Array([1, 0]));

    const context = await manager.getContextAt(cutoff);
    expect(context.activeTurns.map((turn) => turn.content)).toEqual([
      'Need the redis cache rollout notes',
    ]);
    expect(context.relevantKnowledge[0]?.id).toBe(redis.id);
    await manager.close();
  });

  it('does not consult live semantic retrieval when replaying exact historical context', async () => {
    const scope = makeScope();
    const findSimilarSpy = vi.spyOn(adapter.embeddings, 'findSimilar');
    const findSimilarCrossScopeSpy = vi.spyOn(adapter.embeddings, 'findSimilarCrossScope');
    const embeddingGenerator = vi.fn(async () => [new Float32Array([1, 0])]);
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator,
    });

    adapter.insertTurn({
      ...scope,
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'Need the redis cache rollout notes',
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Redis cache rollout checklist',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const context = await manager.getContextAt(Math.floor(Date.now() / 1000) + 1);

    expect(context.activeTurns).toHaveLength(1);
    expect(embeddingGenerator).not.toHaveBeenCalled();
    expect(findSimilarSpy).not.toHaveBeenCalled();
    expect(findSimilarCrossScopeSpy).not.toHaveBeenCalled();
    await manager.close();
  });

  it('paginates diffState across all matching events', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    for (let index = 0; index < 520; index += 1) {
      adapter.insertTurn({
        ...scope,
        session_id: 'session-1',
        actor: 'user',
        role: 'user',
        content: `turn-${index}`,
      });
    }

    const diff = await manager.diffState(0, Math.floor(Date.now() / 1000) + 1, {
      entityKind: 'turn',
    });

    expect(diff.summary.totalEvents).toBe(520);
    expect(diff.events).toHaveLength(520);
    await manager.close();
  });

  it('keeps manager diffState unbounded by default but rejects ranges above maxEvents when requested', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    for (let index = 0; index < 25; index += 1) {
      adapter.insertTurn({
        ...scope,
        session_id: 'session-1',
        actor: 'user',
        role: 'user',
        content: `turn-${index}`,
      });
    }

    await expect(
      manager.diffState(0, Math.floor(Date.now() / 1000) + 1, {
        entityKind: 'turn',
        maxEvents: 10,
      }),
    ).rejects.toThrow(/event range exceeds maximum of 10/i);
    await manager.close();
  });

  it('reconstructs large exact historical state snapshots without diff caps', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    for (let index = 0; index < 520; index += 1) {
      adapter.insertTurn({
        ...scope,
        session_id: 'session-1',
        actor: 'user',
        role: 'user',
        content: `historical-${index}`,
      });
    }

    const state = await manager.getStateAt(Math.floor(Date.now() / 1000) + 1);

    expect(state.exact).toBe(true);
    expect(state.turns).toHaveLength(520);
    await manager.close();
  });

  it('keeps processing turns when session-state projection refresh fails', async () => {
    const scope = makeScope();
    const asyncAdapter = wrapSyncAdapter(adapter);
    const manager = createMemoryManager({
      asyncAdapter: {
        ...asyncAdapter,
        upsertSessionState: async () => {
          throw new Error('projection write failed');
        },
      },
      closeAdapter: false,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    const turn = await manager.processTurn('user', 'hello');

    expect(turn.content).toBe('hello');
    expect(adapter.getActiveTurns(scope, 'session-1')).toHaveLength(1);
    await manager.close();
  });

  it('returns a coherent best-effort state snapshot before temporal cutover', async () => {
    const scope = makeScope();
    const asyncAdapter = wrapSyncAdapter(adapter);
    const actor = {
      actor_kind: 'agent' as const,
      actor_id: 'planner',
      system_id: null,
      display_name: null,
      metadata: null,
    };
    const recipient = {
      actor_kind: 'human' as const,
      actor_id: 'operator',
      system_id: null,
      display_name: 'Op',
      metadata: null,
    };
    const manager = createMemoryManager({
      asyncAdapter: {
        ...asyncAdapter,
        getTemporalWatermark: async () => null,
      },
      closeAdapter: false,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    const objective = adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      title: 'Ship rollout',
      kind: 'objective',
      status: 'open',
    });
    adapter.insertWorkItem({
      ...scope,
      session_id: 'session-1',
      title: 'Confirm rollback owner',
      kind: 'unresolved_work',
      status: 'blocked',
    });
    adapter.claimWorkItem({
      ...scope,
      work_item_id: objective.id,
      actor,
      session_id: 'session-1',
      visibility_class: 'private',
    });
    adapter.createHandoff({
      ...scope,
      work_item_id: objective.id,
      from_actor: actor,
      to_actor: recipient,
      session_id: 'session-1',
      summary: 'Take over deploy watch',
      visibility_class: 'private',
    });

    const state = await manager.getStateAt(Math.floor(Date.now() / 1000), {
      includeCoordinationState: true,
      view: 'operator_supervisor',
      viewer: actor,
    });

    expect(state.exact).toBe(false);
    expect(state.workItems).toHaveLength(2);
    expect(state.workClaims).toHaveLength(1);
    expect(state.handoffs).toHaveLength(1);
    await manager.close();
  });

  it('normalizes expired coordination state in exact temporal replay', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
    const actor = {
      actor_kind: 'agent' as const,
      actor_id: 'planner',
      system_id: null,
      display_name: null,
      metadata: null,
    };
    const recipient = {
      actor_kind: 'human' as const,
      actor_id: 'operator',
      system_id: null,
      display_name: 'Op',
      metadata: null,
    };

    const workItem = await manager.trackWorkItem('Ship rollout');
    await manager.claimWorkItem({
      workItemId: workItem.id,
      actor,
      leaseSeconds: 1,
    });
    await manager.handoffWorkItem({
      workItemId: workItem.id,
      fromActor: actor,
      toActor: recipient,
      summary: 'Take over deploy watch',
      expiresAt: Math.floor(Date.now() / 1000) + 1,
    });

    const state = await manager.getStateAt(Math.floor(Date.now() / 1000) + 5);

    expect(state.exact).toBe(true);
    expect(state.workClaims[0]?.status).toBe('expired');
    expect(state.handoffs[0]?.status).toBe('expired');
    await manager.close();
  });

  it('returns hybrid search results', async () => {
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
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([1, 0])],
    });

    await manager.processTurn('user', 'remember postgres');
    const knowledge = adapter.insertKnowledgeMemory({
      ...makeScope(),
      fact: 'The project uses postgres',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const results = await manager.search('postgres');
    expect(results.turns).toHaveLength(1);
    expect(results.knowledge.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('uses semantic retrieval in getContext when embeddings are configured', async () => {
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
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([1, 0])],
    });

    const knowledge = adapter.insertKnowledgeMemory({
      ...makeScope(),
      fact: 'The project uses sqlite for local-first storage',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    adapter.embeddings.storeEmbedding(knowledge.id, new Float32Array([1, 0]));

    const context = await manager.getContext('local-first');
    expect(context.relevantKnowledge.map((item) => item.id)).toContain(knowledge.id);
    await manager.close();
  });

  it('can manually learn facts', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      embeddingAdapter: adapter.embeddings,
      embeddingGenerator: async () => [new Float32Array([0.5, 0.5])],
    });

    const fact = await manager.learnFact('The project uses sqlite', 'reference');
    expect(fact.source).toBe('manual');
    expect(adapter.embeddings.getEmbedding(fact.id)).not.toBeNull();
    await manager.close();
  });

  it('rejects reverification for knowledge outside the manager scope', async () => {
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
    });

    const foreign = adapter.insertKnowledgeMemory({
      ...makeScope({ scope_id: 'other-thread' }),
      fact: 'Foreign knowledge',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    await expect(manager.reverifyKnowledge(foreign.id)).rejects.toThrow(
      'does not belong to the requested scope',
    );
    await manager.close();
  });

  it('can process an exchange in one memory cycle', async () => {
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
    });

    const result = await manager.processExchange('hello', 'hi there');
    expect(result.userTurn.role).toBe('user');
    expect(result.assistantTurn.role).toBe('assistant');
    await manager.close();
  });

  it('builds session bootstrap from prior memory', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'Need to finish memory work. The project uses sqlite.',
        key_entities: ['sqlite'],
        topic_tags: ['memory'],
      }),
      autoCompact: false,
    });

    adapter.insertWorkingMemory({
      ...makeScope(),
      session_id: 'prior-session',
      summary: 'Need to finish memory work.',
      key_entities: ['memory'],
      topic_tags: ['continuity'],
      turn_id_start: 1,
      turn_id_end: 1,
      turn_count: 1,
      compaction_trigger: 'manual',
    });
    adapter.insertKnowledgeMemory({
      ...makeScope(),
      fact: 'The project uses sqlite',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });

    const bootstrap = await manager.getSessionBootstrap('sqlite');
    expect(bootstrap.workingMemory).toBeNull();
    expect(bootstrap.sessionState).toBeDefined();
    expect(bootstrap.relevantKnowledge.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('keeps active turns and working memory isolated to the current session', async () => {
    const scope = makeScope();
    const managerA = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-a',
      summarizer: async () => ({
        summary: 'session a summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });
    const managerB = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-b',
      summarizer: async () => ({
        summary: 'session b summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await managerA.processTurn('user', 'alpha one');
    await managerA.processTurn('assistant', 'alpha two');
    await managerB.processTurn('user', 'beta one');
    await managerB.processTurn('assistant', 'beta two');

    const contextA = await managerA.getContext();
    const contextB = await managerB.getContext();

    expect(contextA.activeTurns.map((turn) => turn.content)).toEqual(['alpha two']);
    expect(contextB.activeTurns.map((turn) => turn.content)).toEqual(['beta two']);
    expect(contextA.workingMemory?.summary).toBe('session a summary');
    expect(contextB.workingMemory?.summary).toBe('session b summary');

    await managerA.close();
    await managerB.close();
  });

  it('persists monitor state and defers soft compaction until forced', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 2,
        hardTurnThreshold: 10,
        softTokenThreshold: 5,
        hardTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'This should trigger soft compaction.');
    await manager.processTurn('assistant', 'Acknowledged.');

    expect(adapter.getContextMonitor(scope)?.compaction_state).toBe('soft_triggered');
    expect(adapter.getActiveWorkingMemory(scope)).toHaveLength(0);

    await manager.forceCompact();
    expect(adapter.getActiveWorkingMemory(scope).length).toBeGreaterThan(0);
    expect(adapter.getContextMonitor(scope)?.compaction_state).toBe('idle');
    await manager.close();
  });

  it('supports typed event subscriptions', async () => {
    const emitter = createMemoryEventEmitter();
    const managerEvents = vi.fn();
    emitter.on('manager', managerEvents);
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
      eventEmitter: emitter,
    });

    await manager.processTurn('user', 'hello');
    expect(managerEvents).toHaveBeenCalled();
    await manager.close();
  });

  it('can disable auto extract after extractor failure', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: `summary ${turns.length}`,
        key_entities: [],
        topic_tags: [],
      }),
      extractor: async () => {
        throw new Error('extract failed');
      },
      failurePolicy: {
        extractor: 'disable_auto_extract',
      },
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'The project uses sqlite.');
    await manager.processTurn('user', 'The project uses sqlite.');
    await manager.processTurn('user', 'three');
    await manager.processTurn('assistant', 'four');

    expect(adapter.getActiveWorkingMemory(makeScope()).length).toBeGreaterThan(0);
    expect(adapter.getActiveKnowledgeMemory(makeScope())).toEqual([]);
    await manager.close();
  });

  it('resets monitor state when summarizer falls back to log_and_continue', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => {
        throw new Error('summary failed');
      },
      failurePolicy: {
        summarizer: 'log_and_continue',
      },
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'one');
    await manager.processTurn('assistant', 'two');

    expect(adapter.getContextMonitor(scope)?.compaction_state).toBe('idle');
    expect(adapter.getActiveWorkingMemory(scope)).toHaveLength(0);
    await manager.close();
  });

  it('tracks work items and recalls by time range', async () => {
    const scope = makeScope();
    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });

    await manager.trackWorkItem('Ship the memory layer', 'objective', 'in_progress');
    const recall = await manager.recall({ start_at: 0, end_at: Math.floor(Date.now() / 1000) + 10 });
    expect(recall.workItems).toHaveLength(1);
    await manager.close();
  });

  it('creates a provider-backed memory manager with default wiring', async () => {
    const manager = createClaudeMemoryManager({
      dbPath: ':memory:',
      scope: makeScope(),
      summarizer: {
        client: {
          async generate(request) {
            if (request.expectedFormat === 'object') {
              return '{"summary":"Provider summary","key_entities":["memory"],"topic_tags":["sdk"]}';
            }
            return '[{"fact":"The project uses sqlite","factType":"reference","confidence":"high"}]';
          },
        },
      },
      extractor: {
        client: {
          async generate(request) {
            if (request.expectedFormat === 'object') {
              return '{"summary":"Provider summary","key_entities":["memory"],"topic_tags":["sdk"]}';
            }
            return '[{"fact":"The project uses sqlite","factType":"reference","confidence":"high"}]';
          },
        },
      },
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        hardTurnThreshold: 2,
        softTurnThreshold: 10,
        hardTokenThreshold: 5000,
        softTokenThreshold: 5000,
      },
    });

    await manager.processTurn('user', 'The project uses sqlite.');
    await manager.processTurn('user', 'The project uses sqlite.');
    const context = await manager.getContext('sqlite');
    expect(
      context.relevantKnowledge.some((item) => item.fact.includes('sqlite')) ||
        context.provisionalKnowledge.some((item) => item.fact.includes('sqlite')),
    ).toBe(true);
    await manager.close();
  });

  it('treats a long intra-session gap as a compaction boundary', async () => {
    const scope = makeScope();
    adapter.insertTurn({
      ...scope,
      session_id: 'session-gap',
      actor: 'user',
      role: 'user',
      content: 'old turn',
      created_at: 1,
    });

    const manager = createMemoryManager({
      adapter,
      scope,
      sessionId: 'session-gap',
      summarizer: async () => ({
        summary: 'session gap summary',
        key_entities: [],
        topic_tags: [],
      }),
      monitorPolicy: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 50,
        hardTurnThreshold: 100,
        softTokenThreshold: 50_000,
        hardTokenThreshold: 100_000,
        intraSessionGapSeconds: 10,
      },
    });

    await manager.processTurn('assistant', 'new turn after a long gap');
    expect(adapter.getActiveWorkingMemory(scope).length).toBeGreaterThan(0);
    await manager.close();
  });

  describe('episodic and cognitive methods', () => {
    function createMockStructuredClient(): StructuredGenerationClient {
      return {
        async generate(req) {
          if (req.systemPrompt.includes('episodic recaps')) {
            return JSON.stringify({
              objective: 'Discussed Rust preferences',
              actions: ['stated preference for Rust'],
              outcomes: ['preference recorded'],
              artifacts: [],
              unresolvedItems: [],
              sourceType: 'episodic',
              sources: [{ type: 'turn', id: 1, excerpt: 'I prefer Rust' }],
            });
          }
          return JSON.stringify({
            synthesis: 'The user prefers Rust for memory systems.',
            sourceType: 'mixed',
            sources: [
              { type: 'turn', id: 1, excerpt: 'I prefer Rust' },
              { type: 'knowledge', id: 1, excerpt: 'prefers Rust' },
            ],
            episodes: [],
            detailLevel: 'overview',
          });
        },
      };
    }

    it('searchEpisodes returns episode summaries', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
        structuredClient: createMockStructuredClient(),
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');
      await manager.processTurn('assistant', 'Understood, Rust is a great choice.');

      const episodes = await manager.searchEpisodes({ query: 'Rust' });
      expect(episodes.length).toBeGreaterThanOrEqual(1);
      expect(episodes[0].recap.objective).toBeTruthy();
      expect(episodes[0].sessionId).toBeTruthy();
      await manager.close();
    });

    it('summarizeEpisode returns a summary for a session', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
        structuredClient: createMockStructuredClient(),
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');

      const summary = await manager.summarizeEpisode('session-1', { detailLevel: 'abstract' });
      expect(summary.detailLevel).toBe('abstract');
      expect(summary.sessionId).toBe('session-1');
      expect(summary.recap.objective).toBeTruthy();
      await manager.close();
    });

    it('reflect synthesizes across memory types', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
        structuredClient: createMockStructuredClient(),
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');
      await manager.learnFact('User prefers Rust', 'preference', 'high');

      const result = await manager.reflect({ query: 'Rust' });
      expect(result.synthesis).toBeTruthy();
      expect(result.sourceType).toBeTruthy();
      expect(result.detailLevel).toBe('overview');
      await manager.close();
    });

    it('searchCognitive groups results by cognitive type', async () => {
      const manager = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({
          summary: 'User prefers Rust.',
          key_entities: ['Rust'],
          topic_tags: ['preferences'],
        }),
        autoCompact: false,
      });

      await manager.processTurn('user', 'I prefer Rust for memory systems.');
      await manager.learnFact('User prefers Rust', 'preference', 'high');

      const result = await manager.searchCognitive({ query: 'Rust' });
      expect(result.byType).toBeDefined();
      expect(result.all.length).toBeGreaterThan(0);
      expect(['episodic', 'semantic', 'procedural', 'working']).toContain(result.all[0].item.type);
      await manager.close();
    });

    it('searchEpisodes throws without structuredClient', async () => {
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
      });

      await expect(manager.searchEpisodes({ query: 'test' })).rejects.toThrow('structuredClient');
      await manager.close();
    });
  });

  describe('playbook methods', () => {
    it('createPlaybook inserts and returns a playbook', async () => {
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
      });

      const playbook = await manager.createPlaybook({
        title: 'Deploy procedure',
        description: 'How to deploy to production',
        instructions: '1. Build\n2. Test\n3. Push',
      });

      expect(playbook.id).toBeGreaterThan(0);
      expect(playbook.title).toBe('Deploy procedure');
      expect(playbook.instructions).toContain('Build');
      await manager.close();
    });

    it('getPlaybook retrieves by id', async () => {
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
      });

      const created = await manager.createPlaybook({
        title: 'Test playbook',
        description: 'For testing',
        instructions: 'Run tests',
      });

      const retrieved = await manager.getPlaybook(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe('Test playbook');
      await manager.close();
    });

    it('listPlaybooks returns active playbooks', async () => {
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
      });

      await manager.createPlaybook({
        title: 'Playbook A',
        description: 'A',
        instructions: 'A instructions',
      });
      await manager.createPlaybook({
        title: 'Playbook B',
        description: 'B',
        instructions: 'B instructions',
      });

      const list = await manager.listPlaybooks();
      expect(list.length).toBe(2);
      await manager.close();
    });

    it('searchPlaybooks finds matching playbooks', async () => {
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
      });

      await manager.createPlaybook({
        title: 'Deploy to staging',
        description: 'Staging deployment',
        instructions: 'Run deploy script',
      });
      await manager.createPlaybook({
        title: 'Run tests',
        description: 'Testing',
        instructions: 'npm test',
      });

      const results = await manager.searchPlaybooks('deploy');
      expect(results.length).toBe(1);
      expect(results[0].item.title).toContain('Deploy');
      await manager.close();
    });

    it('revisePlaybook stores revision and updates instructions', async () => {
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
      });

      const playbook = await manager.createPlaybook({
        title: 'Revisable',
        description: 'Will be revised',
        instructions: 'Original instructions',
      });

      const result = await manager.revisePlaybook(
        playbook.id,
        'Updated instructions',
        'Improved clarity',
      );

      expect(result.revision.instructions).toBe('Original instructions');
      expect(result.playbook.instructions).toBe('Updated instructions');
      await manager.close();
    });

    it('recordPlaybookUse increments use count', async () => {
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
      });

      const playbook = await manager.createPlaybook({
        title: 'Usable',
        description: 'Track usage',
        instructions: 'Do the thing',
      });

      await manager.recordPlaybookUse(playbook.id);
      const updated = await manager.getPlaybook(playbook.id);
      expect(updated!.use_count).toBe(1);
      await manager.close();
    });

    it('getPlaybook returns null for playbook from different scope', async () => {
      const scopeA = makeScope({ scope_id: 'scope-a' });
      const scopeB = makeScope({ scope_id: 'scope-b' });

      const managerA = createMemoryManager({
        adapter,
        scope: scopeA,
        sessionId: 'session-1',
        summarizer: async () => ({ summary: 's', key_entities: [], topic_tags: [] }),
        autoCompact: false,
      });

      const playbook = await managerA.createPlaybook({
        title: 'Scoped playbook',
        description: 'Belongs to scope-a',
        instructions: 'Do stuff',
      });

      const managerB = createMemoryManager({
        adapter,
        scope: scopeB,
        sessionId: 'session-1',
        summarizer: async () => ({ summary: 's', key_entities: [], topic_tags: [] }),
        autoCompact: false,
      });

      const result = await managerB.getPlaybook(playbook.id);
      expect(result).toBeNull();

      await managerA.close();
      await managerB.close();
    });

    it('recordPlaybookUse rejects cross-scope mutation', async () => {
      const scopeA = makeScope({ scope_id: 'scope-a' });
      const scopeB = makeScope({ scope_id: 'scope-b' });

      const managerA = createMemoryManager({
        adapter,
        scope: scopeA,
        sessionId: 'session-1',
        summarizer: async () => ({ summary: 's', key_entities: [], topic_tags: [] }),
        autoCompact: false,
      });

      const playbook = await managerA.createPlaybook({
        title: 'Protected',
        description: 'Cannot be used from other scope',
        instructions: 'Secret',
      });

      const managerB = createMemoryManager({
        adapter,
        scope: scopeB,
        sessionId: 'session-1',
        summarizer: async () => ({ summary: 's', key_entities: [], topic_tags: [] }),
        autoCompact: false,
      });

      await expect(managerB.recordPlaybookUse(playbook.id)).rejects.toThrow('does not belong');

      await managerA.close();
      await managerB.close();
    });

    it('createPlaybookFromTask throws without structuredClient', async () => {
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
      });

      await expect(
        manager.createPlaybookFromTask({
          title: 'Test',
          description: 'Test',
          sessionId: 'sess-1',
        }),
      ).rejects.toThrow('structuredClient');
      await manager.close();
    });
  });
});
