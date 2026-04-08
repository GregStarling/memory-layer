import {
  createMemory,
  createInMemoryAdapter,
  extractTemporalWindow,
  extractRationale,
  getFactsAt,
} from '../../dist/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

export async function runTemporalEvals(_options = {}) {
  // --- Metric: temporal_extraction_accuracy ---
  const temporalCases = [
    { text: 'effective March 1st, 2025', expectFrom: true, expectUntil: false },
    { text: 'starting January 15, 2026', expectFrom: true, expectUntil: false },
    { text: 'until December 31, 2025', expectFrom: false, expectUntil: true },
    { text: 'as of Q3 2025', expectFrom: true, expectUntil: false },
    { text: 'Q1 2026', expectFrom: true, expectUntil: true },
    { text: 'from 2025-06-01', expectFrom: true, expectUntil: false },
    { text: 'before 2026-01-01', expectFrom: false, expectUntil: true },
    // Conservative: ambiguous references should NOT be extracted
    { text: 'starting Monday', expectFrom: false, expectUntil: false },
    { text: 'until the migration completes', expectFrom: false, expectUntil: false },
    { text: 'just a normal fact', expectFrom: false, expectUntil: false },
  ];

  let temporalCorrect = 0;
  const temporalDetails = [];
  for (const tc of temporalCases) {
    const result = extractTemporalWindow(tc.text);
    const fromCorrect = tc.expectFrom ? result.valid_from != null : result.valid_from == null;
    const untilCorrect = tc.expectUntil ? result.valid_until != null : result.valid_until == null;
    const correct = fromCorrect && untilCorrect;
    if (correct) temporalCorrect++;
    temporalDetails.push({
      text: tc.text,
      correct,
      fromCorrect,
      untilCorrect,
      result,
    });
  }
  const temporalExtractionAccuracy = ratio(temporalCorrect, temporalCases.length);

  // --- Metric: facts_at_fast_path ---
  const adapter = createInMemoryAdapter();
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    scope_id: 'temporal-eval',
  };
  const asyncAdapter = wrapSyncAdapter(adapter);

  // Insert windowed facts
  adapter.insertKnowledgeMemory({
    ...scope,
    fact: 'Q1 target is 100 users',
    fact_type: 'reference',
    source: 'manual',
    confidence: 'high',
    valid_from: 1704067200, // 2024-01-01
    valid_until: 1711929600, // 2024-04-01
  });
  adapter.insertKnowledgeMemory({
    ...scope,
    fact: 'Budget approved for 2025',
    fact_type: 'reference',
    source: 'manual',
    confidence: 'high',
    valid_from: 1735689600, // 2025-01-01
    valid_until: 1767225600, // 2025-12-31+
  });

  const noopGetContextAt = async () => { throw new Error('should not be called'); };

  // Query within first fact's window
  const result1 = await getFactsAt(asyncAdapter, noopGetContextAt, {
    timestamp: 1706745600, // 2024-02-01
    scope,
    fallbackToReplay: false,
  });
  const fastPathUsed = result1.usedFastPath;
  const correctFactCount1 = result1.facts.length === 1
    && result1.facts[0].fact.includes('Q1 target');

  // Query outside both windows
  const result2 = await getFactsAt(asyncAdapter, noopGetContextAt, {
    timestamp: 1672531200, // 2023-01-01
    scope,
    fallbackToReplay: false,
  });
  const noFactsOutsideWindow = result2.facts.length === 0;

  const factsAtFastPath = average([
    fastPathUsed ? 1 : 0,
    correctFactCount1 ? 1 : 0,
    noFactsOutsideWindow ? 1 : 0,
  ]);

  // --- Metric: time_formatting_quality ---
  // Verify that windowed facts include correct queryTimestamp
  const timestampCorrect = result1.queryTimestamp === 1706745600 ? 1 : 0;

  const metrics = {
    temporalExtractionAccuracy,
    factsAtFastPath,
    timeFormattingQuality: average([timestampCorrect, factsAtFastPath]),
  };

  return tagEvalOutput('temporal', {
    metrics,
    scenarios: [
      assertScenario('temporal_extraction_conservative', temporalExtractionAccuracy >= 0.8, {
        correct: temporalCorrect,
        total: temporalCases.length,
        details: temporalDetails,
      }),
      assertScenario('facts_at_uses_fast_path', fastPathUsed, {
        usedFastPath: fastPathUsed,
        factCount: result1.facts.length,
      }),
      assertScenario('facts_at_excludes_outside_window', noFactsOutsideWindow, {
        factCount: result2.facts.length,
      }),
    ],
  });
}
