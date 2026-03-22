# Memory Quality Release Gate

`memory-layer` treats memory quality as a release blocker, not a best-effort benchmark.

## Required Commands

Run these before shipping:

```bash
npm run eval:retrieval:enforce
npm run eval:memory-quality:enforce
npm run eval:memory-quality:delta:enforce
npm run python:check
npm run eval:platform-quality:enforce
```

The enforced memory-quality run must pass every threshold. The enforced delta report blocks regressions versus the recorded baseline in `evals/memory-quality/baseline.json`. Refresh that baseline only after a full hard-gate pass so it remains a known-good release anchor. The Python and platform checks prove that hosted HTTP, Node CLI inspection, Python client surfaces, the fresh-install no-provider replay, and the hosted shared-memory replay all still work against the same product contract.

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

## Platform Proof

`memory-layer` does not treat core-engine quality as sufficient proof on its own. The final gate also requires:

- `npm run python:check`
  Verifies the Python package can be installed in a clean virtualenv, built, linted, and tested.
- `npm run eval:platform-quality:enforce`
  Starts the hosted server, seeds real memory, verifies hosted inspection routes, verifies the Node inspection CLI, verifies the Python CLI against the same live service, and replays a shared-memory hosted trace across multiple scopes.

The release claim is only defensible when both the engine-quality gate and the platform-quality gate are green.
