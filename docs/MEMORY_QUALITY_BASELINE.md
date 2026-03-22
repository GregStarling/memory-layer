# Memory Quality Baseline

This document records the baseline output from the Phase 0 memory-quality harness before the deeper engine changes in the 100/100 execution plan.

## Baseline Run

Command:

```bash
npm run eval:memory-quality
```

Result:

- overall score: `55.81`
- passed: `false`

## Metrics

| Metric | Baseline | Threshold | Status |
|---|---:|---:|---|
| `constraintRetentionRate` | `1.00` | `0.92` | pass |
| `preferenceRetentionRate` | `1.00` | `0.90` | pass |
| `identityRetentionRate` | `1.00` | `0.95` | pass |
| `procedureRetentionRate` | `1.00` | `0.88` | pass |
| `updateCorrectnessRate` | `0.00` | `0.88` | fail |
| `strategyOutcomeRecallRate` | `0.50` | `0.85` | fail |
| `falseMemoryRate` | `1.00` | `0.05` | fail |
| `contradictionResolutionAccuracy` | `0.00` | `0.85` | fail |
| `trustedMemoryPrecision` | `0.00` | `0.90` | fail |
| `trustedMemoryRecall` | `1.00` | `0.88` | pass |
| `memoryIsolationAccuracy` | `0.50` | `0.95` | fail |
| `provisionalLeakRate` | `1.00` | `0.08` | fail |
| `postCompactionFidelityScore` | `0.50` | `0.88` | fail |
| `postMaintenanceFidelityScore` | `1.00` | `0.86` | pass |

## Most Important Failures

### 1. False durable memory can still be created from summary-derived content

The baseline `falseMemoryRate` is `1.00`, which means the harness was able to promote and recall a false durable fact created from a misleading summary.

This is the clearest proof that the current pipeline is still too summary-dependent.

### 2. Updates and contradictions are not handled safely enough

The baseline `updateCorrectnessRate` and `contradictionResolutionAccuracy` are both `0.00`.

In the baseline contradiction scenario, both the old and new preference remained present, and the outdated preference still dominated the recall order.

### 3. Trusted memory precision is too low

The baseline `trustedMemoryPrecision` is `0.00`.

The system can retain facts, but it is not yet good enough at distinguishing what should count as durable, trustworthy memory.

### 4. Compaction still loses important information

The baseline `postCompactionFidelityScore` is `0.50`.

In the fidelity scenario, the secondary detail survived compaction while the critical local-first constraint did not.

### 5. Strategy learning and workflow inheritance are still weak

The baseline `strategyOutcomeRecallRate` and `memoryIsolationAccuracy` are both `0.50`.

This means the current system is not yet good enough at:

- learning from successful and failed execution outcomes
- safely surfacing shared or inherited memory only when appropriate

## Interpretation

The current baseline shows a system that is already capable of retaining manually inserted durable memory, but is still far from a 100/100 long-horizon learning memory system.

The biggest gaps are exactly the ones identified in the execution plan:

- summary-first learning
- weak contradiction handling
- poor trust gating
- insufficient compaction fidelity
- incomplete workflow inheritance behavior

## What This Baseline Means For The Plan

This baseline validates the current execution strategy.

The next highest-leverage work remains:

1. evidence-grounded knowledge formation
2. trust-state and contradiction handling
3. trusted-core memory separation
4. trust-aware retrieval
5. lineage-safe and outcome-aware memory behavior
