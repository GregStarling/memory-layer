/**
 * Memory-quality delta gate (manager decision D3).
 *
 * Consumes the DE-FITTED baseline/result shape: per-metric raw actuals, explicit
 * thresholds, and `passRate` (fraction of metrics meeting their threshold).
 * `overallScore` is retained only as passRate*100 — a pass rate, NOT a 0-100
 * quality grade. The gate ratchets against MEASURED baseline behavior:
 *   - fail if passRate drops below the baseline passRate, OR
 *   - fail if ANY metric regresses versus its baseline actual (direction-aware:
 *     lower-is-better metrics regress when they go UP).
 * Metrics may exceed their baseline freely; that is an improvement, not a gate
 * failure. To ratchet the floor up, regenerate baseline.json from a green run.
 */
import baseline from '../evals/memory-quality/baseline.json' with { type: 'json' };
import { THRESHOLDS, LOWER_IS_BETTER } from '../evals/memory-quality/shared.mjs';
import { runMemoryQualityEvals } from '../evals/memory-quality/index.mjs';

const shouldEnforce = process.argv.includes('--enforce');

function formatDelta(delta) {
  const rounded = Math.round(delta * 10000) / 10000;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(4)}`;
}

// Back-compat: derive passRate from overallScore if an older baseline lacks it.
const baselinePassRate =
  typeof baseline.passRate === 'number'
    ? baseline.passRate
    : typeof baseline.overallScore === 'number'
      ? baseline.overallScore / 100
      : null;

const result = await runMemoryQualityEvals();

function meetsThreshold(metric, value) {
  if (value == null) return false;
  const threshold = THRESHOLDS[metric];
  return LOWER_IS_BETTER.has(metric) ? value <= threshold : value >= threshold;
}

const metricDeltas = Object.keys(THRESHOLDS).map((metric) => {
  const base = baseline.metrics?.[metric] ?? null;
  const current = result.metrics?.[metric] ?? null;
  return {
    metric,
    baseline: base,
    current,
    delta: base != null && current != null ? current - base : null,
    threshold: THRESHOLDS[metric],
    direction: LOWER_IS_BETTER.has(metric) ? 'lower_is_better' : 'higher_is_better',
    knownWeak: (baseline.knownWeakMetrics ?? []).includes(metric),
    baselineMeetsThreshold: meetsThreshold(metric, base),
    currentMeetsThreshold: meetsThreshold(metric, current),
  };
});

// A regression: the metric moved in the WRONG direction versus its baseline
// actual (direction-aware). Improvements never fail the gate.
const regressions = metricDeltas
  .filter((entry) => entry.baseline != null && entry.current != null)
  .filter((entry) =>
    LOWER_IS_BETTER.has(entry.metric)
      ? entry.current > entry.baseline
      : entry.current < entry.baseline,
  )
  .map((entry) => ({ metric: entry.metric, baseline: entry.baseline, current: entry.current }));

// A metric that met its threshold at baseline but no longer does (an absolute
// gate crossing — always a failure regardless of the ratchet).
const newlyFailing = metricDeltas
  .filter((entry) => entry.baselineMeetsThreshold && !entry.currentMeetsThreshold)
  .map((entry) => ({
    metric: entry.metric,
    threshold: entry.threshold,
    current: entry.current,
    direction: entry.direction,
  }));

const passRateRegressed = baselinePassRate != null && result.passRate < baselinePassRate;

const summary = {
  baselinePassRate,
  currentPassRate: result.passRate,
  passRateDelta:
    baselinePassRate != null ? Math.round((result.passRate - baselinePassRate) * 10000) / 10000 : null,
  baselineOverallScore: baseline.overallScore,
  currentOverallScore: result.overallScore,
  overallScoreDelta:
    typeof baseline.overallScore === 'number'
      ? Math.round((result.overallScore - baseline.overallScore) * 100) / 100
      : null,
  scorePresentation: result.scorePresentation,
  baselinePassed: baseline.passed,
  currentPassed: result.passed,
  knownWeakMetrics: result.knownWeakMetrics ?? [],
  regressions,
  newlyFailing,
  metricDeltas,
};

console.log('Memory quality delta vs baseline');
console.log(
  `passRate: ${baselinePassRate} -> ${result.passRate}` +
    (summary.passRateDelta != null ? ` (${formatDelta(summary.passRateDelta)})` : ''),
);
console.log(
  `overallScore (passRate*100, NOT a grade): ${baseline.overallScore} -> ${result.overallScore}`,
);
console.log(`Pass state: ${baseline.passed} -> ${result.passed}`);
for (const entry of metricDeltas) {
  if (entry.delta == null) continue;
  console.log(
    `- ${entry.metric}: ${entry.baseline} -> ${entry.current} (${formatDelta(entry.delta)}) ` +
      `[threshold ${entry.threshold}${entry.knownWeak ? ', knownWeak' : ''}]`,
  );
}
console.log(JSON.stringify(summary, null, 2));

if (shouldEnforce && (passRateRegressed || regressions.length > 0 || newlyFailing.length > 0)) {
  console.error('Memory quality regressed versus baseline.');
  if (passRateRegressed) {
    console.error(`passRate dropped: ${baselinePassRate} -> ${result.passRate}`);
  }
  if (regressions.length > 0) {
    console.error(JSON.stringify({ regressions }, null, 2));
  }
  if (newlyFailing.length > 0) {
    console.error(JSON.stringify({ newlyFailing }, null, 2));
  }
  process.exit(1);
}
