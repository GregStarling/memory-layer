# Memory Quality Release Gate

`memory-layer` treats memory quality as a release blocker, not a best-effort benchmark.

## Required Commands

Run these before shipping:

```bash
npm run eval:memory-quality:enforce
npm run eval:memory-quality:delta
```

The enforced run must pass every threshold. The delta report shows how far the current system has moved from the recorded baseline in `evals/memory-quality/baseline.json`.

## Final Thresholds

| Metric | Threshold |
|---|---:|
| `constraintRetentionRate` | `>= 0.92` |
| `preferenceRetentionRate` | `>= 0.90` |
| `identityRetentionRate` | `>= 0.95` |
| `procedureRetentionRate` | `>= 0.88` |
| `updateCorrectnessRate` | `>= 0.88` |
| `strategyOutcomeRecallRate` | `>= 0.85` |
| `falseMemoryRate` | `<= 0.05` |
| `contradictionResolutionAccuracy` | `>= 0.85` |
| `trustedMemoryPrecision` | `>= 0.90` |
| `trustedMemoryRecall` | `>= 0.88` |
| `memoryIsolationAccuracy` | `>= 0.95` |
| `provisionalLeakRate` | `<= 0.08` |
| `postCompactionFidelityScore` | `>= 0.88` |
| `postMaintenanceFidelityScore` | `>= 0.86` |

## How To Read The Score

- `overallScore = 100` means every tracked metric met or exceeded its threshold.
- `passed = true` means there are no threshold failures.
- The score is evidence-backed only when the scenario list and per-metric evaluations also pass.

## Quality Modes

The quick factory reports mode behavior separately from the aggregate score:

- `fast_adoption`: easiest start, weakest trust posture.
- `balanced_memory`: recommended default.
- `high_fidelity_memory`: strictest safety and lifecycle posture.

Mode reporting is descriptive. The release gate is still the main memory-quality suite.
