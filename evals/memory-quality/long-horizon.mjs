import {
  createInMemoryAdapter,
  createMemoryManager,
  createSQLiteAdapter,
} from '../../dist/index.js';
import { assertScenario, average, ratio, tagEvalOutput, withFrozenNow } from './shared.mjs';

/**
 * Long-horizon metrics — de-fitted from 2-3 examples to >=20 materially-distinct
 * cases each (manager decision D4):
 *   - strategyOutcomeRecallRate: 20 distinct (successful strategy, failed
 *     strategy) pairs; per case the success must reverify to trusted+strategy
 *     and the failure must land as anti_pattern (not dominate recall).
 *   - memoryIsolationAccuracy: 20 distinct sibling-scope cases; a private secret
 *     must NOT leak into the default context, while a workspace-published fact
 *     MUST surface via explicit workspace-level cross-scope search.
 *   - postMaintenanceFidelityScore: 20 distinct maintenance cases; a critical
 *     constraint survives, a stale project fact is demoted, a weak provisional
 *     fact expires.
 */

const STRATEGY_CASES = [
  { good: 'Use smaller batches for migrations.', bad: 'Use aggressive caching during deploys.' },
  { good: 'Roll out behind feature flags.', bad: 'Deploy directly to all users at once.' },
  { good: 'Add retries with exponential backoff.', bad: 'Retry immediately without any backoff.' },
  { good: 'Cache read-heavy queries.', bad: 'Disable the query cache entirely.' },
  { good: 'Shard the write-heavy table.', bad: 'Keep all writes on a single node.' },
  { good: 'Use connection pooling.', bad: 'Open a new connection per request.' },
  { good: 'Precompute expensive aggregates.', bad: 'Recompute aggregates on every read.' },
  { good: 'Debounce noisy webhooks.', bad: 'Process every webhook synchronously.' },
  { good: 'Paginate large result sets.', bad: 'Return the full result set at once.' },
  { good: 'Compress payloads over the wire.', bad: 'Send uncompressed payloads everywhere.' },
  { good: 'Warm caches before peak traffic.', bad: 'Cold-start caches during peak traffic.' },
  { good: 'Index the frequent filter columns.', bad: 'Run full table scans on every filter.' },
  { good: 'Batch outbound notifications.', bad: 'Send one request per notification.' },
  { good: 'Use idempotency keys for payments.', bad: 'Allow duplicate payment submissions.' },
  { good: 'Stream large exports to disk.', bad: 'Buffer entire exports in memory.' },
  { good: 'Rate-limit the scraping endpoints.', bad: 'Leave scraping endpoints unlimited.' },
  { good: 'Queue background jobs.', bad: 'Run background jobs inline with requests.' },
  { good: 'Memoize pure computations.', bad: 'Recompute pure results repeatedly.' },
  { good: 'Prefetch the next page of data.', bad: 'Fetch each page only on demand under load.' },
  { good: 'Use bulk inserts for imports.', bad: 'Insert import rows one at a time.' },
];

const ISOLATION_CASES = [
  { topic: 'staging deploy', secret: 'the staging root token is ST-9f2a', secretNeedle: 'ST-9f2a', shared: 'staging deploys follow the shared checklist', sharedNeedle: 'shared checklist' },
  { topic: 'billing export', secret: 'the billing export uses key BX-7731', secretNeedle: 'BX-7731', shared: 'billing exports run every Monday morning', sharedNeedle: 'every Monday morning' },
  { topic: 'search index', secret: 'the search index admin pin is 4410', secretNeedle: '4410', shared: 'search index rebuilds are logged to the audit channel', sharedNeedle: 'audit channel' },
  { topic: 'auth service', secret: 'the auth service signing secret is AS-x22', secretNeedle: 'AS-x22', shared: 'auth service tokens expire after one hour', sharedNeedle: 'expire after one hour' },
  { topic: 'data warehouse', secret: 'the warehouse loader password is DW-plum', secretNeedle: 'DW-plum', shared: 'warehouse loads pause during business hours', sharedNeedle: 'pause during business hours' },
  { topic: 'cache cluster', secret: 'the cache cluster access code is CC-1900', secretNeedle: 'CC-1900', shared: 'cache cluster evictions use an LRU policy', sharedNeedle: 'LRU policy' },
  { topic: 'payment gateway', secret: 'the payment gateway merchant key is PG-zeta', secretNeedle: 'PG-zeta', shared: 'payment gateway retries cap at three attempts', sharedNeedle: 'three attempts' },
  { topic: 'email relay', secret: 'the email relay smtp password is ER-8080', secretNeedle: 'ER-8080', shared: 'email relay batches sends in five-minute windows', sharedNeedle: 'five-minute windows' },
  { topic: 'cdn edge', secret: 'the cdn purge token is CD-orchid', secretNeedle: 'CD-orchid', shared: 'cdn edge caches assets for one day', sharedNeedle: 'one day' },
  { topic: 'metrics pipeline', secret: 'the metrics pipeline api key is MP-3345', secretNeedle: 'MP-3345', shared: 'metrics pipeline rolls up hourly', sharedNeedle: 'rolls up hourly' },
  { topic: 'feature store', secret: 'the feature store service token is FS-quartz', secretNeedle: 'FS-quartz', shared: 'feature store snapshots are versioned', sharedNeedle: 'snapshots are versioned' },
  { topic: 'log archive', secret: 'the log archive bucket key is LA-6612', secretNeedle: 'LA-6612', shared: 'log archives are retained for ninety days', sharedNeedle: 'ninety days' },
  { topic: 'mobile release', secret: 'the mobile signing keystore pass is MR-cobalt', secretNeedle: 'MR-cobalt', shared: 'mobile releases ship on a two-week cadence', sharedNeedle: 'two-week cadence' },
  { topic: 'admin console', secret: 'the admin console break-glass code is AC-5150', secretNeedle: 'AC-5150', shared: 'admin console actions require a second approver', sharedNeedle: 'second approver' },
  { topic: 'backup vault', secret: 'the backup vault unseal key is BV-amber', secretNeedle: 'BV-amber', shared: 'backup vault restores are tested each quarter', sharedNeedle: 'tested each quarter' },
  { topic: 'analytics job', secret: 'the analytics job db password is AJ-7788', secretNeedle: 'AJ-7788', shared: 'analytics jobs run after midnight UTC', sharedNeedle: 'after midnight UTC' },
  { topic: 'webhook dispatcher', secret: 'the webhook dispatcher hmac secret is WD-slate', secretNeedle: 'WD-slate', shared: 'webhook dispatch signs every payload', sharedNeedle: 'signs every payload' },
  { topic: 'image resizer', secret: 'the image resizer worker token is IR-2020', secretNeedle: 'IR-2020', shared: 'image resizer caps uploads at ten megabytes', sharedNeedle: 'ten megabytes' },
  { topic: 'notification hub', secret: 'the notification hub push cert pass is NH-teal', secretNeedle: 'NH-teal', shared: 'notification hub dedupes within one minute', sharedNeedle: 'within one minute' },
  { topic: 'report builder', secret: 'the report builder export secret is RB-9001', secretNeedle: 'RB-9001', shared: 'report builder outputs are paginated', sharedNeedle: 'outputs are paginated' },
];

const MAINTENANCE_CASES = [
  { constraint: 'stay local-first', needle: 'local-first', project: 'The deploy target is us-east staging.', provisional: 'Temporary note about a short-lived feature branch.' },
  { constraint: 'encrypt everything at rest', needle: 'encrypt everything at rest', project: 'The primary region is eu-west.', provisional: 'Scratch note about a demo dataset.' },
  { constraint: 'require MFA for admins', needle: 'require MFA for admins', project: 'The billing cycle starts on the first.', provisional: 'Draft idea for a maybe-later refactor.' },
  { constraint: 'never expose internal errors', needle: 'never expose internal errors', project: 'The support queue uses Zendesk.', provisional: 'Quick reminder about a flaky test.' },
  { constraint: 'keep audit logs immutable', needle: 'keep audit logs immutable', project: 'The mobile team owns onboarding.', provisional: 'Loose thought on a spike experiment.' },
  { constraint: 'validate all webhooks', needle: 'validate all webhooks', project: 'The default currency is USD.', provisional: 'Temporary flag for a canary rollout.' },
  { constraint: 'pin container base images', needle: 'pin container base images', project: 'The analytics owner is the data team.', provisional: 'Note about a one-off migration.' },
  { constraint: 'rotate keys every quarter', needle: 'rotate keys every quarter', project: 'The staging domain is stg.example.com.', provisional: 'Placeholder for an unproven idea.' },
  { constraint: 'enforce least privilege', needle: 'enforce least privilege', project: 'The CI runner pool has eight nodes.', provisional: 'Short-lived debugging breadcrumb.' },
  { constraint: 'back up before every migration', needle: 'back up before every migration', project: 'The docs site is on Netlify.', provisional: 'Temporary hypothesis about latency.' },
  { constraint: 'sign all release artifacts', needle: 'sign all release artifacts', project: 'The default locale is en-US.', provisional: 'Scratch plan for a throwaway prototype.' },
  { constraint: 'sandbox third-party code', needle: 'sandbox third-party code', project: 'The status page is hosted externally.', provisional: 'Note for a soon-to-be-removed shim.' },
  { constraint: 'deny by default on auth', needle: 'deny by default on auth', project: 'The primary datastore is Postgres.', provisional: 'Temporary marker for a feature toggle.' },
  { constraint: 'checksum every artifact', needle: 'checksum every artifact', project: 'The email sender is no-reply.', provisional: 'Loose note about a stale branch.' },
  { constraint: 'quarantine untrusted uploads', needle: 'quarantine untrusted uploads', project: 'The queue backend is Redis.', provisional: 'Placeholder for an experimental knob.' },
  { constraint: 'log every privilege change', needle: 'log every privilege change', project: 'The search backend is OpenSearch.', provisional: 'Temporary note about a demo tenant.' },
  { constraint: 'expire stale sessions', needle: 'expire stale sessions', project: 'The metrics store is Prometheus.', provisional: 'Draft thought on a maybe feature.' },
  { constraint: 'isolate customer data', needle: 'isolate customer data', project: 'The alerting tool is PagerDuty.', provisional: 'Short-lived reminder about a hotfix.' },
  { constraint: 'verify supply chain hashes', needle: 'verify supply chain hashes', project: 'The CDN provider is Fastly.', provisional: 'Placeholder for an unreviewed spike.' },
  { constraint: 'redact secrets in logs', needle: 'redact secrets in logs', project: 'The feature flag service is LaunchDarkly.', provisional: 'Temporary note about a throwaway test.' },
];

// ---------- strategyOutcomeRecallRate ----------
async function evalStrategyRecall() {
  const adapter = createSQLiteAdapter(':memory:');
  const scope = { tenant_id: 'eval', system_id: 'memory-quality', workspace_id: 'long-horizon', scope_id: 'strategy' };
  const manager = createMemoryManager({
    adapter,
    scope,
    sessionId: 'strategy-eval',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
  });
  try {
    const perCase = [];
    for (let i = 0; i < STRATEGY_CASES.length; i += 1) {
      const c = STRATEGY_CASES[i];
      const good = await adapter.insertKnowledgeMemory({
        ...scope, fact: c.good, fact_type: 'decision', knowledge_state: 'provisional',
        knowledge_class: 'procedure', source: 'manual', confidence: 'high', grounding_strength: 'strong',
        evidence_count: 2, trust_score: 0.7, source_turn_ids: [],
      });
      adapter.insertKnowledgeEvidenceBatch([
        { ...scope, knowledge_memory_id: good.id, source_type: 'execution_result', support_polarity: 'supports', excerpt: c.good, is_explicit: true, explicitness_score: 1, outcome: 'success' },
        { ...scope, knowledge_memory_id: good.id, source_type: 'human_feedback', support_polarity: 'supports', excerpt: 'This worked repeatedly.', is_explicit: true, explicitness_score: 1, outcome: 'success' },
      ]);
      const bad = await adapter.insertKnowledgeMemory({
        ...scope, fact: c.bad, fact_type: 'decision', knowledge_state: 'provisional',
        knowledge_class: 'procedure', source: 'manual', confidence: 'medium', grounding_strength: 'moderate',
        evidence_count: 1, trust_score: 0.55, source_turn_ids: [],
      });
      adapter.insertKnowledgeEvidence({
        ...scope, knowledge_memory_id: bad.id, source_type: 'execution_result', support_polarity: 'supports',
        excerpt: `${c.bad} caused an incident.`, is_explicit: true, explicitness_score: 1, outcome: 'failure',
      });
      await manager.reverifyKnowledge(good.id);
      await manager.reverifyKnowledge(bad.id);
      const goodRow = adapter.getKnowledgeMemoryById(good.id);
      const badRow = adapter.getKnowledgeMemoryById(bad.id);
      const successRecalled = goodRow?.knowledge_state === 'trusted' && goodRow?.knowledge_class === 'strategy';
      const failedDominates = badRow?.knowledge_class !== 'anti_pattern';
      perCase.push(average([Number(successRecalled), Number(!failedDominates)]));
    }
    return average(perCase);
  } finally {
    await manager.close();
    adapter.close();
  }
}

// ---------- memoryIsolationAccuracy ----------
async function evalMemoryIsolation() {
  const adapter = createSQLiteAdapter(':memory:');
  const managers = [];
  try {
    const perCase = [];
    const leaks = [];
    for (let i = 0; i < ISOLATION_CASES.length; i += 1) {
      const c = ISOLATION_CASES[i];
      const workspace = `iso-ws-${i}`;
      const base = { tenant_id: 'eval', system_id: 'memory-quality', workspace_id: workspace };
      const local = createMemoryManager({
        adapter, scope: { ...base, scope_id: 'task-a' }, sessionId: `task-a-${i}`,
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
        autoCompact: false, autoExtract: false, crossScopeLevel: 'workspace',
      });
      const sibling = createMemoryManager({
        adapter, scope: { ...base, scope_id: 'task-b' }, sessionId: `task-b-${i}`,
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
        autoCompact: false, autoExtract: false,
      });
      managers.push(local, sibling);

      await sibling.learnFact(`Task B secret: ${c.secret}.`, 'reference', 'high');
      await sibling.learnFact(`Task B runbook: ${c.shared}.`, 'reference', 'high', undefined, { visibilityClass: 'workspace' });

      const defaultContext = await local.getContext(c.topic);
      const leaked = defaultContext.relevantKnowledge.some((item) => item.fact.includes(c.secretNeedle));

      const workspaceResults = await local.searchCrossScope(c.topic, 'workspace');
      const facts = workspaceResults.knowledge.map((entry) => entry.item.fact);
      const inherited = facts.some((f) => f.includes(c.sharedNeedle)) && !facts.some((f) => f.includes(c.secretNeedle));

      if (leaked) leaks.push(c.topic);
      perCase.push(average([Number(!leaked), Number(inherited)]));
    }
    return { score: average(perCase), leaks };
  } finally {
    await Promise.all(managers.map((m) => m.close?.() ?? Promise.resolve()));
    adapter.close();
  }
}

// ---------- postMaintenanceFidelityScore ----------
async function evalMaintenanceFidelity() {
  const perCase = [];
  for (let i = 0; i < MAINTENANCE_CASES.length; i += 1) {
    const c = MAINTENANCE_CASES[i];
    const adapter = createInMemoryAdapter();
    const scope = { tenant_id: 'eval', system_id: 'memory-quality', workspace_id: 'maintenance', scope_id: `thread-${i}` };
    const memory = createMemoryManager({
      adapter, scope, sessionId: `maintenance-${i}`,
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      autoCompact: false, autoExtract: false,
    });
    try {
      const { staleProjectFact, provisionalFact } = await withFrozenNow('2024-01-01T00:00:00Z', async () => {
        await memory.learnFact(`Critical constraint: ${c.constraint}.`, 'constraint', 'high');
        const project = adapter.insertKnowledgeMemory({
          ...scope, fact: c.project, fact_type: 'reference', knowledge_state: 'trusted',
          knowledge_class: 'project_fact', source: 'manual', confidence: 'high', trust_score: 0.85,
          verification_status: 'verified', last_verified_at: Math.floor(Date.now() / 1000),
        });
        adapter.insertKnowledgeEvidence({
          ...scope, knowledge_memory_id: project.id, source_type: 'user_turn', support_polarity: 'supports',
          excerpt: c.project, is_explicit: true, explicitness_score: 1,
        });
        const prov = adapter.insertKnowledgeMemory({
          ...scope, fact: c.provisional, fact_type: 'reference', knowledge_state: 'provisional',
          knowledge_class: 'episodic_fact', source: 'manual', confidence: 'medium', trust_score: 0.45,
        });
        return { staleProjectFact: project, provisionalFact: prov };
      });

      await withFrozenNow('2024-02-20T00:00:00Z', async () =>
        memory.runMaintenance({
          workingMemoryTtlSeconds: 1,
          completedWorkItemTtlSeconds: 1,
          knowledgeStaleAfterSeconds: 60 * 60 * 24 * 30,
          minKnowledgeAccessCount: 1,
          maxActiveKnowledgeItems: 50,
        }),
      );

      const context = await memory.getContext(c.needle);
      const criticalSurvived = context.relevantKnowledge.some((item) => item.fact.toLowerCase().includes(c.needle.toLowerCase()));
      const staleDemoted = adapter.getKnowledgeMemoryById(staleProjectFact.id)?.knowledge_state === 'provisional';
      const provisionalExpired = adapter.getKnowledgeMemoryById(provisionalFact.id)?.retired_at != null;
      perCase.push(average([Number(criticalSurvived), Number(staleDemoted), Number(provisionalExpired)]));
    } finally {
      await memory.close();
      adapter.close();
    }
  }
  return average(perCase);
}

export async function runLongHorizonEvals(_options = {}) {
  const strategyOutcomeRecallRate = await evalStrategyRecall();
  const isolation = await evalMemoryIsolation();
  const postMaintenanceFidelityScore = await evalMaintenanceFidelity();

  const metrics = {
    strategyOutcomeRecallRate,
    memoryIsolationAccuracy: isolation.score,
    postMaintenanceFidelityScore,
  };

  return tagEvalOutput('long-horizon', {
    metrics,
    scenarios: [
      assertScenario('successful_strategies_recalled_failures_demoted', strategyOutcomeRecallRate >= 0.85, {
        cases: STRATEGY_CASES.length,
        score: strategyOutcomeRecallRate,
      }),
      assertScenario('sibling_secrets_isolated_shared_facts_inherited', isolation.score >= 0.95, {
        cases: ISOLATION_CASES.length,
        leaks: isolation.leaks,
      }),
      assertScenario('maintenance_preserves_constraints_demotes_stale', postMaintenanceFidelityScore >= 0.86, {
        cases: MAINTENANCE_CASES.length,
        score: postMaintenanceFidelityScore,
      }),
    ],
    diagnostic: {
      metricTraces: {
        strategyOutcomeRecallRate: { stage: 'strategy_reverification', cases: STRATEGY_CASES.length },
        memoryIsolationAccuracy: { stage: 'cross_scope_context', cases: ISOLATION_CASES.length, leaks: isolation.leaks },
        postMaintenanceFidelityScore: { stage: 'maintenance_lifecycle', cases: MAINTENANCE_CASES.length },
      },
    },
  });
}
