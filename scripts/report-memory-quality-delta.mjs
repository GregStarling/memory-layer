import baseline from '../evals/memory-quality/baseline.json' with { type: 'json' };
import { THRESHOLDS } from '../evals/memory-quality/shared.mjs';
import { runMemoryQualityEvals } from '../evals/memory-quality/index.mjs';

const shouldEnforce = process.argv.includes('--enforce');
const LOWER_IS_BETTER = new Set(['falseMemoryRate', 'provisionalLeakRate']);

function formatDelta(delta) {
  const rounded = Math.round(delta * 10000) / 10000;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(4)}`;
}

const result = await runMemoryQualityEvals();

const metricDeltas = Object.keys(THRESHOLDS).map((metric) => ({
  metric,
  baseline: baseline.metrics[metric] ?? null,
  current: result.metrics[metric] ?? null,
  delta:
    baseline.metrics[metric] != null && result.metrics[metric] != null
      ? result.metrics[metric] - baseline.metrics[metric]
      : null,
  threshold: THRESHOLDS[metric],
}));

const summary = {
  baselineOverallScore: baseline.overallScore,
  currentOverallScore: result.overallScore,
  overallScoreDelta: Math.round((result.overallScore - baseline.overallScore) * 100) / 100,
  baselinePassed: baseline.passed,
  currentPassed: result.passed,
  metricDeltas,
};

const regressions = metricDeltas
  .filter((entry) => entry.baseline != null && entry.current != null)
  .filter((entry) =>
    LOWER_IS_BETTER.has(entry.metric) ? entry.current > entry.baseline : entry.current < entry.baseline,
  )
  .map((entry) => ({
    metric: entry.metric,
    baseline: entry.baseline,
    current: entry.current,
  }));

console.log('Memory quality delta vs baseline');
console.log(`Overall score: ${baseline.overallScore} -> ${result.overallScore} (${formatDelta(summary.overallScoreDelta)})`);
console.log(`Pass state: ${baseline.passed} -> ${result.passed}`);
for (const entry of metricDeltas) {
  if (entry.delta == null) continue;
  console.log(
    `- ${entry.metric}: ${entry.baseline} -> ${entry.current} (${formatDelta(entry.delta)}) [threshold ${entry.threshold}]`,
  );
}
console.log(JSON.stringify(summary, null, 2));

if (shouldEnforce && (result.overallScore < baseline.overallScore || regressions.length > 0)) {
  console.error('Memory quality regressed versus baseline.');
  if (regressions.length > 0) {
    console.error(JSON.stringify({ regressions }, null, 2));
  }
  process.exit(1);
}
