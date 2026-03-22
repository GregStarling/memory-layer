# Memory Quality Baseline

This document records the current release-quality baseline used by the enforced delta report in `evals/memory-quality/baseline.json`.

It is the known-good anchor that future releases must not regress from.

## Baseline Run

Command:

```bash
npm run eval:memory-quality
```

Result:

- overall score: `100`
- passed: `true`

## Metrics

| Metric | Baseline | Threshold | Status |
|---|---:|---:|---|
| `constraintRetentionRate` | `1.00` | `0.92` | pass |
| `preferenceRetentionRate` | `1.00` | `0.90` | pass |
| `identityRetentionRate` | `1.00` | `0.95` | pass |
| `procedureRetentionRate` | `1.00` | `0.88` | pass |
| `updateCorrectnessRate` | `1.00` | `0.88` | pass |
| `strategyOutcomeRecallRate` | `1.00` | `0.85` | pass |
| `falseMemoryRate` | `0.00` | `0.05` | pass |
| `contradictionResolutionAccuracy` | `1.00` | `0.85` | pass |
| `trustedMemoryPrecision` | `1.00` | `0.90` | pass |
| `trustedMemoryRecall` | `1.00` | `0.88` | pass |
| `memoryIsolationAccuracy` | `1.00` | `0.95` | pass |
| `provisionalLeakRate` | `0.00` | `0.08` | pass |
| `postCompactionFidelityScore` | `1.00` | `0.88` | pass |
| `postMaintenanceFidelityScore` | `1.00` | `0.86` | pass |

## What This Baseline Means

This baseline represents the current release claim:

- evidence-grounded promotion is working
- contradiction handling is explicit and safe
- trust-aware retrieval prefers durable memory correctly
- long-horizon compaction and maintenance preserve critical memory
- isolation and cross-scope behavior remain safe by default
- fresh-install no-provider replay still preserves the right local memory contract
- hosted shared-memory replay still surfaces the right cross-scope knowledge

Because the baseline is a known-good release anchor, the delta gate has a stricter meaning:

- green delta output means the current build has not regressed from the proven release baseline
- baseline refreshes should only happen after a full hard-gate pass
- any future baseline change should be treated as a deliberate quality reset, not a convenience update
