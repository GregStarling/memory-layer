import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runContradictionEvals } from './contradictions.mjs';
import { runEpisodicRecallEvals } from './episodic-recall.mjs';
import { runFidelityEvals } from './fidelity.mjs';
import { runAssociationEvals } from './associations.mjs';
import { runPlaybookEvals } from './playbooks.mjs';
import { runProfileEvals } from './profiles.mjs';
import { runFalseMemoryEvals } from './false-memory.mjs';
import { runLongHorizonEvals } from './long-horizon.mjs';
import { runPlatformQualityEval } from '../platform-quality/index.mjs';
import { runQualityModeReport } from './quality-modes.mjs';
import { runRetentionEvals } from './retention.mjs';
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
  if (enforce && !result.passed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
