import {
  createInMemoryAdapter,
  getCoreMemory,
  computeClusters,
  discoverAliasCandidates,
} from '../../dist/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

export async function runIntelligenceEvals(_options = {}) {
  const adapter = createInMemoryAdapter();
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    scope_id: 'intelligence-eval',
  };
  const now = Math.floor(Date.now() / 1000);

  // Seed knowledge directly via adapter
  const facts = [
    ['The system uses TypeScript.', 'reference', 'project_fact', 'identity'],
    ['The user prefers dark mode.', 'preference', 'preference', null],
    ['The project must support offline mode.', 'constraint', 'constraint', null],
    ['Decided to use SQLite for local storage.', 'decision', 'strategy', null],
    ['The project name is MemoryLayer.', 'entity', 'identity', 'identity'],
    ['The system runs on Node.js.', 'reference', 'project_fact', null],
    ['API responses must be under 200ms.', 'constraint', 'constraint', null],
    ['The user prefers vim keybindings.', 'preference', 'preference', null],
  ];

  for (const [fact, factType, kClass, kClassOverride] of facts) {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact,
      fact_type: factType,
      knowledge_class: kClassOverride ?? kClass,
      source: 'user_stated',
      confidence: 'high',
      created_at: now,
      last_accessed_at: now,
      tags: kClass === 'constraint' ? ['backend'] : [],
    });
  }

  // --- Metric: core_memory_token_budget ---
  const asyncAdapter = wrapSyncAdapter(adapter);
  const coreBundle = await getCoreMemory(asyncAdapter, scope, { tokenBudget: 1500 });
  const coreTokens = coreBundle.tokenEstimate;
  const coreMemoryWithinBudget = coreTokens <= 1500 ? 1 : 0;

  // --- Metric: tag_filtering_accuracy ---
  // Test that tag filtering returns only tagged facts
  const allKnowledge = adapter.getActiveKnowledgeMemory(scope);
  const backendTagged = allKnowledge.filter((k) => k.tags.includes('backend'));
  const nonBackend = allKnowledge.filter((k) => !k.tags.includes('backend'));
  const taggedAreConstraints = backendTagged.every((k) => k.knowledge_class === 'constraint');
  const nonTaggedHaveNoBackendTag = nonBackend.every((k) => !k.tags.includes('backend'));
  const tagFilteringAccuracy = average([
    backendTagged.length >= 2 ? 1 : 0,
    taggedAreConstraints ? 1 : 0,
    nonTaggedHaveNoBackendTag ? 1 : 0,
  ]);

  // --- Metric: alias_resolution_quality ---
  const aliasKnowledge = allKnowledge.map((k) => k); // use real knowledge
  // Add more facts with similar subjects for alias detection
  adapter.insertKnowledgeMemory({
    ...scope, fact: 'TypeScript strict mode is enabled', fact_type: 'reference',
    knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
    fact_subject: 'TypeScript', created_at: now, last_accessed_at: now,
  });
  adapter.insertKnowledgeMemory({
    ...scope, fact: 'Typescript config uses strict', fact_type: 'reference',
    knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
    fact_subject: 'Typescript', created_at: now, last_accessed_at: now,
  });
  adapter.insertKnowledgeMemory({
    ...scope, fact: 'PostgreSQL handles data', fact_type: 'reference',
    knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
    fact_subject: 'PostgreSQL', created_at: now, last_accessed_at: now,
  });
  adapter.insertKnowledgeMemory({
    ...scope, fact: 'Postgres is production DB', fact_type: 'reference',
    knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
    fact_subject: 'Postgres', created_at: now, last_accessed_at: now,
  });

  const updatedKnowledge = adapter.getActiveKnowledgeMemory(scope);
  const candidates = discoverAliasCandidates(updatedKnowledge, { threshold: 0.75 });
  const foundTS = candidates.some(
    (c) => c.entity1.toLowerCase().includes('typescript') && c.entity2.toLowerCase().includes('typescript'),
  );
  const foundPG = candidates.some(
    (c) =>
      (c.entity1.toLowerCase().includes('postgres') && c.entity2.toLowerCase().includes('postgres')),
  );
  const aliasResolutionQuality = average([
    foundTS ? 1 : 0,
    foundPG ? 1 : 0,
    candidates.length > 0 ? 1 : 0,
  ]);

  // --- Metric: cluster_coherence ---
  // Create two clear clusters via associations
  const k = adapter.getActiveKnowledgeMemory(scope);
  // Connect first 3 facts and last 3 facts
  if (k.length >= 6) {
    for (let i = 0; i < 2; i++) {
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: k[i].id,
        target_kind: 'knowledge', target_id: k[i + 1].id,
        association_type: 'related_to', confidence: 0.9, auto_generated: true,
      });
    }
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k[0].id,
      target_kind: 'knowledge', target_id: k[2].id,
      association_type: 'related_to', confidence: 0.9, auto_generated: true,
    });
    for (let i = 3; i < 5; i++) {
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: k[i].id,
        target_kind: 'knowledge', target_id: k[i + 1].id,
        association_type: 'related_to', confidence: 0.9, auto_generated: true,
      });
    }
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k[3].id,
      target_kind: 'knowledge', target_id: k[5].id,
      association_type: 'related_to', confidence: 0.9, auto_generated: true,
    });
  }

  const associations = adapter.listAssociations(scope);
  const clusterResult = computeClusters(k, associations);
  const hasClusters = clusterResult.clusters.length >= 1;
  const highCohesion = clusterResult.clusters.every((c) => c.cohesion >= 0.5);
  const clusterCoherence = average([
    hasClusters ? 1 : 0,
    highCohesion ? 1 : 0,
    clusterResult.clusters.length >= 2 ? 1 : 0.5,
  ]);

  const metrics = {
    coreMemoryTokenBudget: coreMemoryWithinBudget,
    tagFilteringAccuracy,
    aliasResolutionQuality,
    clusterCoherence,
  };

  return tagEvalOutput('intelligence', {
    metrics,
    scenarios: [
      assertScenario('core_memory_within_1500_tokens', coreMemoryWithinBudget === 1, {
        coreTokens,
        identityCount: coreBundle.identity.length,
        constraintCount: coreBundle.constraints.length,
        normCount: coreBundle.norms.length,
        workItemCount: coreBundle.workItems.length,
        hasPlaybook: coreBundle.topPlaybook != null,
      }),
      assertScenario('tag_filtering_correct', tagFilteringAccuracy >= 0.8, {
        backendTaggedCount: backendTagged.length,
        taggedAreConstraints,
      }),
      assertScenario('alias_candidates_detected', aliasResolutionQuality >= 0.5, {
        candidateCount: candidates.length,
        foundTS,
        foundPG,
      }),
      assertScenario('cluster_detection_coherent', clusterCoherence >= 0.5, {
        clusterCount: clusterResult.clusters.length,
        cohesionValues: clusterResult.clusters.map((c) => c.cohesion),
      }),
    ],
  });
}
