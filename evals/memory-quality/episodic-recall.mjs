import { createSQLiteAdapter } from '../../dist/adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { searchEpisodes, summarizeEpisode, reflect } from '../../dist/core/episodic.js';
import { assertScenario, ratio, tagEvalOutput } from './shared.mjs';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function makeScope(overrides = {}) {
  return {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'episodic-recall',
    scope_id: 'thread-1',
    ...overrides,
  };
}

/**
 * Deterministic mock structured-generation client.
 * Returns a fixed EpisodeRecap-shaped JSON so the eval exercises
 * the retrieval, grouping, detail-level, and source-ref pipeline
 * without requiring a real LLM.
 */
function createMockClient() {
  return {
    async generate(_request) {
      return JSON.stringify({
        objective: 'Deploy API to staging and run tests',
        actions: ['deployed API', 'ran integration tests'],
        outcomes: ['health checks pass', 'tests green'],
        artifacts: ['staging-url'],
        unresolvedItems: [],
      });
    },
  };
}

function createMockReflectClient() {
  return {
    async generate(_request) {
      return JSON.stringify({
        synthesis: 'The staging deployment succeeded and tests passed.',
        sourceType: 'mixed',
      });
    },
  };
}

function seedSessionTurns(adapter, scope, sessionId, turns) {
  const base = nowSec() - 1000;
  for (let i = 0; i < turns.length; i++) {
    adapter.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: turns[i].role,
      role: turns[i].role,
      content: turns[i].content,
      token_estimate: 10,
      created_at: base + i * 60,
    });
  }
}

function seedWorkingMemory(adapter, scope, sessionId, summary, startId, endId) {
  adapter.insertWorkingMemory({
    ...scope,
    session_id: sessionId,
    summary,
    key_entities: [],
    topic_tags: [],
    turn_id_start: startId,
    turn_id_end: endId,
    turn_count: endId - startId + 1,
    compaction_trigger: 'soft',
  });
}

// ---------- Metric 1: episodic_retrieval_precision ----------
async function evalRetrievalPrecision(adapter, asyncAdapter, scope) {
  const client = createMockClient();
  const deps = { adapter: asyncAdapter, scope, client };

  // Seed two sessions: one about deployment, one about unrelated billing
  seedSessionTurns(adapter, scope, 'deploy-session', [
    { role: 'user', content: 'Deploy the API to staging' },
    { role: 'assistant', content: 'Deployed. Health checks pass.' },
  ]);
  seedSessionTurns(adapter, scope, 'billing-session', [
    { role: 'user', content: 'Update the billing invoice template' },
    { role: 'assistant', content: 'Updated the billing template with new fields.' },
  ]);
  seedWorkingMemory(adapter, scope, 'deploy-session', 'Deployed API to staging.', 1, 2);
  seedWorkingMemory(adapter, scope, 'billing-session', 'Updated billing template.', 3, 4);

  const results = await searchEpisodes(deps, {
    query: 'deploy staging API',
    detailLevel: 'abstract',
    limit: 10,
  });

  // Precision: what fraction of returned episodes are relevant (deploy session)?
  const relevantCount = results.filter(
    (ep) => ep.sessionId === 'deploy-session',
  ).length;
  const precision = ratio(relevantCount, Math.max(results.length, 1));

  return {
    metric: precision,
    passed: relevantCount > 0 && precision >= 0.5,
    results,
  };
}

// ---------- Metric 2: episodic_recap_completeness ----------
async function evalRecapCompleteness(asyncAdapter, scope) {
  const client = createMockClient();
  const deps = { adapter: asyncAdapter, scope, client };

  const allWm = await asyncAdapter.getWorkingMemoryBySession('deploy-session', scope);
  let turns = [];
  for (const wm of allWm) {
    const range = await asyncAdapter.getArchivedTurnRange(
      'deploy-session', wm.turn_id_start, wm.turn_id_end, scope,
    );
    turns.push(...range);
  }

  // If no archived turns, fetch active turns
  if (turns.length === 0) {
    const active = await asyncAdapter.getActiveTurns(scope);
    turns = active.filter((t) => t.session_id === 'deploy-session');
  }

  const abstractSummary = await summarizeEpisode(deps, {
    turns,
    workingMemories: allWm,
    sessionId: 'deploy-session',
    detailLevel: 'abstract',
    client,
  });

  const overviewSummary = await summarizeEpisode(deps, {
    turns,
    workingMemories: allWm,
    sessionId: 'deploy-session',
    detailLevel: 'overview',
    client,
  });

  const fullSummary = await summarizeEpisode(deps, {
    turns,
    workingMemories: allWm,
    sessionId: 'deploy-session',
    detailLevel: 'full',
    client,
  });

  // Abstract: must have objective + outcomes
  const abstractOk =
    Boolean(abstractSummary.recap.objective) && Array.isArray(abstractSummary.recap.outcomes);
  // Overview: must also have actions
  const overviewOk = abstractOk && Array.isArray(overviewSummary.recap.actions) && overviewSummary.recap.actions.length > 0;
  // Full: must also have artifacts
  const fullOk = overviewOk && Array.isArray(fullSummary.recap.artifacts);

  const score = ratio(
    Number(abstractOk) + Number(overviewOk) + Number(fullOk),
    3,
  );

  return {
    metric: score,
    passed: score >= 0.9,
    abstractSummary,
    overviewSummary,
    fullSummary,
  };
}

// ---------- Metric 3: reflect_source_attribution ----------
async function evalReflectSourceAttribution(adapter, asyncAdapter, scope) {
  const client = createMockReflectClient();
  const deps = { adapter: asyncAdapter, scope, client };

  // Seed a knowledge fact so declarative is available
  adapter.insertKnowledgeMemory({
    ...scope,
    fact: 'The staging environment runs on port 8080.',
    fact_type: 'reference',
    knowledge_class: 'project_fact',
    source: 'user_stated',
    confidence: 'high',
  });

  const result = await reflect(deps, {
    query: 'staging deployment details',
    includeEpisodic: true,
    includeDeclarative: true,
    detailLevel: 'abstract',
  });

  // sourceType must be reported accurately
  const hasSourceType = ['episodic', 'declarative', 'mixed'].includes(result.sourceType);
  // Must have sources array with references
  const hasSources = Array.isArray(result.sources) && result.sources.length > 0;
  // Each source must have type and id
  const sourcesWellFormed = result.sources.every(
    (s) => ['turn', 'working_memory', 'knowledge'].includes(s.type) && typeof s.id === 'number',
  );

  const score = ratio(
    Number(hasSourceType) + Number(hasSources) + Number(sourcesWellFormed),
    3,
  );

  return {
    metric: score,
    passed: score >= 0.9,
    result,
  };
}

// ---------- Metric 4: episodic_isolation ----------
async function evalEpisodicIsolation(adapter, asyncAdapter, scope) {
  const client = createMockClient();
  const deps = { adapter: asyncAdapter, scope, client };

  // Capture knowledge count before episodic search
  const knowledgeBefore = adapter.getActiveKnowledgeMemory(scope);
  const countBefore = knowledgeBefore.length;

  // Run episodic operations
  await searchEpisodes(deps, { query: 'deploy', detailLevel: 'abstract' });

  // Capture knowledge count after — should be unchanged
  const knowledgeAfter = adapter.getActiveKnowledgeMemory(scope);
  const countAfter = knowledgeAfter.length;

  const isolated = countBefore === countAfter;

  return {
    metric: isolated ? 1 : 0,
    passed: isolated,
    countBefore,
    countAfter,
  };
}

export async function runEpisodicRecallEvals(_options = {}) {
  const scope = makeScope();
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);

  try {
    const precision = await evalRetrievalPrecision(adapter, asyncAdapter, scope);
    const completeness = await evalRecapCompleteness(asyncAdapter, scope);
    const attribution = await evalReflectSourceAttribution(adapter, asyncAdapter, scope);
    const isolation = await evalEpisodicIsolation(adapter, asyncAdapter, scope);

    const metrics = {
      episodicRetrievalPrecision: precision.metric,
      episodicRecapCompleteness: completeness.metric,
      reflectSourceAttribution: attribution.metric,
      episodicIsolation: isolation.metric,
    };

    return tagEvalOutput('episodic-recall', {
      metrics,
      scenarios: [
        assertScenario('episodic_retrieval_returns_relevant_sessions', precision.passed, {
          resultCount: precision.results.length,
          relevantSessions: precision.results.map((r) => r.sessionId),
        }),
        assertScenario('recap_completeness_across_detail_levels', completeness.passed, {
          abstractHasObjective: Boolean(completeness.abstractSummary?.recap?.objective),
          overviewHasActions: completeness.overviewSummary?.recap?.actions?.length > 0,
          fullHasArtifacts: Array.isArray(completeness.fullSummary?.recap?.artifacts),
        }),
        assertScenario('reflect_attributes_sources_accurately', attribution.passed, {
          sourceType: attribution.result?.sourceType,
          sourceCount: attribution.result?.sources?.length,
        }),
        assertScenario('episodic_operations_do_not_promote_to_knowledge', isolation.passed, {
          knowledgeBefore: isolation.countBefore,
          knowledgeAfter: isolation.countAfter,
        }),
      ],
      diagnostic: {
        metricTraces: {
          episodicRetrievalPrecision: {
            stage: 'episodic_search',
            sessions: precision.results.map((r) => r.sessionId),
          },
          episodicRecapCompleteness: {
            stage: 'summarize_episode',
            detailLevels: ['abstract', 'overview', 'full'],
          },
          reflectSourceAttribution: {
            stage: 'reflect_synthesis',
            sourceType: attribution.result?.sourceType,
            sources: attribution.result?.sources,
          },
          episodicIsolation: {
            stage: 'knowledge_isolation',
            countBefore: isolation.countBefore,
            countAfter: isolation.countAfter,
          },
        },
      },
    });
  } finally {
    adapter.close();
  }
}
