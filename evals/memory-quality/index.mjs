/**
 * Memory-quality eval suite.
 *
 * REPORTING (manager decision D3): the suite reports raw actual values per
 * metric, a per-metric pass/fail against an explicit threshold, and a
 * `passRate` (fraction of metrics meeting threshold). `overallScore` is kept
 * only for back-compat consumers and equals passRate*100 — a pass fraction,
 * NOT a 0-100 quality grade (see `scorePresentation`). Metrics whose threshold
 * is fitted below the feature's natural baseline are flagged `knownWeak: true`
 * (see KNOWN_WEAK in shared.mjs) so the aggregate is never read as "perfect".
 *
 * DETERMINISM: every suite runs with mocked LLM clients so CI output is
 * byte-stable and hermetic (no network, no API keys).
 *
 * LIVE-PROVIDER PROFILE (manager decision D4): set MEMORY_EVAL_LIVE=1 with
 * OPENAI_API_KEY present to swap the mock for the real OpenAI structured-
 * generation client on the suites where the LLM output actually matters
 * (currently episodic-recall: recap + reflect synthesis). This is LOCAL ONLY —
 * CI never sets MEMORY_EVAL_LIVE, so the enforced gates always run mocked. Use
 * it to sanity-check that the pipeline holds up against a real model:
 *     MEMORY_EVAL_LIVE=1 OPENAI_API_KEY=sk-... npm run eval:memory-quality
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runContradictionEvals } from './contradictions.mjs';
import { runEpisodicRecallEvals } from './episodic-recall.mjs';
import { runFidelityEvals } from './fidelity.mjs';
import { runAssociationEvals } from './associations.mjs';
import { runPlaybookEvals } from './playbooks.mjs';
import { runProfileEvals } from './profiles.mjs';
import { runSnapshotEvals } from './snapshots.mjs';
import { runFalseMemoryEvals } from './false-memory.mjs';
import { runLongHorizonEvals } from './long-horizon.mjs';
import { runPlatformQualityEval } from '../platform-quality/index.mjs';
import { runQualityModeReport } from './quality-modes.mjs';
import { runRetentionEvals } from './retention.mjs';
import { runDiscoveryEvals } from './discovery.mjs';
import { runTemporalEvals } from './temporal.mjs';
import { runReflectionEvals } from './reflection.mjs';
import { runIntelligenceEvals } from './intelligence.mjs';
import { buildDiagnosticReport, mergeScenarioOutputs } from './shared.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

async function readBaselineReport() {
  const raw = await readFile(path.join(currentDir, 'baseline.json'), 'utf8');
  return JSON.parse(raw);
}

export async function runMemoryQualityEvals(options = {}) {
  const diagnostic = options.diagnostic === true;
  const qualityModes = await runQualityModeReport();
  const outputs = await Promise.all([
    runRetentionEvals({ diagnostic }),
    runContradictionEvals({ diagnostic }),
    runFalseMemoryEvals({ diagnostic }),
    runFidelityEvals({ diagnostic }),
    runLongHorizonEvals({ diagnostic }),
    runEpisodicRecallEvals({ diagnostic }),
    runProfileEvals({ diagnostic }),
    runPlaybookEvals({ diagnostic }),
    runAssociationEvals({ diagnostic }),
    runSnapshotEvals({ diagnostic }),
    runDiscoveryEvals({ diagnostic }),
    runTemporalEvals({ diagnostic }),
    runReflectionEvals({ diagnostic }),
    runIntelligenceEvals({ diagnostic }),
  ]);
  const merged = mergeScenarioOutputs(outputs);
  const result = {
    eval: 'memory-quality',
    qualityModes,
    ...merged,
  };

  if (!diagnostic) {
    return result;
  }

  const [baseline, platformQuality] = await Promise.all([readBaselineReport(), runPlatformQualityEval()]);
  return {
    ...result,
    diagnostic: buildDiagnosticReport({
      outputs,
      engineResult: result,
      baseline,
      platformQuality,
    }),
  };
}

async function main() {
  const enforce = process.argv.includes('--enforce');
  const diagnostic = process.argv.includes('--diagnostic');
  const result = await runMemoryQualityEvals({ diagnostic });
  console.log(JSON.stringify(result, null, 2));
  // Human-readable one-liner to stderr so JSON on stdout stays machine-parseable.
  const weak = result.knownWeakMetrics ?? [];
  console.error(
    `\nmemory-quality: passRate ${result.metricsPassing}/${result.metricsTotal} ` +
      `(${result.overallScore}% of metrics meet threshold — a pass rate, not a quality grade)` +
      (weak.length ? `; knownWeak: ${weak.join(', ')}` : ''),
  );
  if (enforce && !result.passed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
