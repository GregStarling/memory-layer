import {
  createInMemoryAdapter,
  createMemoryManager,
  createSQLiteAdapter,
} from '../../dist/index.js';
import { assertScenario, average, tagEvalOutput, withFrozenNow } from './shared.mjs';

function knowledgeFacts(results) {
  return results.knowledge.map((entry) => entry.item.fact);
}

export async function runLongHorizonEvals(_options = {}) {
  const strategyAdapter = createSQLiteAdapter(':memory:');
  const strategyMemory = createMemoryManager({
    adapter: strategyAdapter,
    scope: {
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'long-horizon',
      scope_id: 'strategy-thread',
    },
    sessionId: 'strategy-eval',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
  });
  const sharedAdapter = createSQLiteAdapter(':memory:');

  const localMemory = createMemoryManager({
    adapter: sharedAdapter,
    scope: {
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'shared-workspace',
      scope_id: 'task-a',
    },
    sessionId: 'task-a',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
    crossScopeLevel: 'workspace',
  });

  const siblingMemory = createMemoryManager({
    adapter: sharedAdapter,
    scope: {
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'shared-workspace',
      scope_id: 'task-b',
    },
    sessionId: 'task-b',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
  });

  const maintenanceAdapter = createInMemoryAdapter();
  const maintenanceMemory = createMemoryManager({
    adapter: maintenanceAdapter,
    scope: {
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'maintenance',
      scope_id: 'thread-1',
    },
    sessionId: 'maintenance-eval',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
  });

  try {
    const successfulStrategy = await strategyAdapter.insertKnowledgeMemory({
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'long-horizon',
      scope_id: 'strategy-thread',
      fact: 'Use smaller batches for migrations.',
      fact_type: 'decision',
      knowledge_state: 'provisional',
      knowledge_class: 'procedure',
      source: 'manual',
      confidence: 'high',
      grounding_strength: 'strong',
      evidence_count: 2,
      trust_score: 0.7,
      source_turn_ids: [],
    });
    strategyAdapter.insertKnowledgeEvidenceBatch([
      {
        tenant_id: 'eval',
        system_id: 'memory-quality',
        workspace_id: 'long-horizon',
        scope_id: 'strategy-thread',
        knowledge_memory_id: successfulStrategy.id,
        source_type: 'execution_result',
        support_polarity: 'supports',
        excerpt: 'Use smaller batches for migrations.',
        is_explicit: true,
        explicitness_score: 1,
        outcome: 'success',
      },
      {
        tenant_id: 'eval',
        system_id: 'memory-quality',
        workspace_id: 'long-horizon',
        scope_id: 'strategy-thread',
        knowledge_memory_id: successfulStrategy.id,
        source_type: 'human_feedback',
        support_polarity: 'supports',
        excerpt: 'This worked repeatedly.',
        is_explicit: true,
        explicitness_score: 1,
        outcome: 'success',
      },
    ]);
    const failedStrategy = await strategyAdapter.insertKnowledgeMemory({
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'long-horizon',
      scope_id: 'strategy-thread',
      fact: 'Use aggressive caching during deploys.',
      fact_type: 'decision',
      knowledge_state: 'provisional',
      knowledge_class: 'procedure',
      source: 'manual',
      confidence: 'medium',
      grounding_strength: 'moderate',
      evidence_count: 1,
      trust_score: 0.55,
      source_turn_ids: [],
    });
    strategyAdapter.insertKnowledgeEvidence({
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'long-horizon',
      scope_id: 'strategy-thread',
      knowledge_memory_id: failedStrategy.id,
      source_type: 'execution_result',
      support_polarity: 'supports',
      excerpt: 'Aggressive caching caused stale reads.',
      is_explicit: true,
      explicitness_score: 1,
      outcome: 'failure',
    });
    await strategyMemory.reverifyKnowledge(successfulStrategy.id);
    await strategyMemory.reverifyKnowledge(failedStrategy.id);
    const successfulInspection = await strategyMemory.inspectKnowledge(successfulStrategy.id);
    const failedInspection = await strategyMemory.inspectKnowledge(failedStrategy.id);
    const strategyFacts = [
      successfulInspection.knowledge?.fact ?? null,
      failedInspection.knowledge?.fact ?? null,
    ].filter(Boolean);
    const successfulStrategyRecalled =
      successfulInspection.knowledge?.knowledge_state === 'trusted' &&
      successfulInspection.knowledge?.knowledge_class === 'strategy';
    const failedStrategyDominates = failedInspection.knowledge?.knowledge_class !== 'anti_pattern';

    await localMemory.learnFact('Task A constraint: stay local-first.', 'constraint', 'high');
    await siblingMemory.learnFact('Task B secret: deploy to us-east staging.', 'reference', 'high');
    // Sharing across scopes now requires an explicit visibility class (F4 gates
    // private facts even at workspace widening), so the inheritable fact is
    // deliberately published at workspace visibility while the secret stays private.
    await siblingMemory.learnFact(
      'Task B shared runbook: us-east staging deploys use the shared checklist.',
      'reference',
      'high',
      undefined,
      { visibilityClass: 'workspace' },
    );
    const defaultContext = await localMemory.getContext('deployment staging local-first');
    const siblingLeakedIntoDefault = defaultContext.relevantKnowledge.some((item) =>
      item.fact.includes('us-east staging'),
    );
    const workspaceResults = await localMemory.searchCrossScope('us-east staging', 'workspace');
    const workspaceFacts = knowledgeFacts(workspaceResults);
    const explicitWorkspaceInheritance =
      workspaceFacts.some((fact) => fact.includes('shared checklist')) &&
      !workspaceFacts.some((fact) => fact.includes('Task B secret'));

    const { staleProjectFact, provisionalFact } = await withFrozenNow('2024-01-01T00:00:00Z', async () => {
      await maintenanceMemory.learnFact('Critical constraint: stay local-first.', 'constraint', 'high');
      const insertedProjectFact = maintenanceAdapter.insertKnowledgeMemory({
        tenant_id: 'eval',
        system_id: 'memory-quality',
        workspace_id: 'maintenance',
        scope_id: 'thread-1',
        fact: 'The deploy target is us-east staging.',
        fact_type: 'reference',
        knowledge_state: 'trusted',
        knowledge_class: 'project_fact',
        source: 'manual',
        confidence: 'high',
        trust_score: 0.85,
        verification_status: 'verified',
        last_verified_at: Math.floor(Date.now() / 1000),
      });
      maintenanceAdapter.insertKnowledgeEvidence({
        tenant_id: 'eval',
        system_id: 'memory-quality',
        workspace_id: 'maintenance',
        scope_id: 'thread-1',
        knowledge_memory_id: insertedProjectFact.id,
        source_type: 'user_turn',
        support_polarity: 'supports',
        excerpt: 'The deploy target is us-east staging.',
        is_explicit: true,
        explicitness_score: 1,
      });
      const insertedProvisionalFact = maintenanceAdapter.insertKnowledgeMemory({
        tenant_id: 'eval',
        system_id: 'memory-quality',
        workspace_id: 'maintenance',
        scope_id: 'thread-1',
        fact: 'Temporary note about a short-lived branch.',
        fact_type: 'reference',
        knowledge_state: 'provisional',
        knowledge_class: 'episodic_fact',
        source: 'manual',
        confidence: 'medium',
        trust_score: 0.45,
      });
      return { staleProjectFact: insertedProjectFact, provisionalFact: insertedProvisionalFact };
    });
    const maintenanceResult = await withFrozenNow('2024-02-20T00:00:00Z', async () =>
      maintenanceMemory.runMaintenance({
        workingMemoryTtlSeconds: 1,
        completedWorkItemTtlSeconds: 1,
        knowledgeStaleAfterSeconds: 60 * 60 * 24 * 30,
        minKnowledgeAccessCount: 1,
        maxActiveKnowledgeItems: 50,
      }),
    );
    const maintenanceContext = await maintenanceMemory.getContext('local-first');
    const criticalConstraintSurvivedMaintenance = maintenanceContext.relevantKnowledge.some((item) =>
      item.fact.toLowerCase().includes('local-first'),
    );
    const staleProjectFactDemoted =
      maintenanceAdapter.getKnowledgeMemoryById(staleProjectFact.id)?.knowledge_state === 'provisional';
    const provisionalFactExpired =
      maintenanceAdapter.getKnowledgeMemoryById(provisionalFact.id)?.retired_at != null;

    return tagEvalOutput('long-horizon', {
      metrics: {
        strategyOutcomeRecallRate: average([
          Number(successfulStrategyRecalled),
          Number(!failedStrategyDominates),
        ]),
        memoryIsolationAccuracy: average([
          Number(!siblingLeakedIntoDefault),
          Number(explicitWorkspaceInheritance),
        ]),
        postMaintenanceFidelityScore: average([
          Number(criticalConstraintSurvivedMaintenance),
          Number(staleProjectFactDemoted),
          Number(provisionalFactExpired),
        ]),
      },
      scenarios: [
        assertScenario('recalls_successful_strategy_outcome', successfulStrategyRecalled, {
          facts: strategyFacts,
        }),
        assertScenario('failed_strategy_does_not_dominate_default_recall', !failedStrategyDominates, {
          facts: strategyFacts,
        }),
        assertScenario('sibling_scope_memory_does_not_leak_by_default', !siblingLeakedIntoDefault, {
          facts: defaultContext.relevantKnowledge.map((item) => item.fact),
        }),
        assertScenario('explicit_workspace_inheritance_can_surface_shared_memory', explicitWorkspaceInheritance, {
          facts: knowledgeFacts(workspaceResults),
        }),
        assertScenario('important_constraint_survives_maintenance', criticalConstraintSurvivedMaintenance, {
          report: maintenanceResult,
          facts: maintenanceContext.relevantKnowledge.map((item) => item.fact),
        }),
        assertScenario('stale_project_fact_is_demoted_by_maintenance', staleProjectFactDemoted, {
          report: maintenanceResult,
          knowledge: maintenanceAdapter.getKnowledgeMemoryById(staleProjectFact.id),
        }),
        assertScenario('weak_provisional_fact_expires_during_maintenance', provisionalFactExpired, {
          report: maintenanceResult,
          knowledge: maintenanceAdapter.getKnowledgeMemoryById(provisionalFact.id),
        }),
      ],
      diagnostic: {
        metricTraces: {
          strategyOutcomeRecallRate: {
            stage: 'strategy_reverification',
            successfulKnowledge: successfulInspection.knowledge,
            failedKnowledge: failedInspection.knowledge,
          },
          memoryIsolationAccuracy: {
            stage: 'cross_scope_context',
            defaultContextFacts: defaultContext.relevantKnowledge.map((item) => item.fact),
            workspaceFacts: knowledgeFacts(workspaceResults),
          },
          postMaintenanceFidelityScore: {
            stage: 'maintenance_lifecycle',
            report: maintenanceResult,
            maintenanceFacts: maintenanceContext.relevantKnowledge.map((item) => item.fact),
            staleProjectFact: maintenanceAdapter.getKnowledgeMemoryById(staleProjectFact.id),
            provisionalFact: maintenanceAdapter.getKnowledgeMemoryById(provisionalFact.id),
          },
        },
        scenarioTraces: {
          recalls_successful_strategy_outcome: {
            stage: 'strategy_reverification',
            knowledge: successfulInspection.knowledge,
            audits: successfulInspection.audits,
          },
          failed_strategy_does_not_dominate_default_recall: {
            stage: 'strategy_reverification',
            knowledge: failedInspection.knowledge,
            audits: failedInspection.audits,
          },
          sibling_scope_memory_does_not_leak_by_default: {
            stage: 'cross_scope_context',
            defaultContextFacts: defaultContext.relevantKnowledge.map((item) => item.fact),
          },
          explicit_workspace_inheritance_can_surface_shared_memory: {
            stage: 'cross_scope_context',
            workspaceFacts: knowledgeFacts(workspaceResults),
          },
          important_constraint_survives_maintenance: {
            stage: 'maintenance_lifecycle',
            report: maintenanceResult,
            maintenanceFacts: maintenanceContext.relevantKnowledge.map((item) => item.fact),
          },
          stale_project_fact_is_demoted_by_maintenance: {
            stage: 'maintenance_lifecycle',
            report: maintenanceResult,
            knowledge: maintenanceAdapter.getKnowledgeMemoryById(staleProjectFact.id),
          },
          weak_provisional_fact_expires_during_maintenance: {
            stage: 'maintenance_lifecycle',
            report: maintenanceResult,
            knowledge: maintenanceAdapter.getKnowledgeMemoryById(provisionalFact.id),
          },
        },
      },
    });
  } finally {
    await Promise.all([
      strategyMemory.close(),
      maintenanceMemory.close(),
    ]);
    strategyAdapter.close();
    sharedAdapter.close();
    maintenanceAdapter.close();
  }
}
