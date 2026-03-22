import { describe, expect, it } from 'vitest';

describe('memory quality harness', () => {
  it('returns the expected result contract', async () => {
    const { runMemoryQualityEvals } = await import('../../evals/memory-quality/index.mjs');
    const result = await runMemoryQualityEvals();

    expect(result.eval).toBe('memory-quality');
    expect(typeof result.overallScore).toBe('number');
    expect(typeof result.passed).toBe('boolean');
    expect(result.metrics).toHaveProperty('constraintRetentionRate');
    expect(result.metrics).toHaveProperty('falseMemoryRate');
    expect(result.metrics).toHaveProperty('strategyOutcomeRecallRate');
    expect(result.metrics).toHaveProperty('memoryIsolationAccuracy');
    expect(Array.isArray(result.scenarios)).toBe(true);
    expect(Array.isArray(result.evaluations)).toBe(true);
  }, 20000);

  it('returns diagnostic failure mapping when requested', async () => {
    const { runMemoryQualityEvals } = await import('../../evals/memory-quality/index.mjs');
    const result = await runMemoryQualityEvals({ diagnostic: true });

    expect(result.diagnostic.currentTruth).toHaveProperty('enginePassed');
    expect(result.diagnostic.currentTruth).toHaveProperty('platformPassed');
    expect(Array.isArray(result.diagnostic.moduleOutputs)).toBe(true);
    expect(result.diagnostic.moduleOutputs.length).toBeGreaterThan(0);
    expect(result.diagnostic.failureMap).toHaveProperty('metricFailures');
    expect(result.diagnostic.failureMap).toHaveProperty('scenarioFailures');
    expect(result.diagnostic.failureMap).toHaveProperty('platformFailures');
  }, 30000);

  it('marks deliberately broken metrics as failing', async () => {
    const { summarizeMetrics } = await import('../../evals/memory-quality/shared.mjs');
    const summary = summarizeMetrics({
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
    });

    expect(summary.passed).toBe(false);
    expect(summary.overallScore).toBeLessThan(10);
    expect(summary.evaluations.some((entry: { passed: boolean }) => entry.passed === false)).toBe(true);
  });

  it('pins the final memory-quality thresholds', async () => {
    const { THRESHOLDS } = await import('../../evals/memory-quality/shared.mjs');

    expect(THRESHOLDS.constraintRetentionRate).toBe(0.92);
    expect(THRESHOLDS.preferenceRetentionRate).toBe(0.9);
    expect(THRESHOLDS.identityRetentionRate).toBe(0.95);
    expect(THRESHOLDS.updateCorrectnessRate).toBe(0.88);
    expect(THRESHOLDS.falseMemoryRate).toBe(0.05);
    expect(THRESHOLDS.contradictionResolutionAccuracy).toBe(0.85);
    expect(THRESHOLDS.trustedMemoryPrecision).toBe(0.9);
    expect(THRESHOLDS.trustedMemoryRecall).toBe(0.88);
    expect(THRESHOLDS.provisionalLeakRate).toBe(0.08);
    expect(THRESHOLDS.postCompactionFidelityScore).toBe(0.88);
    expect(THRESHOLDS.postMaintenanceFidelityScore).toBe(0.86);
  });
});
