// Retrieval-quality eval (Phase 5.1).
//
// Runs a >=100-case, five-category dataset (evals/data/retrieval-cases.mjs)
// through TWO rankers in the same run — the full system (sqlite FTS + local
// hashed-trigram semantic + trust/recency/class weighting) and a pure
// exact-token-overlap "grep" baseline — and scores MRR + recall@{1,5} per
// category and overall for both.
//
// The gate (--enforce) is a REGRESSION gate, not an aspiration: the per-category
// thresholds below were calibrated from measured current behavior and set a
// small honest margin under it, then pinned. Categories the offline tier is
// structurally weak at (paraphrase: zero content-token overlap cannot be solved
// by whole-token matching) are flagged knownWeak — they still gate, at their
// honest low level. The gate additionally asserts the full system beats the
// grep baseline on overall MRR by a measured margin (D2).
//
// CLI contract (unchanged from the original 49-line version): same script path,
// --enforce flag, JSON to stdout, exit 1 on enforce-fail. Extra dev flags:
//   --check-baseline  apply the SAME gate to the baseline's scores instead of
//                     the system's (proves the baseline FAILS the gate).
//   --pretty          pretty-print the JSON (default is compact for
//                     byte-identical diffs).
//
// There is no separate delta-ratchet mechanism for retrieval (only
// memory-quality has one, in scripts/report-memory-quality-delta.mjs); the
// pinned thresholds in this file ARE the regression gate. See the final report.

import { loadDataset } from './retrieval-dataset.mjs';
import { runSystemCase, runBaselineCase } from './retrieval-runners.mjs';
import { aggregate, round4, RECALL_KS } from './retrieval-metrics.mjs';

// --- Pinned, calibrated thresholds (measured actual minus a 0.05 margin) -----
// mrr / recall1 / recall5 floors per category. CALIBRATED from the measured
// current system (see the comment block below), then pinned as a regression
// gate. Do NOT raise above measured current behavior; lower only with a
// documented reason. Measured system values at calibration (2026-07):
//   exact-term            mrr 1.0000  r@1 1.00  r@5 1.00
//   paraphrase  [weak]    mrr 0.5667  r@1 0.25  r@5 1.00
//   distractor-resistance mrr 0.7083  r@1 0.55  r@5 0.85
//   cross-class           mrr 1.0000  r@1 1.00  r@5 1.00
//   trust-vs-recency      mrr 1.0000  r@1 1.00  r@5 1.00
// Baseline (grep) at calibration: overall mrr 0.5621; system overall 0.8578.
//
// cross-class is an ADVERSARIAL gate on the class-weighting code path, not just
// "semantics beats grep". Each cross-class target is the SOLE trusted-core-class
// fact (identity/constraint/preference) with LOW query overlap, sitting above a
// higher-overlap project_fact trap; only buildMemoryContext's trusted-core
// bucket ordering surfaces it. A content-only cosine ranker (no class logic)
// scores cross-class mrr 0.3708 / r@1 0.00 / r@5 1.00 here — it FAILS this gate,
// where the previous content-overlap-friendly design let it pass byte-identical
// to the full system (mrr 0.9750 / r@1 0.95). The grep baseline is likewise
// defeated (cross-class mrr 0.2208 / r@1 0.00). See the final report.
const THRESHOLDS = {
  'exact-term': { mrr: 0.95, recall1: 0.95, recall5: 0.95 },
  paraphrase: { mrr: 0.51, recall1: 0.2, recall5: 0.95 },
  'distractor-resistance': { mrr: 0.65, recall1: 0.5, recall5: 0.8 },
  'cross-class': { mrr: 0.95, recall1: 0.95, recall5: 0.95 },
  'trust-vs-recency': { mrr: 0.95, recall1: 0.95, recall5: 0.95 },
};
// Minimum margin by which the system's OVERALL MRR must exceed the baseline's.
// Measured gap at calibration was 0.2957; pinned at measured minus 0.03. The
// eval is deterministic (byte-identical across runs), so no noise headroom is
// needed beyond the small measured-minus discipline used for the per-category
// floors.
const OVERALL_MRR_MARGIN_THRESHOLD = 0.2657;
// -----------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const shouldEnforce = args.has('--enforce');
const checkBaseline = args.has('--check-baseline');
const pretty = args.has('--pretty');

async function main() {
  const { byCategory, categories, knownWeak } = loadDataset();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const perCategory = {};
  const allSystem = [];
  const allBaseline = [];

  for (const category of categories) {
    const cases = byCategory.get(category);
    const systemResults = [];
    const baselineResults = [];
    for (const testCase of cases) {
      const relevantKeys = testCase.expected;
      const systemRanked = await runSystemCase(testCase, nowSeconds);
      const baselineRanked = runBaselineCase(testCase);
      systemResults.push({ rankedKeys: systemRanked, relevantKeys });
      baselineResults.push({ rankedKeys: baselineRanked, relevantKeys });
    }
    allSystem.push(...systemResults);
    allBaseline.push(...baselineResults);

    const system = aggregate(systemResults);
    const baseline = aggregate(baselineResults);
    const thresholds = THRESHOLDS[category];
    const scored = checkBaseline ? baseline : system;
    const pass = {
      mrr: scored.mrr >= thresholds.mrr,
      recall1: scored.recall[1] >= thresholds.recall1,
      recall5: scored.recall[5] >= thresholds.recall5,
    };
    pass.all = pass.mrr && pass.recall1 && pass.recall5;

    perCategory[category] = {
      count: system.count,
      knownWeak: knownWeak.has(category),
      system,
      baseline,
      systemBeatsBaselineMrr: round4(system.mrr - baseline.mrr),
      thresholds,
      pass,
    };
  }

  const overallSystem = aggregate(allSystem);
  const overallBaseline = aggregate(allBaseline);
  const overallScored = checkBaseline ? overallBaseline : overallSystem;
  const mrrMargin = round4(overallScored.mrr - overallBaseline.mrr);
  const beatsBaseline = mrrMargin >= OVERALL_MRR_MARGIN_THRESHOLD;

  const thresholdsMet = Object.values(perCategory).every((entry) => entry.pass.all);
  const passed = thresholdsMet && beatsBaseline;

  const report = {
    eval: 'retrieval-quality',
    mode: checkBaseline ? 'baseline-as-system (gate proof)' : 'system',
    dataset: {
      totalCases: allSystem.length,
      perCategory: Object.fromEntries(categories.map((c) => [c, byCategory.get(c).length])),
    },
    recallKs: RECALL_KS,
    categories: perCategory,
    overall: {
      system: overallSystem,
      baseline: overallBaseline,
      scored: checkBaseline ? 'baseline' : 'system',
      overallMrrMargin: mrrMargin,
      overallMrrMarginThreshold: OVERALL_MRR_MARGIN_THRESHOLD,
      beatsBaseline,
    },
    gate: { thresholdsMet, beatsBaseline, passed },
    passed,
  };

  console.log(JSON.stringify(report, null, pretty ? 2 : 0));

  if (shouldEnforce && !passed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
