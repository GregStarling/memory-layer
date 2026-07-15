import { createSQLiteAdapter } from '../../dist/adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { searchEpisodes, summarizeEpisode, reflect } from '../../dist/core/episodic.js';
import { assertScenario, average, ratio, resolveEvalClient, tagEvalOutput } from './shared.mjs';

/**
 * Episodic-recall metrics — de-fitted from 1-3 examples to >=20 distinct
 * episodes/queries each (manager decision D4). Twenty materially-distinct
 * sessions (deploy, billing, search, auth, warehouse, cache, payments, ...) are
 * seeded into one store; each metric is measured across all twenty:
 *   - episodicRetrievalPrecision: per-topic query precision (relevant episodes
 *     / returned), averaged over 20 queries against 20 competing sessions.
 *   - episodicRecapCompleteness: recap structure across abstract/overview/full
 *     for all 20 sessions.
 *   - reflectSourceAttribution: source attribution well-formedness for 20
 *     reflect queries.
 *   - episodicIsolation: knowledge count invariance across 20 episodic ops.
 *
 * LIVE PROFILE (D4): the mock clients are wrapped with resolveEvalClient(), so
 * MEMORY_EVAL_LIVE=1 + OPENAI_API_KEY swaps in the real model for recap/reflect
 * synthesis (local only; CI runs the deterministic mock).
 */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

const SCOPE = {
  tenant_id: 'eval',
  system_id: 'memory-quality',
  workspace_id: 'episodic-recall',
  scope_id: 'thread-1',
};

// 20 materially-distinct sessions with disjoint vocabulary so a topic query
// retrieves its own session, not the distractors.
const EPISODES = [
  { id: 'deploy-session', kw: 'deploy the API to staging', user: 'Deploy the API to staging', assistant: 'Deployed. Staging health checks pass.', summary: 'Deployed API to staging.', fact: 'The staging environment runs on port 8080.' },
  { id: 'billing-session', kw: 'update the billing invoice template', user: 'Update the billing invoice template', assistant: 'Updated the billing invoice template.', summary: 'Updated billing invoice template.', fact: 'Invoices are generated on the first of the month.' },
  { id: 'search-session', kw: 'rebuild the search index', user: 'Rebuild the search index', assistant: 'Search index rebuilt.', summary: 'Rebuilt the search index.', fact: 'Search runs on OpenSearch.' },
  { id: 'auth-session', kw: 'rotate the auth signing keys', user: 'Rotate the auth signing keys', assistant: 'Auth signing keys rotated.', summary: 'Rotated auth signing keys.', fact: 'Auth tokens expire after one hour.' },
  { id: 'warehouse-session', kw: 'load the data warehouse', user: 'Load the data warehouse', assistant: 'Warehouse load complete.', summary: 'Loaded the data warehouse.', fact: 'The warehouse loads pause during business hours.' },
  { id: 'cache-session', kw: 'tune the cache eviction policy', user: 'Tune the cache eviction policy', assistant: 'Cache eviction policy tuned to LRU.', summary: 'Tuned cache eviction.', fact: 'The cache uses an LRU eviction policy.' },
  { id: 'payments-session', kw: 'configure the payment gateway retries', user: 'Configure payment gateway retries', assistant: 'Payment gateway retries capped at three.', summary: 'Configured payment retries.', fact: 'Payments cap retries at three attempts.' },
  { id: 'email-session', kw: 'batch the email relay sends', user: 'Batch the email relay sends', assistant: 'Email relay batching enabled.', summary: 'Batched email relay.', fact: 'Email sends batch in five-minute windows.' },
  { id: 'cdn-session', kw: 'purge the cdn edge cache', user: 'Purge the CDN edge cache', assistant: 'CDN edge cache purged.', summary: 'Purged CDN cache.', fact: 'CDN caches assets for one day.' },
  { id: 'metrics-session', kw: 'roll up the metrics pipeline', user: 'Roll up the metrics pipeline', assistant: 'Metrics pipeline rolled up hourly.', summary: 'Rolled up metrics.', fact: 'Metrics roll up hourly.' },
  { id: 'feature-session', kw: 'snapshot the feature store', user: 'Snapshot the feature store', assistant: 'Feature store snapshot versioned.', summary: 'Snapshotted feature store.', fact: 'Feature store snapshots are versioned.' },
  { id: 'logs-session', kw: 'archive the application logs', user: 'Archive the application logs', assistant: 'Logs archived for ninety days.', summary: 'Archived logs.', fact: 'Logs are retained for ninety days.' },
  { id: 'mobile-session', kw: 'ship the mobile release', user: 'Ship the mobile release', assistant: 'Mobile release shipped.', summary: 'Shipped mobile release.', fact: 'Mobile releases ship every two weeks.' },
  { id: 'admin-session', kw: 'review the admin console approvals', user: 'Review admin console approvals', assistant: 'Admin console approvals reviewed.', summary: 'Reviewed admin approvals.', fact: 'Admin actions require a second approver.' },
  { id: 'backup-session', kw: 'test the backup vault restore', user: 'Test the backup vault restore', assistant: 'Backup vault restore tested.', summary: 'Tested backup restore.', fact: 'Backup restores are tested each quarter.' },
  { id: 'analytics-session', kw: 'schedule the analytics job', user: 'Schedule the analytics job', assistant: 'Analytics job scheduled after midnight.', summary: 'Scheduled analytics job.', fact: 'Analytics jobs run after midnight UTC.' },
  { id: 'webhook-session', kw: 'sign the webhook payloads', user: 'Sign the webhook payloads', assistant: 'Webhook payloads now signed.', summary: 'Signed webhook payloads.', fact: 'Webhook dispatch signs every payload.' },
  { id: 'image-session', kw: 'cap the image upload size', user: 'Cap the image upload size', assistant: 'Image uploads capped at ten megabytes.', summary: 'Capped image uploads.', fact: 'Image uploads cap at ten megabytes.' },
  { id: 'notify-session', kw: 'dedupe the notification hub', user: 'Dedupe the notification hub', assistant: 'Notification hub deduping within a minute.', summary: 'Deduped notifications.', fact: 'Notifications dedupe within one minute.' },
  { id: 'report-session', kw: 'paginate the report builder output', user: 'Paginate the report builder output', assistant: 'Report builder output paginated.', summary: 'Paginated report output.', fact: 'Report builder outputs are paginated.' },
];

function createMockClient() {
  return {
    async generate() {
      return JSON.stringify({
        objective: 'Complete the requested operation',
        actions: ['performed the operation', 'verified the result'],
        outcomes: ['operation succeeded', 'checks pass'],
        artifacts: ['operation-log'],
        unresolvedItems: [],
      });
    },
  };
}

function createMockReflectClient() {
  return {
    async generate() {
      return JSON.stringify({
        synthesis: 'The requested operation completed and was verified.',
        sourceType: 'mixed',
      });
    },
  };
}

function seedEpisodes(adapter) {
  const base = nowSec() - 100000;
  let turnId = 0;
  EPISODES.forEach((ep, epIndex) => {
    const startId = turnId + 1;
    adapter.insertTurn({ ...SCOPE, session_id: ep.id, actor: 'user', role: 'user', content: ep.user, token_estimate: 10, created_at: base + epIndex * 200 });
    turnId += 1;
    adapter.insertTurn({ ...SCOPE, session_id: ep.id, actor: 'assistant', role: 'assistant', content: ep.assistant, token_estimate: 10, created_at: base + epIndex * 200 + 60 });
    turnId += 1;
    adapter.insertWorkingMemory({
      ...SCOPE, session_id: ep.id, summary: ep.summary, key_entities: [], topic_tags: [],
      turn_id_start: startId, turn_id_end: turnId, turn_count: 2, compaction_trigger: 'soft',
    });
    adapter.insertKnowledgeMemory({
      ...SCOPE, fact: ep.fact, fact_type: 'reference', knowledge_class: 'project_fact',
      source: 'user_stated', confidence: 'high',
    });
  });
}

export async function runEpisodicRecallEvals(_options = {}) {
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const recapClient = resolveEvalClient(createMockClient());
  const reflectClient = resolveEvalClient(createMockReflectClient());

  try {
    seedEpisodes(adapter);

    // ---- episodicRetrievalPrecision ----
    // precision@1: with all 20 competing sessions in the store, does the topic
    // query rank its OWN session first? (precision@k with only one relevant doc
    // among 20 is uninformative — 1/k by construction; ranking quality is the
    // honest signal.) Averaged over 20 disjoint-vocabulary topics.
    const precisions = [];
    for (const ep of EPISODES) {
      const results = await searchEpisodes({ adapter: asyncAdapter, scope: SCOPE, client: recapClient }, {
        query: ep.kw,
        detailLevel: 'abstract',
        limit: EPISODES.length,
      });
      precisions.push(results[0]?.sessionId === ep.id ? 1 : 0);
    }
    const episodicRetrievalPrecision = average(precisions);

    // ---- episodicRecapCompleteness ----
    const completenessScores = [];
    for (const ep of EPISODES) {
      const deps = { adapter: asyncAdapter, scope: SCOPE, client: recapClient };
      const wm = await asyncAdapter.getWorkingMemoryBySession(ep.id, SCOPE);
      const active = await asyncAdapter.getActiveTurns(SCOPE);
      const turns = active.filter((t) => t.session_id === ep.id);
      const levels = await Promise.all(
        ['abstract', 'overview', 'full'].map((detailLevel) =>
          summarizeEpisode(deps, { turns, workingMemories: wm, sessionId: ep.id, detailLevel, client: recapClient }),
        ),
      );
      const [abstractS, overviewS, fullS] = levels;
      const abstractOk = Boolean(abstractS.recap.objective) && Array.isArray(abstractS.recap.outcomes);
      const overviewOk = abstractOk && Array.isArray(overviewS.recap.actions) && overviewS.recap.actions.length > 0;
      const fullOk = overviewOk && Array.isArray(fullS.recap.artifacts);
      completenessScores.push(ratio(Number(abstractOk) + Number(overviewOk) + Number(fullOk), 3));
    }
    const episodicRecapCompleteness = average(completenessScores);

    // ---- reflectSourceAttribution ----
    const attributionScores = [];
    for (const ep of EPISODES) {
      const deps = { adapter: asyncAdapter, scope: SCOPE, client: reflectClient };
      const result = await reflect(deps, {
        query: ep.kw,
        includeEpisodic: true,
        includeDeclarative: true,
        detailLevel: 'abstract',
      });
      const hasSourceType = ['episodic', 'declarative', 'mixed'].includes(result.sourceType);
      const hasSources = Array.isArray(result.sources) && result.sources.length > 0;
      const wellFormed = result.sources.every(
        (s) => ['turn', 'working_memory', 'knowledge'].includes(s.type) && typeof s.id === 'number',
      );
      attributionScores.push(ratio(Number(hasSourceType) + Number(hasSources) + Number(wellFormed), 3));
    }
    const reflectSourceAttribution = average(attributionScores);

    // ---- episodicIsolation ----
    let isolatedCount = 0;
    for (const ep of EPISODES) {
      const before = adapter.getActiveKnowledgeMemory(SCOPE).length;
      await searchEpisodes({ adapter: asyncAdapter, scope: SCOPE, client: recapClient }, { query: ep.kw, detailLevel: 'abstract' });
      const after = adapter.getActiveKnowledgeMemory(SCOPE).length;
      if (before === after) isolatedCount += 1;
    }
    const episodicIsolation = ratio(isolatedCount, EPISODES.length);

    const metrics = {
      episodicRetrievalPrecision,
      episodicRecapCompleteness,
      reflectSourceAttribution,
      episodicIsolation,
    };

    return tagEvalOutput('episodic-recall', {
      metrics,
      scenarios: [
        assertScenario('episodic_retrieval_precise_across_topics', episodicRetrievalPrecision >= 0.85, {
          episodes: EPISODES.length,
          precision: episodicRetrievalPrecision,
        }),
        assertScenario('recap_complete_across_detail_levels', episodicRecapCompleteness >= 0.9, {
          episodes: EPISODES.length,
        }),
        assertScenario('reflect_attributes_sources', reflectSourceAttribution >= 0.9, {
          episodes: EPISODES.length,
        }),
        assertScenario('episodic_ops_do_not_promote_to_knowledge', episodicIsolation >= 0.95, {
          episodes: EPISODES.length,
          isolatedCount,
        }),
      ],
      diagnostic: {
        metricTraces: {
          episodicRetrievalPrecision: { stage: 'episodic_search', episodes: EPISODES.length, perTopic: precisions },
          episodicRecapCompleteness: { stage: 'summarize_episode', episodes: EPISODES.length },
          reflectSourceAttribution: { stage: 'reflect_synthesis', episodes: EPISODES.length },
          episodicIsolation: { stage: 'knowledge_isolation', isolatedCount, episodes: EPISODES.length },
        },
      },
    });
  } finally {
    adapter.close();
  }
}
