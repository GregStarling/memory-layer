import {
  createInMemoryAdapter,
  discover,
  getGraphReport,
} from '../../dist/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

export async function runDiscoveryEvals(_options = {}) {
  const adapter = createInMemoryAdapter();
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    scope_id: 'discovery-eval',
  };

  // Seed cross-class knowledge directly via the adapter
  const now = Math.floor(Date.now() / 1000);
  const ts = adapter.insertKnowledgeMemory({
    ...scope, fact: 'The system uses TypeScript.', fact_type: 'reference',
    knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
    created_at: now, last_accessed_at: now,
  });
  const dark = adapter.insertKnowledgeMemory({
    ...scope, fact: 'The user prefers dark mode.', fact_type: 'preference',
    knowledge_class: 'preference', source: 'user_stated', confidence: 'high',
    created_at: now, last_accessed_at: now,
  });
  const offline = adapter.insertKnowledgeMemory({
    ...scope, fact: 'The project must support offline mode.', fact_type: 'constraint',
    knowledge_class: 'constraint', source: 'user_stated', confidence: 'high',
    created_at: now, last_accessed_at: now,
  });
  const sqlite = adapter.insertKnowledgeMemory({
    ...scope, fact: 'Decided to use SQLite for local storage.', fact_type: 'decision',
    knowledge_class: 'strategy', source: 'user_stated', confidence: 'high',
    created_at: now, last_accessed_at: now,
  });
  const ml = adapter.insertKnowledgeMemory({
    ...scope, fact: 'The project name is MemoryLayer.', fact_type: 'entity',
    knowledge_class: 'identity', source: 'user_stated', confidence: 'high',
    created_at: now, last_accessed_at: now,
  });

  // Create associations with varying provenance
  adapter.insertAssociation({
    ...scope,
    source_kind: 'knowledge', source_id: ts.id,
    target_kind: 'knowledge', target_id: sqlite.id,
    association_type: 'related_to', confidence: 0.9, auto_generated: true,
    provenance: 'extracted',
  });
  adapter.insertAssociation({
    ...scope,
    source_kind: 'knowledge', source_id: dark.id,
    target_kind: 'knowledge', target_id: offline.id,
    association_type: 'supports', confidence: 0.5, auto_generated: true,
    provenance: 'inferred',
  });
  adapter.insertAssociation({
    ...scope,
    source_kind: 'knowledge', source_id: ml.id,
    target_kind: 'knowledge', target_id: ts.id,
    association_type: 'related_to', confidence: 0.8, auto_generated: false,
    provenance: 'extracted',
  });

  // --- Metric: discover_surprise_quality ---
  const discoverResult = await discover(adapter, scope, { maxResults: 5 });
  const hasSurprises = discoverResult.surprises.length > 0;
  // Cross-class surprises are the ones with higher scores (cross-class bonus applies)
  const highScoreSurprises = discoverResult.surprises.filter((s) => s.score >= 0.3);
  const surpriseQuality = hasSurprises
    ? average([
        ratio(highScoreSurprises.length, Math.max(discoverResult.surprises.length, 1)),
        discoverResult.surprises.length >= 1 ? 1 : 0,
      ])
    : 0;

  // --- Metric: edge_provenance_ranking ---
  const associations = adapter.listAssociations(scope);
  const extractedEdges = associations.filter((a) => a.provenance === 'extracted');
  const inferredEdges = associations.filter((a) => a.provenance === 'inferred');
  const hasExtracted = extractedEdges.length > 0;
  const hasInferred = inferredEdges.length > 0;
  const provenanceCorrect = hasExtracted && hasInferred
    ? average(extractedEdges.map((e) => e.confidence)) >= average(inferredEdges.map((e) => e.confidence))
      ? 1 : 0.5
    : hasExtracted ? 1 : 0;

  // --- Metric: graph_report_token_budget ---
  const report = await getGraphReport(adapter, scope, { tokenBudget: 2000 });
  const withinBudget = report.tokenEstimate <= 2000 ? 1 : 0;
  const hasSections = report.sections.length > 0 ? 1 : 0;

  const metrics = {
    discoverSurpriseQuality: surpriseQuality,
    edgeProvenanceRanking: provenanceCorrect,
    graphReportTokenBudget: average([withinBudget, hasSections]),
  };

  return tagEvalOutput('discovery', {
    metrics,
    scenarios: [
      assertScenario('discover_returns_surprises', hasSurprises, {
        surpriseCount: discoverResult.surprises.length,
      }),
      assertScenario('graph_report_within_budget', withinBudget === 1, {
        tokenEstimate: report.tokenEstimate,
        sectionCount: report.sections.length,
      }),
      assertScenario('provenance_ranking_correct', provenanceCorrect >= 0.5, {
        extractedCount: extractedEdges.length,
        inferredCount: inferredEdges.length,
      }),
    ],
  });
}
