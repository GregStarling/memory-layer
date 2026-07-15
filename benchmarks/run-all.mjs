/**
 * Phase 5.5 (decision D7) — unified benchmark harness.
 *
 * Runs the three benchmark scenarios (search / semantic / compaction) over
 * FIXED, DETERMINISTIC corpora, repeats each scenario >=5 times, and records
 * the MEDIAN ops/sec so CI timing noise is damped. Writes
 * `benchmarks/results/<version>.json` (version read from package.json) and
 * prints a table.
 *
 * Relationship to the standalone runners (search/semantic/compaction-benchmark.mjs):
 * those stay as quick single-shot probes wired to `benchmark:search` etc. This
 * harness supersedes them for the checked-in, comparable results file because
 * (a) it needs repeated runs + medians, (b) it sizes corpora for a CI-sane
 * warn-only step, and (c) the standalone compaction runner passes a RAW sync
 * adapter to `compactTurns` (which expects an async adapter) — this harness
 * uses `wrapSyncAdapter`, matching how real consumers and the test suite call it.
 *
 * Timing is inherently machine-dependent; the checked-in numbers are a baseline
 * snapshot. The compare step (scripts/compare-benchmarks.mjs) is warn-only and
 * NEVER fails CI (D7), so a cross-machine offset is tolerated by design.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createSQLiteAdapter,
  createSQLiteAdapterWithEmbeddings,
  wrapSyncAdapter,
  compactTurns,
  createSessionId,
} from '../dist/index.js';

const DEFAULT_RUNS = 5;

// Fixed deterministic corpora — sized so 5 runs of all three scenarios stay
// well under a minute on CI (search is a linear scan, so it dominates).
const CONFIG = {
  search: { docs: 500, queries: 50 },
  semantic: { docs: 1000, queries: 250, embeddingDims: 3 },
  compaction: { turns: 50, retain: 8 },
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function opsPerSec(operations, elapsedMs) {
  return (operations * 1000) / elapsedMs;
}

// --- Scenario implementations (deterministic corpora) -----------------------

function benchSearch() {
  const { docs, queries } = CONFIG.search;
  const adapter = createSQLiteAdapter(':memory:');
  const scope = { tenant_id: 'bench', system_id: 'search', scope_id: 'run-1' };
  for (let i = 0; i < docs; i += 1) {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: `Knowledge fact ${i} about sqlite memory retrieval`,
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
  }
  const startedAt = performance.now();
  for (let i = 0; i < queries; i += 1) {
    adapter.searchKnowledge(scope, 'sqlite retrieval');
  }
  const elapsedMs = performance.now() - startedAt;
  adapter.close();
  return opsPerSec(queries, elapsedMs);
}

function benchSemantic() {
  const { docs, queries, embeddingDims } = CONFIG.semantic;
  const adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  const scope = { tenant_id: 'bench', system_id: 'semantic', scope_id: 'run-1' };
  for (let i = 0; i < docs; i += 1) {
    const knowledge = adapter.insertKnowledgeMemory({
      ...scope,
      fact: `Semantic fact ${i}`,
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
    });
    const vector = new Float32Array(embeddingDims);
    for (let d = 0; d < embeddingDims; d += 1) vector[d] = (i + d) % 10;
    adapter.embeddings.storeEmbedding(knowledge.id, vector);
  }
  const query = new Float32Array(embeddingDims);
  for (let d = 0; d < embeddingDims; d += 1) query[d] = d + 1;
  const startedAt = performance.now();
  for (let i = 0; i < queries; i += 1) {
    adapter.embeddings.findSimilar(scope, query, { limit: 10 });
  }
  const elapsedMs = performance.now() - startedAt;
  adapter.close();
  return opsPerSec(queries, elapsedMs);
}

async function benchCompaction() {
  const { turns: turnCount, retain } = CONFIG.compaction;
  const raw = createSQLiteAdapter(':memory:');
  // compactTurns expects an AsyncStorageAdapter; wrap the native sync adapter
  // exactly as real consumers / the test suite do.
  const adapter = wrapSyncAdapter(raw);
  const scope = { tenant_id: 'bench', system_id: 'compaction', scope_id: 'run-1' };
  const sessionId = createSessionId(scope);
  for (let i = 0; i < turnCount; i += 1) {
    raw.insertTurn({
      ...scope,
      session_id: sessionId,
      actor: i % 2 === 0 ? 'user' : 'assistant',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Turn ${i} about retrieval and compaction in memory systems`,
      token_estimate: 120,
    });
  }
  const turns = raw.getActiveTurns(scope);
  const startedAt = performance.now();
  await compactTurns(
    adapter,
    scope,
    sessionId,
    turns,
    async (turnsToSummarize) => ({
      summary: `Summarized ${turnsToSummarize.length} turns`,
      key_entities: ['memory-layer'],
      topic_tags: ['benchmark'],
    }),
    'soft',
    retain,
  );
  const elapsedMs = performance.now() - startedAt;
  raw.close();
  // One compaction per run; report compactions/sec.
  return opsPerSec(1, elapsedMs);
}

const SCENARIOS = [
  { name: 'search', unit: 'searches/sec', run: benchSearch, config: CONFIG.search },
  { name: 'semantic', unit: 'lookups/sec', run: benchSemantic, config: CONFIG.semantic },
  { name: 'compaction', unit: 'compactions/sec', run: benchCompaction, config: CONFIG.compaction },
];

/**
 * Runs every scenario `runs` times and returns a structured results object
 * with the median ops/sec (and raw samples) per benchmark. Shared by the
 * write path (this file as main) and scripts/compare-benchmarks.mjs.
 */
export async function runAllBenchmarks({ runs = DEFAULT_RUNS } = {}) {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const benchmarks = {};
  for (const scenario of SCENARIOS) {
    const samples = [];
    for (let r = 0; r < runs; r += 1) {
      // eslint-disable-next-line no-await-in-loop
      samples.push(Number((await scenario.run()).toFixed(2)));
    }
    benchmarks[scenario.name] = {
      opsPerSec: Number(median(samples).toFixed(2)),
      unit: scenario.unit,
      samples,
      config: scenario.config,
    };
  }
  return {
    version: pkg.version,
    node: process.version,
    runs,
    benchmarks,
  };
}

export function formatTable(results) {
  const rows = Object.entries(results.benchmarks).map(([name, b]) => ({
    benchmark: name,
    'ops/sec (median)': b.opsPerSec,
    unit: b.unit,
    samples: b.samples.join(', '),
  }));
  return rows;
}

async function main() {
  const runsArg = process.argv.find((a) => a.startsWith('--runs='));
  const runs = runsArg ? Number(runsArg.split('=')[1]) : DEFAULT_RUNS;
  const results = await runAllBenchmarks({ runs });

  const outPath = fileURLToPath(
    new URL(`./results/${results.version}.json`, import.meta.url),
  );
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(fileURLToPath(new URL('./results/', import.meta.url)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

  console.log(`Benchmark results (${results.version}, ${runs} runs, node ${results.node}):`);
  console.table(formatTable(results));
  console.log(`Wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
