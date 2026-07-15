import {
  createInMemoryAdapter,
  extractTemporalWindow,
  getFactsAt,
} from '../../dist/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

/**
 * Temporal metrics — de-fitted to >=20 distinct cases each (manager decision
 * D4):
 *   - temporalExtractionAccuracy: 22 distinct temporal expressions (explicit
 *     from/until, quarters, ISO dates, and deliberately-ambiguous phrases that
 *     must NOT be extracted). Ground-truth flags are the true temporal meaning.
 *   - factsAtFastPath: 20 windowed facts with disjoint windows; each in-window
 *     query must use the fast path and return exactly its fact.
 *   - timeFormattingQuality: queryTimestamp echoed correctly across 20 queries.
 */
const TEMPORAL_CASES = [
  { text: 'effective March 1st, 2025', expectFrom: true, expectUntil: false },
  { text: 'starting January 15, 2026', expectFrom: true, expectUntil: false },
  { text: 'until December 31, 2025', expectFrom: false, expectUntil: true },
  { text: 'as of Q3 2025', expectFrom: true, expectUntil: false },
  { text: 'Q1 2026', expectFrom: true, expectUntil: true },
  { text: 'from 2025-06-01', expectFrom: true, expectUntil: false },
  { text: 'before 2026-01-01', expectFrom: false, expectUntil: true },
  { text: 'valid through 2025-06-30', expectFrom: false, expectUntil: true },
  { text: 'commencing 2025-04-01', expectFrom: true, expectUntil: false },
  { text: 'no later than 2025-09-01', expectFrom: false, expectUntil: true },
  { text: 'as of 2026-03-01', expectFrom: true, expectUntil: false },
  { text: 'until 2028-12-31', expectFrom: false, expectUntil: true },
  { text: 'starting 2027-02-01', expectFrom: true, expectUntil: false },
  { text: 'Q4 2025', expectFrom: true, expectUntil: true },
  { text: 'from 2024-11-01', expectFrom: true, expectUntil: false },
  { text: 'before 2027-07-01', expectFrom: false, expectUntil: true },
  // Conservative: ambiguous references must NOT be extracted.
  { text: 'starting Monday', expectFrom: false, expectUntil: false },
  { text: 'until the migration completes', expectFrom: false, expectUntil: false },
  { text: 'just a normal fact', expectFrom: false, expectUntil: false },
  { text: 'whenever the team decides', expectFrom: false, expectUntil: false },
  { text: 'beginning next fiscal year', expectFrom: false, expectUntil: false },
  { text: 'sometime soon', expectFrom: false, expectUntil: false },
];

export async function runTemporalEvals(_options = {}) {
  // --- temporalExtractionAccuracy ---
  let temporalCorrect = 0;
  const temporalMisses = [];
  for (const tc of TEMPORAL_CASES) {
    const result = extractTemporalWindow(tc.text);
    const fromCorrect = tc.expectFrom ? result.valid_from != null : result.valid_from == null;
    const untilCorrect = tc.expectUntil ? result.valid_until != null : result.valid_until == null;
    if (fromCorrect && untilCorrect) temporalCorrect += 1;
    else temporalMisses.push({ text: tc.text, from: result.valid_from, until: result.valid_until });
  }
  const temporalExtractionAccuracy = ratio(temporalCorrect, TEMPORAL_CASES.length);

  // --- factsAtFastPath + timeFormattingQuality over 20 windowed facts ---
  const adapter = createInMemoryAdapter();
  const scope = { tenant_id: 'eval', system_id: 'memory-quality', scope_id: 'temporal-eval' };
  const asyncAdapter = wrapSyncAdapter(adapter);
  const noopGetContextAt = async () => { throw new Error('should not be called'); };

  const base = 1704067200; // 2024-01-01
  const gap = 60 * 60 * 24 * 60; // 60 days between window starts
  const windowLen = 60 * 60 * 24 * 30; // 30-day windows (disjoint)
  const WINDOWS = 20;
  for (let i = 0; i < WINDOWS; i += 1) {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: `Windowed target number ${i}`,
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
      valid_from: base + i * gap,
      valid_until: base + i * gap + windowLen,
    });
  }

  let fastPathHits = 0;
  let timestampHits = 0;
  for (let i = 0; i < WINDOWS; i += 1) {
    const midpoint = base + i * gap + Math.floor(windowLen / 2);
    const result = await getFactsAt(asyncAdapter, noopGetContextAt, {
      timestamp: midpoint,
      scope,
      fallbackToReplay: false,
    });
    const correct = result.usedFastPath && result.facts.length === 1 && result.facts[0].fact === `Windowed target number ${i}`;
    if (correct) fastPathHits += 1;
    if (result.queryTimestamp === midpoint) timestampHits += 1;
  }

  // Outside all windows → no facts (query far in the past).
  const outside = await getFactsAt(asyncAdapter, noopGetContextAt, {
    timestamp: 1000000000, // 2001
    scope,
    fallbackToReplay: false,
  });
  const noFactsOutside = outside.facts.length === 0;

  const factsAtFastPath = average([ratio(fastPathHits, WINDOWS), noFactsOutside ? 1 : 0]);
  const timeFormattingQuality = average([ratio(timestampHits, WINDOWS), factsAtFastPath]);

  adapter.close();

  const metrics = {
    temporalExtractionAccuracy,
    factsAtFastPath,
    timeFormattingQuality,
  };

  return tagEvalOutput('temporal', {
    metrics,
    scenarios: [
      assertScenario('temporal_extraction_conservative', temporalExtractionAccuracy >= 0.8, {
        correct: temporalCorrect,
        total: TEMPORAL_CASES.length,
        misses: temporalMisses,
      }),
      assertScenario('facts_at_uses_fast_path', ratio(fastPathHits, WINDOWS) >= 0.9, {
        fastPathHits,
        windows: WINDOWS,
      }),
      assertScenario('facts_at_excludes_outside_window', noFactsOutside, {
        outsideCount: outside.facts.length,
      }),
    ],
    diagnostic: {
      metricTraces: {
        temporalExtractionAccuracy: { stage: 'temporal_extraction', correct: temporalCorrect, total: TEMPORAL_CASES.length, misses: temporalMisses },
        factsAtFastPath: { stage: 'facts_at', fastPathHits, windows: WINDOWS },
        timeFormattingQuality: { stage: 'facts_at', timestampHits, windows: WINDOWS },
      },
    },
  });
}
