export const THRESHOLDS = {
  constraintRetentionRate: 0.92,
  preferenceRetentionRate: 0.9,
  identityRetentionRate: 0.95,
  procedureRetentionRate: 0.88,
  updateCorrectnessRate: 0.88,
  strategyOutcomeRecallRate: 0.85,
  falseMemoryRate: 0.05,
  contradictionResolutionAccuracy: 0.85,
  trustedMemoryPrecision: 0.9,
  trustedMemoryRecall: 0.88,
  memoryIsolationAccuracy: 0.95,
  provisionalLeakRate: 0.08,
  postCompactionFidelityScore: 0.88,
  postMaintenanceFidelityScore: 0.86,
  episodicRetrievalPrecision: 0.85,
  episodicRecapCompleteness: 0.9,
  reflectSourceAttribution: 0.9,
  episodicIsolation: 0.95,
  profileCompleteness: 0.9,
  profileTrustFiltering: 0.9,
  profileProvenance: 0.9,
  playbookCreationQuality: 0.85,
  playbookRetrievalRelevance: 0.85,
  playbookRevisionContinuity: 0.85,
  associationAutoDetection: 0.85,
  associationTraversalBounds: 0.9,
  associationRetrievalBoost: 0.85,
  snapshotStability: 0.95,
  snapshotLiveWrites: 0.95,
  snapshotRefresh: 0.9,
  // Phase 5: Discovery
  discoverSurpriseQuality: 0.5,
  edgeProvenanceRanking: 0.8,
  graphReportTokenBudget: 0.9,
  // Phase 5: Temporal
  temporalExtractionAccuracy: 0.8,
  factsAtFastPath: 0.85,
  timeFormattingQuality: 0.85,
  // Phase 5: Reflection
  rationaleExtractionAccuracy: 0.8,
  reflectionPatternQuality: 0.8,
  derivedOutputAccuracy: 0.8,
  curationCompleteness: 0.8,
  // Phase 5: Intelligence
  coreMemoryTokenBudget: 0.9,
  tagFilteringAccuracy: 0.85,
  aliasResolutionQuality: 0.5,
  clusterCoherence: 0.5,
};

export function assertScenario(name, passed, detail = {}) {
  return { name, passed, detail };
}

export function ratio(numerator, denominator) {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function evaluateThreshold(metricName, actual) {
  const threshold = THRESHOLDS[metricName];
  const lowerIsBetter = metricName === 'falseMemoryRate' || metricName === 'provisionalLeakRate';
  const passed = lowerIsBetter ? actual <= threshold : actual >= threshold;
  const normalized = lowerIsBetter
    ? actual <= threshold
      ? 1
      : clamp(threshold / Math.max(actual, Number.EPSILON))
    : clamp(actual / threshold);
  return {
    metric: metricName,
    threshold,
    actual,
    passed,
    normalized,
  };
}

export function summarizeMetrics(metrics) {
  const evaluations = Object.keys(THRESHOLDS).map((metricName) =>
    evaluateThreshold(metricName, metrics[metricName] ?? 0),
  );
  const overallScore = Math.round(average(evaluations.map((entry) => entry.normalized)) * 10000) / 100;
  return {
    overallScore,
    passed: evaluations.every((entry) => entry.passed),
    evaluations,
  };
}

export function mergeScenarioOutputs(outputs) {
  const metrics = outputs.reduce(
    (accumulator, output) => ({ ...accumulator, ...output.metrics }),
    baselineMetrics(),
  );
  const scenarios = outputs.flatMap((output) => output.scenarios);
  const summary = summarizeMetrics(metrics);
  return {
    overallScore: summary.overallScore,
    passed: summary.passed,
    metrics,
    evaluations: summary.evaluations,
    scenarios,
  };
}

export function tagEvalOutput(source, output) {
  return {
    source,
    ...output,
  };
}

export function buildDiagnosticReport({ outputs, engineResult, baseline, platformQuality }) {
  const metricSources = new Map();
  const scenarioSources = new Map();

  for (const output of outputs) {
    for (const metricName of Object.keys(output.metrics ?? {})) {
      metricSources.set(metricName, output.source);
    }
    for (const scenario of output.scenarios ?? []) {
      scenarioSources.set(scenario.name, output.source);
    }
  }

  const baselineDeltas = Object.keys(THRESHOLDS).map((metric) => ({
    metric,
    baseline: baseline.metrics?.[metric] ?? null,
    current: engineResult.metrics?.[metric] ?? null,
    delta:
      baseline.metrics?.[metric] != null && engineResult.metrics?.[metric] != null
        ? engineResult.metrics[metric] - baseline.metrics[metric]
        : null,
  }));

  const metricFailures = engineResult.evaluations
    .filter((evaluation) => !evaluation.passed)
    .map((evaluation) => {
      const source = metricSources.get(evaluation.metric) ?? 'unknown';
      const output = outputs.find((candidate) => candidate.source === source);
      return {
        kind: 'metric',
        source,
        metric: evaluation.metric,
        threshold: evaluation.threshold,
        actual: evaluation.actual,
        trace: output?.diagnostic?.metricTraces?.[evaluation.metric] ?? null,
      };
    });

  const scenarioFailures = engineResult.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => {
      const source = scenarioSources.get(scenario.name) ?? 'unknown';
      const output = outputs.find((candidate) => candidate.source === source);
      return {
        kind: 'scenario',
        source,
        scenario: scenario.name,
        detail: scenario.detail,
        trace: output?.diagnostic?.scenarioTraces?.[scenario.name] ?? null,
      };
    });

  const platformFailures = (platformQuality?.checks ?? [])
    .filter((check) => !check.passed)
    .map((check) => ({
      kind: 'platform',
      check: check.name,
      detail: check.detail,
    }));

  return {
    currentTruth: {
      enginePassed: engineResult.passed,
      engineOverallScore: engineResult.overallScore,
      platformPassed: platformQuality?.passed ?? null,
    },
    baseline: {
      overallScore: baseline.overallScore,
      passed: baseline.passed,
      metricDeltas: baselineDeltas,
    },
    moduleOutputs: outputs.map((output) => ({
      source: output.source,
      metrics: output.metrics,
      scenarios: output.scenarios,
      diagnostic: output.diagnostic ?? null,
    })),
    failureMap: {
      metricFailures,
      scenarioFailures,
      platformFailures,
    },
  };
}

export async function withFrozenNow(isoTimestamp, fn) {
  const realNow = Date.now;
  Date.now = () => new Date(isoTimestamp).valueOf();
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

export function baselineMetrics() {
  return {
    constraintRetentionRate: 0,
    preferenceRetentionRate: 0,
    identityRetentionRate: 0,
    procedureRetentionRate: 0,
    updateCorrectnessRate: 0,
    strategyOutcomeRecallRate: 0,
    falseMemoryRate: 1,
    contradictionResolutionAccuracy: 0,
    trustedMemoryPrecision: 0,
    trustedMemoryRecall: 0,
    memoryIsolationAccuracy: 0,
    provisionalLeakRate: 1,
    postCompactionFidelityScore: 0,
    postMaintenanceFidelityScore: 0,
    episodicRetrievalPrecision: 0,
    episodicRecapCompleteness: 0,
    reflectSourceAttribution: 0,
    episodicIsolation: 0,
    profileCompleteness: 0,
    profileTrustFiltering: 0,
    profileProvenance: 0,
    playbookCreationQuality: 0,
    playbookRetrievalRelevance: 0,
    playbookRevisionContinuity: 0,
    associationAutoDetection: 0,
    associationTraversalBounds: 0,
    associationRetrievalBoost: 0,
    snapshotStability: 0,
    snapshotLiveWrites: 0,
    snapshotRefresh: 0,
    discoverSurpriseQuality: 0,
    edgeProvenanceRanking: 0,
    graphReportTokenBudget: 0,
    temporalExtractionAccuracy: 0,
    factsAtFastPath: 0,
    timeFormattingQuality: 0,
    rationaleExtractionAccuracy: 0,
    reflectionPatternQuality: 0,
    derivedOutputAccuracy: 0,
    curationCompleteness: 0,
    coreMemoryTokenBudget: 0,
    tagFilteringAccuracy: 0,
    aliasResolutionQuality: 0,
    clusterCoherence: 0,
  };
}
