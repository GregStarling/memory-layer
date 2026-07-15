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
  discoverSurpriseQuality: 0.8,
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
  // KNOWN-WEAK. Calibrated from MEASURED current behavior: over the 20-pair
  // alias dataset (intelligence.mjs) the offline Levenshtein matcher resolves
  // exactly the 10 spelling-variant pairs and none of the 10 abbreviation/
  // synonym pairs → a measured natural baseline of 0.5. Threshold fitted at
  // 0.5 × 0.85 = 0.425 (below the weak baseline; gates against regression only).
  aliasResolutionQuality: 0.5 * 0.85, // measured baseline 0.5 × 0.85 = 0.425
  // NOT known-weak: the measured natural baseline is 1.0 (two clean triangles
  // per graph always cluster). 0.85 here is a routine safety margin, not a
  // concession to a weak capability.
  clusterCoherence: 1.0 * 0.85, // measured baseline 1.0 × 0.85 = 0.85
};

// Metrics where a lower value is better (rates of undesirable behavior).
export const LOWER_IS_BETTER = new Set(['falseMemoryRate', 'provisionalLeakRate']);

// Metrics whose threshold is deliberately fitted BELOW the feature's natural,
// measured best-case baseline. These still gate (a regression below the fitted
// floor fails CI), but the report labels them `knownWeak: true` so the aggregate
// is never mistaken for a "the system is perfect" quality grade. The honest
// statement is: this capability is weak today; the gate only prevents it getting
// worse. Never inflate, never hide (manager decision D2/D3).
export const KNOWN_WEAK = {
  aliasResolutionQuality: {
    naturalBaseline: 0.5,
    reason:
      'Offline Levenshtein/substring alias detection resolves only the 10 ' +
      'spelling-variant pairs (PostgreSQL/Postgres, Grafana/Graphana, ...) and ' +
      'none of the 10 abbreviation/synonym pairs (Kubernetes/K8s, Database/DB, ' +
      'JavaScript/JS, ...) in the 20-pair dataset — the length-ratio prefilter and ' +
      'edit-distance threshold drop them. Measured natural baseline 0.5; threshold ' +
      'fitted at 0.5*0.85 = 0.425, below it. Weak, not passing-at-100.',
  },
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

/**
 * Run an array of async case functions and return the pass-rate as a ratio.
 * Used by the de-fitted metrics that grew from 1-3 examples to >=20 distinct
 * cases (manager decision D4). Each case returns a boolean (or 0/1).
 */
export async function rateOverCases(cases, run) {
  let hits = 0;
  const trace = [];
  for (const testCase of cases) {
    const passed = Boolean(await run(testCase));
    if (passed) hits += 1;
    trace.push({ case: testCase.name ?? testCase.label ?? null, passed });
  }
  return { rate: ratio(hits, cases.length), hits, total: cases.length, trace };
}

export function evaluateThreshold(metricName, actual) {
  const threshold = THRESHOLDS[metricName];
  const lowerIsBetter = LOWER_IS_BETTER.has(metricName);
  const passed = lowerIsBetter ? actual <= threshold : actual >= threshold;
  const weak = KNOWN_WEAK[metricName];
  return {
    metric: metricName,
    threshold,
    actual,
    passed,
    direction: lowerIsBetter ? 'lower_is_better' : 'higher_is_better',
    knownWeak: Boolean(weak),
    ...(weak ? { knownWeakReason: weak.reason, naturalBaseline: weak.naturalBaseline } : {}),
  };
}

/**
 * De-fitted summary (manager decision D3): NO min-capped normalized average
 * masquerading as a 0-100 quality grade. Instead we report:
 *   (a) raw actual value per metric,
 *   (b) per-metric pass/fail against an explicit threshold,
 *   (c) passRate = fraction of metrics meeting their threshold.
 * `overallScore` is retained ONLY for back-compat consumers and is defined as
 * passRate*100 — a pass fraction, explicitly NOT a quality grade (see
 * scorePresentation). knownWeak metrics still gate but are labelled weak.
 */
export function summarizeMetrics(metrics) {
  const evaluations = Object.keys(THRESHOLDS).map((metricName) =>
    evaluateThreshold(metricName, metrics[metricName] ?? (LOWER_IS_BETTER.has(metricName) ? 1 : 0)),
  );
  const metricsPassing = evaluations.filter((entry) => entry.passed).length;
  const metricsTotal = evaluations.length;
  const passRate = metricsTotal === 0 ? 0 : metricsPassing / metricsTotal;
  return {
    passRate,
    // Retained field name for back-compat; value is passRate*100, NOT a grade.
    overallScore: Math.round(passRate * 10000) / 100,
    scorePresentation:
      'overallScore = passRate * 100 (fraction of metrics meeting their threshold). This is a pass rate, NOT a 0-100 quality grade.',
    passed: evaluations.every((entry) => entry.passed),
    metricsPassing,
    metricsTotal,
    knownWeakMetrics: evaluations.filter((entry) => entry.knownWeak).map((entry) => entry.metric),
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
    passRate: summary.passRate,
    overallScore: summary.overallScore,
    scorePresentation: summary.scorePresentation,
    passed: summary.passed,
    metricsPassing: summary.metricsPassing,
    metricsTotal: summary.metricsTotal,
    knownWeakMetrics: summary.knownWeakMetrics,
    metrics,
    evaluations: summary.evaluations,
    scenarios,
  };
}

// ---------------------------------------------------------------------------
// Live-provider profile (manager decision D4). By default every suite runs with
// deterministic mocked LLM clients so CI is hermetic and byte-stable. Set
// MEMORY_EVAL_LIVE=1 with OPENAI_API_KEY present (LOCAL ONLY — CI never sets
// this) to swap the mock for the real OpenAI structured-generation client on
// the suites where the LLM output actually matters (episodic recap/reflect).
// ---------------------------------------------------------------------------
export function isLiveProfile() {
  return process.env.MEMORY_EVAL_LIVE === '1' && Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Build a real `{ generate }` structured-generation client backed by OpenAI.
 * Only called when isLiveProfile() is true. Throws a clear error if the SDK is
 * not installed. Returns the mock unchanged when not in the live profile so
 * callers can unconditionally wrap: `resolveEvalClient(createMockClient())`.
 */
export function resolveEvalClient(mockClient, { model = 'gpt-4.1-mini' } = {}) {
  if (!isLiveProfile()) return mockClient;
  return {
    async generate(request) {
      const sdk = await import('openai');
      const OpenAI = sdk.default ?? sdk.OpenAI ?? sdk;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.chat.completions.create({
        model: request.model ?? model,
        max_tokens: request.maxTokens ?? 1024,
        messages: [
          { role: 'system', content: request.systemPrompt ?? '' },
          { role: 'user', content: request.userPrompt ?? request.prompt ?? '' },
        ],
        response_format: { type: 'json_object' },
      });
      return response.choices?.[0]?.message?.content ?? '';
    },
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
        knownWeak: evaluation.knownWeak,
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
      enginePassRate: engineResult.passRate,
      engineMetricsPassing: engineResult.metricsPassing,
      engineMetricsTotal: engineResult.metricsTotal,
      engineOverallScore: engineResult.overallScore,
      scorePresentation: engineResult.scorePresentation,
      knownWeakMetrics: engineResult.knownWeakMetrics ?? [],
      platformPassed: platformQuality?.passed ?? null,
    },
    baseline: {
      passRate: baseline.passRate ?? null,
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
