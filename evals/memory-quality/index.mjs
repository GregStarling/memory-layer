import { runContradictionEvals } from './contradictions.mjs';
import { runFidelityEvals } from './fidelity.mjs';
import { runFalseMemoryEvals } from './false-memory.mjs';
import { runLongHorizonEvals } from './long-horizon.mjs';
import { runQualityModeReport } from './quality-modes.mjs';
import { runRetentionEvals } from './retention.mjs';
import { mergeScenarioOutputs } from './shared.mjs';

export async function runMemoryQualityEvals() {
  const qualityModes = await runQualityModeReport();
  const outputs = await Promise.all([
    runRetentionEvals(),
    runContradictionEvals(),
    runFalseMemoryEvals(),
    runFidelityEvals(),
    runLongHorizonEvals(),
  ]);

  return {
    eval: 'memory-quality',
    qualityModes,
    ...mergeScenarioOutputs(outputs),
  };
}

async function main() {
  const enforce = process.argv.includes('--enforce');
  const result = await runMemoryQualityEvals();
  console.log(JSON.stringify(result, null, 2));
  if (enforce && !result.passed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
