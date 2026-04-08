import {
  extractRationale,
  createInMemoryAdapter,
  derive,
  getCurationSummary,
} from '../../dist/index.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

export async function runReflectionEvals(_options = {}) {
  // --- Metric: rationale_extraction_accuracy ---
  const rationaleCases = [
    // Positive cases: should extract rationale
    {
      text: 'We use TypeScript because it provides type safety and catches errors at compile time',
      expectRationale: true,
    },
    {
      text: 'The cache layer was added in order to reduce database load during peak hours',
      expectRationale: true,
    },
    {
      text: 'We chose SQLite. The reason is that it requires no separate server process',
      expectRationale: true,
    },
    {
      text: 'This ensures that all data is validated before reaching the database layer',
      expectRationale: true,
    },
    {
      text: 'We disabled the old API endpoint so that clients would migrate to the new version',
      expectRationale: true,
    },
    {
      text: 'Rate limiting was added to prevent abuse from automated clients making excessive requests',
      expectRationale: true,
    },
    {
      text: 'The migration was delayed due to incompatibility with the new authentication provider',
      expectRationale: true,
    },
    // Negative cases: should NOT extract rationale (too short/vague)
    {
      text: 'The system uses TypeScript.',
      expectRationale: false,
    },
    {
      text: 'Dark mode is the default.',
      expectRationale: false,
    },
    {
      text: 'The project started in 2024.',
      expectRationale: false,
    },
    {
      text: 'Because yes',
      expectRationale: false,
    },
  ];

  let rationaleCorrect = 0;
  const rationaleDetails = [];
  for (const rc of rationaleCases) {
    const result = extractRationale(rc.text);
    const correct = rc.expectRationale ? result != null : result == null;
    if (correct) rationaleCorrect++;
    rationaleDetails.push({
      text: rc.text,
      expected: rc.expectRationale ? 'rationale' : 'null',
      got: result,
      correct,
    });
  }
  const rationaleExtractionAccuracy = ratio(rationaleCorrect, rationaleCases.length);

  // --- Metric: reflection_pattern_quality ---
  const meaningfulRationales = rationaleCases
    .filter((rc) => rc.expectRationale)
    .map((rc) => {
      const result = extractRationale(rc.text);
      if (!result) return 0;
      const words = result.split(/\s+/).filter((w) => w.length > 0).length;
      return words >= 4 && result.length >= 10 ? 1 : 0;
    });
  const reflectionPatternQuality = average(meaningfulRationales);

  // --- Metric: derived_output_accuracy ---
  // Exercise the derive() module with real knowledge
  const adapter = createInMemoryAdapter();
  const scope = { tenant_id: 'eval', system_id: 'reflection', scope_id: 'derive-eval' };
  const now = Math.floor(Date.now() / 1000);

  // Create constraint knowledge for coding rule derivation
  for (let i = 0; i < 3; i++) {
    adapter.insertKnowledgeMemory({
      ...scope, fact: `All API endpoints must validate input schema ${i}`,
      fact_type: 'constraint', knowledge_class: 'constraint',
      source: 'user_stated', confidence: 'high', trust_score: 0.9,
      evidence_count: 3, fact_subject: 'api-validation',
      created_at: now, last_accessed_at: now,
    });
  }
  // Create negated constraint for anti-pattern
  adapter.insertKnowledgeMemory({
    ...scope, fact: 'Never store passwords in plaintext',
    fact_type: 'constraint', knowledge_class: 'constraint',
    source: 'user_stated', confidence: 'high', is_negated: true,
    created_at: now, last_accessed_at: now,
  });

  const activeKnowledge = adapter.getActiveKnowledgeMemory(scope);
  const mockReflection = {
    sessionsAnalyzed: 1,
    newFacts: [],
    patternsFound: [{
      name: 'input validation',
      description: 'Repeated input validation pattern',
      occurrences: 4,
      relatedFactIndices: [],
    }],
    sourceMemoryIds: activeKnowledge.map((k) => k.id),
    aliasCandidates: [],
  };

  const derivedOutputs = derive(mockReflection, activeKnowledge);
  const hasOutputs = derivedOutputs.length > 0;
  const allHaveProvenance = derivedOutputs.every((o) => o.sourceKnowledgeIds.length > 0);
  const allHaveRationale = derivedOutputs.every((o) => o.rationale && o.rationale.length > 0);
  const derivedAccuracy = average([
    hasOutputs ? 1 : 0,
    allHaveProvenance ? 1 : 0,
    allHaveRationale ? 1 : 0,
  ]);

  // --- Metric: curation_completeness ---
  // Exercise getCurationSummary with real maintenance and derived data
  const maintenanceReport = {
    expiredWorkingMemoryIds: [1, 2],
    retiredKnowledgeIds: [10],
    deletedWorkItemIds: [],
    deletedAssociationIds: [5],
    reverifiedKnowledgeIds: [20, 21],
    expiredCandidateIds: [],
    demotedKnowledgeIds: [30],
  };

  const curation = getCurationSummary({
    maintenance: maintenanceReport,
    maintenanceTimestamp: now,
    derived: derivedOutputs,
    derivedTimestamp: now,
  });

  const hasMaintenanceActions = curation.actions.some((a) => a.source === 'maintenance');
  const hasDerivedActions = curation.actions.some((a) => a.source === 'derived_pipeline');
  const hasReverified = curation.actions.some((a) => a.actionType === 'reverified');
  const curationCompleteness = average([
    hasMaintenanceActions ? 1 : 0,
    hasDerivedActions ? 1 : 0,
    hasReverified ? 1 : 0,
    curation.actions.length > 0 ? 1 : 0,
  ]);

  const metrics = {
    rationaleExtractionAccuracy,
    reflectionPatternQuality,
    derivedOutputAccuracy: derivedAccuracy,
    curationCompleteness,
  };

  return tagEvalOutput('reflection', {
    metrics,
    scenarios: [
      assertScenario('rationale_extraction_accurate', rationaleExtractionAccuracy >= 0.8, {
        correct: rationaleCorrect,
        total: rationaleCases.length,
        details: rationaleDetails,
      }),
      assertScenario('rationale_quality_meaningful', reflectionPatternQuality >= 0.8, {
        qualityScores: meaningfulRationales,
      }),
      assertScenario('derive_produces_outputs_with_provenance', derivedAccuracy >= 0.8, {
        outputCount: derivedOutputs.length,
        hasProvenance: allHaveProvenance,
        hasRationale: allHaveRationale,
      }),
      assertScenario('curation_aggregates_all_sources', curationCompleteness >= 0.75, {
        actionCount: curation.actions.length,
        hasMaintenanceActions,
        hasDerivedActions,
        hasReverified,
      }),
    ],
  });
}
