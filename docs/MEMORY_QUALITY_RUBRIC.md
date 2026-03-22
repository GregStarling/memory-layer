# Memory Quality Rubric

This rubric defines what "memory quality" means for `memory-layer`.

The goal is not to measure how many features the system has. The goal is to measure whether an AI-heavy product can safely keep context, learn over time, and recall the right memory later.

## Scoring Philosophy

The overall score is a weighted summary of memory-quality metrics. A higher score means:

- important memory survives over time
- durable knowledge is correct more often
- updates and contradictions are handled safely
- retrieval surfaces trustworthy memory
- workflow memory behavior is safe across scopes and lineages

The score does **not** give extra credit for:

- packaging quality
- transport surfaces
- documentation quality
- number of tests
- size or complexity of the implementation

Those matter for adoption, but not for memory quality.

## Metrics

All metrics are normalized to `0.0` through `1.0`.

### `constraintRetentionRate`

How often durable constraints that should survive are still available when needed later.

Formula:

`correctly_recalled_constraints / total_expected_constraints`

Target:

`>= 0.92`

### `preferenceRetentionRate`

How often user or system preferences survive long enough to be recalled correctly.

Formula:

`correctly_recalled_preferences / total_expected_preferences`

Target:

`>= 0.90`

### `identityRetentionRate`

How often durable identity information survives and is recalled correctly.

Formula:

`correctly_recalled_identity_facts / total_expected_identity_facts`

Target:

`>= 0.95`

### `procedureRetentionRate`

How often durable procedural knowledge remains available and correctly recalled.

Formula:

`correctly_recalled_procedures / total_expected_procedures`

Target:

`>= 0.88`

### `updateCorrectnessRate`

How often the system prefers the latest correct fact when a value is revised or reversed.

Formula:

`correct_updates_handled / total_update_scenarios`

Target:

`>= 0.88`

### `strategyOutcomeRecallRate`

How often the system remembers that a strategy succeeded or failed, and recalls that outcome appropriately.

Formula:

`correct_strategy_outcome_recalls / total_strategy_outcome_checks`

Target:

`>= 0.85`

### `falseMemoryRate`

How often the system promotes or recalls unsupported memory as if it were durable truth.

Formula:

`false_durable_memories_detected / total_false_memory_checks`

Target:

`<= 0.05`

### `contradictionResolutionAccuracy`

How often contradictions are handled safely instead of silently preserving outdated memory.

Formula:

`correctly_resolved_contradictions / total_contradiction_checks`

Target:

`>= 0.85`

### `trustedMemoryPrecision`

How often memory that is surfaced as durable/trusted is actually correct and appropriate.

Formula:

`correct_trusted_recalls / total_trusted_recalls`

Target:

`>= 0.90`

### `trustedMemoryRecall`

How often the system successfully surfaces trusted memory when it should.

Formula:

`trusted_memories_recalled_when_needed / total_trusted_memory_needs`

Target:

`>= 0.88`

### `memoryIsolationAccuracy`

How often the system preserves the right boundary behavior between local, lineage, workspace, and cross-scope memory.

Formula:

`correct_isolation_or_inheritance_behaviors / total_isolation_checks`

Target:

`>= 0.95`

### `provisionalLeakRate`

How often weak, provisional, or otherwise unsafe memory leaks into default recall behavior.

Formula:

`unsafe_provisional_surface_events / total_provisional_safety_checks`

Target:

`<= 0.08`

### `postCompactionFidelityScore`

How much important information survives compaction without corruption.

Formula:

`important_facts_preserved_after_compaction / total_important_facts_checked_after_compaction`

Target:

`>= 0.88`

### `postMaintenanceFidelityScore`

How much important memory remains correct and available after lifecycle maintenance.

Formula:

`important_memories_preserved_after_maintenance / total_important_memories_checked_after_maintenance`

Target:

`>= 0.86`

## Overall Score

Each metric contributes equally to the overall score for now. The weighted metric score is the average of all per-metric normalized scores, multiplied by `100`.

For metrics where higher is better:

`normalized = min(actual / target, 1)`

For metrics where lower is better:

`normalized = 1` when `actual <= target`, otherwise `target / actual`

Overall score:

`overallScore = average(normalized_metrics) * 100`

## Pass / Fail

The suite passes only if **all** threshold metrics pass.

This is intentionally strict. A memory system is only as safe as its weakest major behavior.

## Score Interpretation

- `95-100`: elite memory behavior with strong evidence
- `90-94`: very strong, but still has a few meaningful edge weaknesses
- `80-89`: useful and serious, but not yet trustworthy enough for the hardest autonomous use cases
- `70-79`: capable memory platform, but still too error-prone or lossy in core behaviors
- `< 70`: significant memory-quality gaps remain

## Failure Interpretation

If a metric fails:

- `constraintRetentionRate` or `identityRetentionRate`: the system is forgetting durable high-value memory
- `updateCorrectnessRate` or `contradictionResolutionAccuracy`: the system is not safely handling change over time
- `falseMemoryRate`: the system is learning things it should not
- `trustedMemoryPrecision`: the system is surfacing weak or unsafe memory as durable truth
- `memoryIsolationAccuracy`: the system is leaking or misapplying memory across boundaries
- `postCompactionFidelityScore`: the compaction path is destroying important information
- `postMaintenanceFidelityScore`: lifecycle automation is too destructive

## Required Eval Behavior

The eval harness must:

- run deterministically
- produce structured JSON output
- expose per-scenario results
- support `--enforce`
- be able to fail on real regressions
