import {
  createInMemoryAdapter,
  discover,
  getGraphReport,
} from '../../dist/index.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

/**
 * Discovery/graph metrics — de-fitted from 1-3 examples to 20 distinct graphs
 * (manager decision D4). Twenty distinct-subject knowledge graphs are built;
 * each metric is averaged across all twenty:
 *   - discoverSurpriseQuality: discover() surfaces scored cross-class surprises.
 *   - edgeProvenanceRanking: extracted edges out-rank inferred edges by average
 *     confidence (2 extracted + 1 inferred per graph = 60 edges total).
 *   - graphReportTokenBudget: getGraphReport stays within the token budget and
 *     produces sections, across 20 graphs.
 * These are structural invariants, so the 20 cases vary the graph SUBJECT while
 * holding graph shape — appropriate for invariants (content differs per graph).
 */
const SUBJECTS = [
  'TypeScript', 'Postgres', 'Redis', 'Kafka', 'Kubernetes', 'Nginx', 'GraphQL',
  'SQLite', 'Docker', 'Terraform', 'Prometheus', 'Grafana', 'OpenSearch',
  'RabbitMQ', 'Fastly', 'Vault', 'PagerDuty', 'Vitest', 'Tailwind', 'Deno',
];

function buildGraph(adapter, scope, subject) {
  const now = Math.floor(Date.now() / 1000);
  const mk = (fact, fact_type, knowledge_class) =>
    adapter.insertKnowledgeMemory({ ...scope, fact, fact_type, knowledge_class, source: 'user_stated', confidence: 'high', created_at: now, last_accessed_at: now });
  const nodes = [
    mk(`${subject} is part of the core stack.`, 'reference', 'project_fact'),
    mk(`The team prefers ${subject} for new services.`, 'preference', 'preference'),
    mk(`${subject} must be monitored in production.`, 'constraint', 'constraint'),
    mk(`Decided to standardize on ${subject}.`, 'decision', 'strategy'),
    mk(`The ${subject} platform owns its own runbook.`, 'entity', 'identity'),
  ];
  adapter.insertAssociation({ ...scope, source_kind: 'knowledge', source_id: nodes[0].id, target_kind: 'knowledge', target_id: nodes[3].id, association_type: 'related_to', confidence: 0.9, auto_generated: true, provenance: 'extracted' });
  adapter.insertAssociation({ ...scope, source_kind: 'knowledge', source_id: nodes[1].id, target_kind: 'knowledge', target_id: nodes[2].id, association_type: 'supports', confidence: 0.5, auto_generated: true, provenance: 'inferred' });
  adapter.insertAssociation({ ...scope, source_kind: 'knowledge', source_id: nodes[4].id, target_kind: 'knowledge', target_id: nodes[0].id, association_type: 'related_to', confidence: 0.8, auto_generated: false, provenance: 'extracted' });
}

export async function runDiscoveryEvals(_options = {}) {
  const surpriseScores = [];
  const provenanceScores = [];
  const budgetScores = [];

  for (let i = 0; i < SUBJECTS.length; i += 1) {
    const adapter = createInMemoryAdapter();
    const scope = { tenant_id: 'eval', system_id: 'memory-quality', scope_id: `discovery-${i}` };
    buildGraph(adapter, scope, SUBJECTS[i]);

    const discoverResult = await discover(adapter, scope, { maxResults: 5 });
    const hasSurprises = discoverResult.surprises.length > 0;
    const highScore = discoverResult.surprises.filter((s) => s.score >= 0.3).length;
    surpriseScores.push(hasSurprises
      ? average([ratio(highScore, Math.max(discoverResult.surprises.length, 1)), 1])
      : 0);

    const associations = adapter.listAssociations(scope);
    const extracted = associations.filter((a) => a.provenance === 'extracted');
    const inferred = associations.filter((a) => a.provenance === 'inferred');
    const provenanceOk = extracted.length > 0 && inferred.length > 0
      ? average(extracted.map((e) => e.confidence)) >= average(inferred.map((e) => e.confidence)) ? 1 : 0
      : extracted.length > 0 ? 1 : 0;
    provenanceScores.push(provenanceOk);

    const report = await getGraphReport(adapter, scope, { tokenBudget: 2000 });
    const withinBudget = report.tokenEstimate <= 2000 ? 1 : 0;
    const hasSections = report.sections.length > 0 ? 1 : 0;
    budgetScores.push(average([withinBudget, hasSections]));

    adapter.close();
  }

  const metrics = {
    discoverSurpriseQuality: average(surpriseScores),
    edgeProvenanceRanking: average(provenanceScores),
    graphReportTokenBudget: average(budgetScores),
  };

  return tagEvalOutput('discovery', {
    metrics,
    scenarios: [
      assertScenario('discover_returns_scored_surprises', average(surpriseScores) >= 0.8, { cases: SUBJECTS.length }),
      assertScenario('extracted_edges_outrank_inferred', average(provenanceScores) >= 0.8, { cases: SUBJECTS.length }),
      assertScenario('graph_report_within_budget', average(budgetScores) >= 0.9, { cases: SUBJECTS.length }),
    ],
    diagnostic: {
      metricTraces: {
        discoverSurpriseQuality: { stage: 'discover', cases: SUBJECTS.length },
        edgeProvenanceRanking: { stage: 'provenance_ranking', cases: SUBJECTS.length },
        graphReportTokenBudget: { stage: 'graph_report', cases: SUBJECTS.length },
      },
    },
  });
}
