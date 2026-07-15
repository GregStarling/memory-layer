/**
 * Phase 5.5 (decision D7) — benchmark regression comparison. WARN-ONLY.
 *
 * Runs the benchmark harness fresh, loads the latest checked-in results file
 * (highest semver under benchmarks/results/), and prints a comparison table.
 * If any benchmark's median ops/sec has dropped by more than the threshold
 * (20%) vs the baseline, it emits a GitHub `::warning::` annotation — but it
 * ALWAYS exits 0. Benchmark timing is machine-dependent and this must never
 * fail CI (D7).
 *
 * The warning threshold applies to MEDIANS (runAllBenchmarks already reduces
 * >=5 samples to a median to damp CI noise).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAllBenchmarks, formatTable } from '../benchmarks/run-all.mjs';

const REGRESSION_THRESHOLD = 0.2; // 20% drop in ops/sec

function parseSemver(name) {
  const m = name.match(/^(\d+)\.(\d+)\.(\d+)\.json$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function findLatestResultsFile() {
  const dir = fileURLToPath(new URL('../benchmarks/results/', import.meta.url));
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const versioned = entries
    .map((name) => ({ name, semver: parseSemver(name) }))
    .filter((e) => e.semver !== null)
    .sort((a, b) => compareSemver(b.semver, a.semver));
  if (versioned.length === 0) return null;
  const chosen = versioned[0];
  return {
    path: `${dir}${chosen.name}`,
    data: JSON.parse(readFileSync(`${dir}${chosen.name}`, 'utf8')),
  };
}

async function main() {
  const current = await runAllBenchmarks();
  console.log(`Current run (${current.version}, ${current.runs} runs, node ${current.node}):`);
  console.table(formatTable(current));

  const baseline = findLatestResultsFile();
  if (!baseline) {
    console.log(
      'No prior benchmarks/results/<version>.json found — nothing to compare against. (warn-only, exit 0)',
    );
    return;
  }

  console.log(`\nComparing against baseline: ${baseline.data.version} (${baseline.path})`);

  const comparison = [];
  const regressions = [];
  for (const [name, cur] of Object.entries(current.benchmarks)) {
    const base = baseline.data.benchmarks?.[name];
    if (!base) {
      comparison.push({
        benchmark: name,
        baseline: 'n/a',
        current: cur.opsPerSec,
        'delta %': 'new',
      });
      continue;
    }
    const deltaPct = ((cur.opsPerSec - base.opsPerSec) / base.opsPerSec) * 100;
    comparison.push({
      benchmark: name,
      [`baseline (${baseline.data.version})`]: base.opsPerSec,
      current: cur.opsPerSec,
      'delta %': Number(deltaPct.toFixed(1)),
    });
    // Regression = current is slower (fewer ops/sec) by more than the threshold.
    if (base.opsPerSec > 0 && (base.opsPerSec - cur.opsPerSec) / base.opsPerSec > REGRESSION_THRESHOLD) {
      regressions.push({ name, base: base.opsPerSec, cur: cur.opsPerSec, deltaPct });
    }
  }
  console.table(comparison);

  if (regressions.length > 0) {
    for (const r of regressions) {
      const msg = `Benchmark regression: ${r.name} dropped ${Math.abs(r.deltaPct).toFixed(1)}% vs ${baseline.data.version} (${r.base} -> ${r.cur} ops/sec, threshold ${REGRESSION_THRESHOLD * 100}%)`;
      // GitHub Actions annotation; harmless plain text elsewhere.
      console.log(`::warning::${msg}`);
      console.warn(msg);
    }
    console.log(
      `\n${regressions.length} benchmark(s) regressed >${REGRESSION_THRESHOLD * 100}%. This is WARN-ONLY and does not fail CI (timing is machine-dependent).`,
    );
  } else {
    console.log('\nNo benchmark regressed beyond the 20% threshold.');
  }
  // Always exit 0 (D7 warn-only).
}

main().catch((err) => {
  // Even on an unexpected error, do not fail CI — this is a warn-only step.
  console.warn('::warning::benchmark comparison errored (warn-only, ignored):', err?.message ?? err);
  process.exit(0);
});
