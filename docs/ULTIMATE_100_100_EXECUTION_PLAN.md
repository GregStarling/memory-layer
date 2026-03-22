# Ultimate 100/100 Execution Plan

This is the authoritative execution plan for turning `memory-layer` into a true 100/100 memory system for AI-heavy products: AI IDEs, autonomous agents, dark-factory runtimes, and hosted AI systems.

This plan is intentionally focused on **core memory quality**, not general product polish. The repo already has strong packaging, transport, and integration surfaces. The remaining gap is whether the system can:

- preserve important context over long-running workflows
- learn durable knowledge without corrupting it
- learn from successful and failed execution outcomes, not just conversation text
- distinguish trusted memory from merely relevant memory
- maintain correct memory inheritance and isolation across tasks, branches, runs, and shared workspaces
- recover the right memory at the right time
- prove all of the above with hard evals

## Source Of Truth

Use this file as the single source of truth for the next execution pass.

If future implementation decisions conflict with earlier broad plans, prefer this file.

## North Star

The finished system should satisfy all of these:

1. A developer can add memory to an existing AI system quickly.
2. Important constraints, preferences, identity, objectives, and project facts survive long-running sessions.
3. Durable knowledge is grounded in evidence, not summary artifacts.
4. Contradictions are explicit and safely handled.
5. Retrieval prefers trustworthy memory over merely recent or lexical matches.
6. Successful and failed strategies become learnable procedural memory without contaminating factual memory.
7. Memory inheritance across task, branch, run, workspace, and system scopes is useful and safe.
8. Defaults are safe enough for serious AI use.
9. The eval suite can prove long-horizon fidelity, update correctness, low false-memory rates, and safe workflow memory behavior.

## What 100/100 Means

The system only deserves a 100/100 label if it reaches all of these thresholds in practice:

- `constraintRetentionRate >= 0.92`
- `preferenceRetentionRate >= 0.90`
- `identityRetentionRate >= 0.95`
- `procedureRetentionRate >= 0.88`
- `updateCorrectnessRate >= 0.88`
- `strategyOutcomeRecallRate >= 0.85`
- `falseMemoryRate <= 0.05`
- `contradictionResolutionAccuracy >= 0.85`
- `trustedMemoryPrecision >= 0.90`
- `trustedMemoryRecall >= 0.88`
- `memoryIsolationAccuracy >= 0.95`
- `provisionalLeakRate <= 0.08`
- `postCompactionFidelityScore >= 0.88`
- `postMaintenanceFidelityScore >= 0.86`

Do not relax these thresholds unless there is strong evidence they are unrealistic for the problem domain.

## Execution Principles

1. Optimize for memory correctness before convenience.
2. Promote durable memory only from grounded evidence.
3. Treat the system as skeptical by default.
4. Separate trusted core memory from task relevance.
5. Add quality gates before adding more platform surface.
6. Do not mark a phase complete until its eval deltas pass.
7. Maintain parity across `memory`, `sqlite`, and `postgres` adapters.

## Anti-Goals

Do not spend major cycles on these until the quality phases are complete:

- new transport surfaces
- more framework adapters
- more release polish
- more docs/examples unrelated to memory quality
- lightweight retrieval tuning without trust-state changes

## Versioning And Migration Plan

- Phase 0: no schema bump
- Phase 1: `schema_meta.version = 5`
- Phase 2: `schema_meta.version = 6`
- Phase 3: no schema bump unless implementation forces one
- Phase 4: no schema bump unless implementation forces one
- Phase 5: `schema_meta.version = 8`
- Phase 6: no schema bump
- Phase 7: no schema bump

`schema_meta.version = 7` is intentionally reserved if context-assembly persistence changes require it during implementation.

## Universal Definition Of Done

Each task is only complete when all of the following are true:

- implementation is complete
- relevant tests are added or updated
- eval impact is noted
- no adapter parity gap remains
- no schema change is undocumented
- TypeScript passes
- phase-level acceptance criteria still pass

## Phase 0: Baseline And Quality Gate

### Objective

Build a memory-quality harness that can measure real gains or regressions.

### Deliverables

- `docs/MEMORY_QUALITY_RUBRIC.md`
- `docs/MEMORY_QUALITY_BASELINE.md`
- `evals/memory-quality/index.mjs`
- `evals/memory-quality/retention.mjs`
- `evals/memory-quality/contradictions.mjs`
- `evals/memory-quality/fidelity.mjs`
- `evals/memory-quality/false-memory.mjs`
- `evals/memory-quality/long-horizon.mjs`
- CI gate via `.github/workflows/ci.yml`

### Task Board

- [x] `ml-p0-t1` Define the memory-quality rubric
- [x] `ml-p0-t2` Build the shared eval harness
- [x] `ml-p0-t3` Add retention eval scenarios
- [x] `ml-p0-t4` Add contradiction and update eval scenarios
- [x] `ml-p0-t5` Add false-memory and fidelity eval scenarios
- [x] `ml-p0-t6` Add long-horizon eval scenarios
- [x] `ml-p0-t7` Wire scripts and CI gate
- [x] `ml-p0-t8` Capture the current baseline

### Exact Task Specs

#### `ml-p0-t1` Define the memory-quality rubric

Files:
- `docs/MEMORY_QUALITY_RUBRIC.md`

Acceptance:
- defines every metric, threshold, formula, and failure meaning
- defines the overall score formula
- defines what score bands mean

Recommended commit:
- `docs: define memory quality rubric`

#### `ml-p0-t2` Build the shared eval harness

Files:
- `evals/memory-quality/index.mjs`

Eval output contract:

```ts
interface MemoryQualityEvalSummary {
  overallScore: number;
  passed: boolean;
  metrics: {
    constraintRetentionRate: number;
    preferenceRetentionRate: number;
    identityRetentionRate: number;
    procedureRetentionRate: number;
    updateCorrectnessRate: number;
    strategyOutcomeRecallRate: number;
    falseMemoryRate: number;
    contradictionResolutionAccuracy: number;
    trustedMemoryPrecision: number;
    trustedMemoryRecall: number;
    memoryIsolationAccuracy: number;
    provisionalLeakRate: number;
    postCompactionFidelityScore: number;
    postMaintenanceFidelityScore: number;
  };
  scenarios: Array<{
    name: string;
    passed: boolean;
    detail: Record<string, unknown>;
  }>;
}
```

Acceptance:
- emits the contract above
- supports `--enforce`
- supports scenario aggregation

Recommended commit:
- `feat: add shared memory quality eval harness`

#### `ml-p0-t3` Add retention eval scenarios

Files:
- `evals/memory-quality/retention.mjs`

Acceptance:
- measures identity, preference, constraint, and objective retention
- measures procedure and strategy retention where applicable
- spans multi-turn, post-compaction, and delayed-recall cases

Recommended commit:
- `feat: add retention memory quality evals`

#### `ml-p0-t4` Add contradiction and update eval scenarios

Files:
- `evals/memory-quality/contradictions.mjs`

Acceptance:
- measures update correctness
- measures contradiction resolution accuracy
- includes reversals and slot updates

Recommended commit:
- `feat: add contradiction and update evals`

#### `ml-p0-t5` Add false-memory and fidelity eval scenarios

Files:
- `evals/memory-quality/false-memory.mjs`
- `evals/memory-quality/fidelity.mjs`

Acceptance:
- catches summary distortion
- catches unsupported assistant speculation
- catches summary-only durable promotion

Recommended commit:
- `feat: add false-memory and fidelity evals`

#### `ml-p0-t6` Add long-horizon eval scenarios

Files:
- `evals/memory-quality/long-horizon.mjs`

Acceptance:
- covers 50-100+ turn sessions
- includes multiple compactions
- includes maintenance after idle periods
- includes branch/task/run handoffs with both valid inheritance and required isolation
- includes successful and failed execution outcomes that should shape procedural memory

Recommended commit:
- `feat: add long-horizon memory evals`

#### `ml-p0-t7` Wire scripts and CI gate

Files:
- `package.json`
- `.github/workflows/ci.yml`

Scripts to add:

```json
{
  "scripts": {
    "eval:memory-quality": "npm run build && node evals/memory-quality/index.mjs",
    "eval:memory-quality:enforce": "npm run build && node evals/memory-quality/index.mjs --enforce"
  }
}
```

Acceptance:
- CI fails on memory-quality threshold misses
- local scripts are documented and runnable

Recommended commit:
- `chore: enforce memory quality evals in ci`

#### `ml-p0-t8` Capture the current baseline

Files:
- `docs/MEMORY_QUALITY_BASELINE.md`

Acceptance:
- baseline numbers are checked in
- narrative identifies the largest loss areas

Recommended commit:
- `docs: capture memory quality baseline`

### Phase 0 Acceptance Tests

Add:
- `src/__tests__/memory-quality-harness.test.ts`

Must verify:
- eval harness returns the expected contract
- `--enforce` exits non-zero on failure
- at least one deliberately broken scenario fails

### Phase 0 Exit Criteria

- eval harness exists
- CI enforces it
- baseline is captured

## Phase 1: Evidence-Grounded Knowledge Formation

### Objective

Prevent trusted durable knowledge from being created from summary text alone.

### Deliverables

- candidate and evidence data model
- storage APIs for candidates/evidence
- grounded extraction pipeline
- evidence-backed promotion

### Task Board

- [x] `ml-p1-t1` Add candidate and evidence domain types
- [x] `ml-p1-t2` Extend storage contracts for candidates and evidence
- [x] `ml-p1-t3` Add SQLite schema v5 for grounded knowledge
- [x] `ml-p1-t4` Implement SQLite adapter support for candidates and evidence
- [x] `ml-p1-t5` Implement in-memory adapter parity
- [x] `ml-p1-t6` Implement Postgres adapter parity
- [x] `ml-p1-t7` Create raw-turn grounding engine
- [x] `ml-p1-t8` Split candidate generation from promotion
- [x] `ml-p1-t9` Persist evidence on promotion
- [x] `ml-p1-t10` Add grounding and evidence tests
- [x] `ml-p1-t11` Update evals to punish ungrounded promotion

### Exact API Additions

In `src/contracts/types.ts` add:

```ts
export type KnowledgeState =
  | 'candidate'
  | 'provisional'
  | 'trusted'
  | 'disputed'
  | 'superseded'
  | 'retired';

export type KnowledgeClass =
  | 'identity'
  | 'preference'
  | 'constraint'
  | 'procedure'
  | 'strategy'
  | 'anti_pattern'
  | 'project_fact'
  | 'episodic_fact';

export type EvidenceSourceType =
  | 'user_turn'
  | 'assistant_turn'
  | 'system_turn'
  | 'tool_output'
  | 'execution_result'
  | 'human_feedback'
  | 'working_memory_summary'
  | 'manual'
  | 'imported';

export type GroundingStrength = 'weak' | 'moderate' | 'strong' | 'tool_verified';
```

Add:

```ts
export interface KnowledgeCandidate extends NormalizedMemoryScope {
  id: number;
  working_memory_id: number;
  fact: string;
  fact_type: FactType;
  knowledge_class: KnowledgeClass;
  normalized_fact: string;
  slot_key: string | null;
  confidence: FactConfidence;
  source_summary: boolean;
  source_turns: boolean;
  grounding_strength: GroundingStrength;
  evidence_count: number;
  trust_score: number;
  state: 'candidate' | 'provisional';
  created_at: number;
  promoted_knowledge_id: number | null;
}

export interface KnowledgeEvidence extends NormalizedMemoryScope {
  id: number;
  knowledge_memory_id: number | null;
  knowledge_candidate_id: number | null;
  working_memory_id: number | null;
  turn_id: number | null;
  source_type: EvidenceSourceType;
  support_polarity: 'supports' | 'contradicts';
  speaker_role: TurnRole | null;
  actor: string | null;
  excerpt: string;
  start_offset: number | null;
  end_offset: number | null;
  is_explicit: boolean;
  explicitness_score: number;
  outcome: 'success' | 'failure' | 'neutral' | null;
  created_at: number;
}
```

Extend `KnowledgeMemory` with:

```ts
knowledge_state: KnowledgeState;
knowledge_class: KnowledgeClass;
grounding_strength: GroundingStrength;
evidence_count: number;
trust_score: number;
last_verified_at: number | null;
successful_use_count: number;
failed_use_count: number;
```

In `src/contracts/storage.ts` and `src/contracts/async-storage.ts` add:

```ts
insertKnowledgeCandidate(input: NewKnowledgeCandidate): KnowledgeCandidate;
insertKnowledgeCandidates(inputs: NewKnowledgeCandidate[]): KnowledgeCandidate[];
getKnowledgeCandidateById(id: number): KnowledgeCandidate | null;
listKnowledgeCandidates(scope: MemoryScope, options?: { state?: string[] }): KnowledgeCandidate[];

insertKnowledgeEvidence(input: NewKnowledgeEvidence): KnowledgeEvidence;
insertKnowledgeEvidenceBatch(inputs: NewKnowledgeEvidence[]): KnowledgeEvidence[];
listKnowledgeEvidenceForKnowledge(knowledgeId: number): KnowledgeEvidence[];
listKnowledgeEvidenceForCandidate(candidateId: number): KnowledgeEvidence[];

promoteKnowledgeCandidate(candidateId: number, input: NewKnowledgeMemory): KnowledgeMemory;
```

### Exact Schema Diff

Set `CURRENT_SCHEMA_VERSION = 5`.

In `src/adapters/sqlite/schema.ts` add:

```sql
ALTER TABLE knowledge_memory ADD COLUMN knowledge_state TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE knowledge_memory ADD COLUMN knowledge_class TEXT NOT NULL DEFAULT 'project_fact';
ALTER TABLE knowledge_memory ADD COLUMN grounding_strength TEXT NOT NULL DEFAULT 'moderate';
ALTER TABLE knowledge_memory ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN trust_score REAL NOT NULL DEFAULT 0.7;
ALTER TABLE knowledge_memory ADD COLUMN last_verified_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN successful_use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN failed_use_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE knowledge_candidate (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT,
  scope_id TEXT NOT NULL,
  working_memory_id INTEGER NOT NULL,
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  knowledge_class TEXT NOT NULL,
  normalized_fact TEXT NOT NULL,
  slot_key TEXT,
  confidence TEXT NOT NULL,
  source_summary INTEGER NOT NULL DEFAULT 0,
  source_turns INTEGER NOT NULL DEFAULT 1,
  grounding_strength TEXT NOT NULL DEFAULT 'weak',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  trust_score REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'candidate',
  promoted_knowledge_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (working_memory_id) REFERENCES working_memory(id) ON DELETE CASCADE,
  FOREIGN KEY (promoted_knowledge_id) REFERENCES knowledge_memory(id) ON DELETE SET NULL
);

CREATE TABLE knowledge_evidence (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  workspace_id TEXT,
  scope_id TEXT NOT NULL,
  knowledge_memory_id INTEGER,
  knowledge_candidate_id INTEGER,
  working_memory_id INTEGER,
  turn_id INTEGER,
  source_type TEXT NOT NULL,
  support_polarity TEXT NOT NULL,
  speaker_role TEXT,
  actor TEXT,
  excerpt TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  is_explicit INTEGER NOT NULL DEFAULT 0,
  explicitness_score REAL NOT NULL DEFAULT 0,
  outcome TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (knowledge_memory_id) REFERENCES knowledge_memory(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_candidate_id) REFERENCES knowledge_candidate(id) ON DELETE CASCADE,
  FOREIGN KEY (working_memory_id) REFERENCES working_memory(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);
```

Add indexes:

```sql
CREATE INDEX idx_kc_scope_state_created
  ON knowledge_candidate(tenant_id, system_id, workspace_id, scope_id, state, created_at DESC);

CREATE INDEX idx_ke_knowledge_memory
  ON knowledge_evidence(knowledge_memory_id, created_at DESC);

CREATE INDEX idx_ke_candidate
  ON knowledge_evidence(knowledge_candidate_id, created_at DESC);
```

### Migration Backfill Rules

- old `knowledge_memory` rows become `knowledge_state = 'trusted'`
- `knowledge_class` derives from `fact_type`
- `grounding_strength` derives from verification status and source-turn count
- `evidence_count = max(1, source_turn_ids.length)`
- `trust_score` derives from `confidence_score` if present, otherwise from a deterministic fallback
- `successful_use_count = 0`
- `failed_use_count = 0`

### Phase 1 Acceptance Tests

Add:
- `src/__tests__/knowledge-grounding.test.ts`
- `src/__tests__/knowledge-evidence.test.ts`

Must cover:
- fact present in turns but missing from summary
- summary-invented fact not becoming trusted
- evidence rows attached to promoted knowledge
- successful and failed execution outcomes are preserved as evidence where present
- adapter parity for candidate/evidence flows

### Phase 1 Exit Criteria

- no trusted knowledge without evidence
- false-memory metric improves

## Phase 2: Trust Model And Contradiction State Machine

### Objective

Make trusted memory hard to earn and explicit to challenge.

### Task Board

- [x] `ml-p2-t1` Add trust and conflict types
- [x] `ml-p2-t2` Extend extraction policy with trust thresholds
- [x] `ml-p2-t3` Add SQLite schema v6 for dispute and supersession state
- [x] `ml-p2-t4` Implement adapter parity for dispute state
- [x] `ml-p2-t5` Create trust engine module
- [x] `ml-p2-t6` Route orchestrator promotion through trust state machine
- [x] `ml-p2-t7` Add knowledge inspection and reverification APIs
- [x] `ml-p2-t8` Add trust and contradiction tests
- [x] `ml-p2-t9` Tighten evals for trust precision
- [x] `ml-p2-t10` Add source-credibility and outcome-learning trust rules

### Exact API Additions

In `src/contracts/types.ts` add:

```ts
export type KnowledgeDecision =
  | 'promote_candidate'
  | 'keep_provisional'
  | 'reject_candidate'
  | 'mark_disputed'
  | 'supersede_existing';

export interface KnowledgeTrustAssessment {
  trust_score: number;
  state: KnowledgeState;
  decision: KnowledgeDecision;
  reasons: string[];
}

export interface KnowledgeConflict {
  existing_knowledge_id: number;
  candidate_id: number | null;
  relation: 'duplicate' | 'update' | 'conflict' | 'compatible';
  severity: 'low' | 'medium' | 'high';
  resolution: 'ignore' | 'dispute' | 'supersede';
}
```

Extend `KnowledgeMemory` with:

```ts
disputed_at: number | null;
dispute_reason: string | null;
contradiction_score: number;
superseded_at: number | null;
```

In `src/contracts/policy.ts` extend `ExtractionPolicy`:

```ts
requireGroundingForTrusted?: boolean;
minimumEvidenceCountForTrusted?: number;
assistantClaimPenalty?: number;
toolEvidenceBoost?: number;
explicitStatementBoost?: number;
contradictionDisputeThreshold?: number;
trustPromotionThreshold?: number;
trustProvisionalThreshold?: number;
humanFeedbackBoost?: number;
executionSuccessBoost?: number;
executionFailurePenalty?: number;
```

Default values:

```ts
requireGroundingForTrusted: true
minimumEvidenceCountForTrusted: 2
assistantClaimPenalty: 0.15
toolEvidenceBoost: 0.2
explicitStatementBoost: 0.1
contradictionDisputeThreshold: 0.35
trustPromotionThreshold: 0.7
trustProvisionalThreshold: 0.45
humanFeedbackBoost: 0.2
executionSuccessBoost: 0.15
executionFailurePenalty: 0.2
```

In `MemoryManager` add:

```ts
inspectKnowledge(id: number): Promise<{
  knowledge: KnowledgeMemory | null;
  evidence: KnowledgeEvidence[];
  audits: KnowledgeMemoryAudit[];
}>;

reverifyKnowledge(id: number): Promise<KnowledgeTrustAssessment>;
```

### Exact Schema Diff

Set `CURRENT_SCHEMA_VERSION = 6`.

Add:

```sql
ALTER TABLE knowledge_memory ADD COLUMN disputed_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN dispute_reason TEXT;
ALTER TABLE knowledge_memory ADD COLUMN contradiction_score REAL NOT NULL DEFAULT 0;
ALTER TABLE knowledge_memory ADD COLUMN superseded_at INTEGER;

CREATE INDEX idx_km_state_trust_class
  ON knowledge_memory(tenant_id, system_id, workspace_id, scope_id, knowledge_state, trust_score DESC, knowledge_class);
```

### Core Files

- `src/core/trust.ts` (new)
- `src/core/orchestrator.ts`
- `src/core/manager.ts`

### Phase 2 Acceptance Tests

Add:
- `src/__tests__/knowledge-trust.test.ts`
- `src/__tests__/contradictions.test.ts`

Must cover:
- weak single statement stays provisional
- repeated explicit preference becomes trusted
- unsupported assistant claim does not become trusted
- contradiction marks prior fact disputed
- stronger replacement evidence supersedes correctly
- successful repeatedly confirmed strategy becomes trusted procedure/strategy memory
- failed strategy can be retained as `anti_pattern` without surfacing as a positive recommendation
- inspect API returns evidence and audits

### Phase 2 Exit Criteria

- trusted precision improves
- provisional leak rate drops
- contradiction accuracy improves
- strategy outcome recall improves

### Plan Amendments

The original Phase 2 plan defined new dispute and contradiction fields on `knowledge_memory`, but it did not define any adapter mutation API for updating those fields after a record already exists.

That is a structural gap. A trust state machine needs explicit storage support to:

- mark existing knowledge as disputed
- update trust score and trust state after reverification
- record supersession timestamps and dispute metadata
- update successful and failed use counters

Add the following adapter capability as part of Phase 2 implementation:

```ts
updateKnowledgeMemory(id: number, patch: {
  knowledge_state?: KnowledgeState;
  knowledge_class?: KnowledgeClass;
  trust_score?: number;
  verification_status?: VerificationStatus;
  verification_notes?: string | null;
  last_verified_at?: number | null;
  disputed_at?: number | null;
  dispute_reason?: string | null;
  contradiction_score?: number;
  superseded_at?: number | null;
  successful_use_count?: number;
  failed_use_count?: number;
}): Promise<KnowledgeMemory | null>;
```

For sync adapters, add the equivalent sync method to `StorageAdapter`.

## Phase 3: Trusted Core Memory In Context Assembly

### Objective

Create a stable trusted memory layer distinct from task relevance.

### Task Board

- [x] `ml-p3-t1` Extend memory context shape
- [x] `ml-p3-t2` Implement trusted core memory selector
- [x] `ml-p3-t3` Implement task-relevant knowledge selector
- [x] `ml-p3-t4` Rewire compatibility fields safely
- [x] `ml-p3-t5` Redesign formatter layout around trust buckets
- [x] `ml-p3-t6` Extend runtime input with diagnostic controls
- [x] `ml-p3-t7` Enrich selection reasons
- [x] `ml-p3-t8` Add core-memory and formatter tests
- [x] `ml-p3-t9` Update evals for stable core recall

### Exact API Additions

Extend `MemoryContext`:

```ts
trustedCoreMemory: KnowledgeMemory[];
taskRelevantKnowledge: KnowledgeMemory[];
provisionalKnowledge: KnowledgeMemory[];
disputedKnowledge: KnowledgeMemory[];
```

Keep for compatibility:

```ts
relevantKnowledge: KnowledgeMemory[];
durableKnowledge: KnowledgeMemory[];
```

but redefine:

- `relevantKnowledge = trustedCoreMemory + taskRelevantKnowledge`
- `durableKnowledge = trustedCoreMemory`

Extend `KnowledgeSelectionReason`:

```ts
bucket: 'trusted_core' | 'task_relevant' | 'provisional' | 'disputed';
trustScore: number;
classImportanceScore: number;
finalScore: number;
explanation: string;
```

Extend `FormatOptions`:

```ts
includeProvisionalKnowledge?: boolean;
includeDisputedKnowledge?: boolean;
includeEvidenceMarkers?: boolean;
```

Extend `BeforeModelCallInput`:

```ts
includeProvisionalKnowledge?: boolean;
includeDisputedKnowledge?: boolean;
```

### Core Files

- `src/core/context.ts`
- `src/core/formatter.ts`
- `src/core/runtime.ts`

### Phase 3 Acceptance Tests

Add:
- `src/__tests__/core-memory-selection.test.ts`
- `src/__tests__/formatter-trust-layout.test.ts`

Must cover:
- trusted constraints remain stable across weakly related prompts
- provisional items are hidden by default
- disputed items only appear when requested
- trusted strategies can appear in task-relevant memory without displacing core identity/constraint memory
- compatibility fields still behave predictably

### Phase 3 Exit Criteria

- prompt memory is materially more stable
- durable memory is no longer just query-relevant memory

## Phase 4: Trust-Aware Retrieval And Ranking

### Objective

Make retrieval prefer trustworthy memory over weakly relevant memory.

### Task Board

- [x] `ml-p4-t1` Add trust-aware ranking policy fields
- [x] `ml-p4-t2` Implement class importance scoring
- [x] `ml-p4-t3` Refactor context ranking formula
- [x] `ml-p4-t4` Refactor search ranking formula
- [x] `ml-p4-t5` Add search filters for state, class, and trust
- [x] `ml-p4-t6` Tighten cross-scope trust rules
- [x] `ml-p4-t7` Add retrieval tests
- [x] `ml-p4-t8` Update evals for trusted precision and recall
- [x] `ml-p4-t9` Add lineage-aware retrieval and isolation rules

### Exact API Additions

Extend `ContextPolicy`:

```ts
trustWeight?: number;
durabilityWeight?: number;
evidenceWeight?: number;
contradictionPenalty?: number;
provisionalPenalty?: number;
objectiveLinkWeight?: number;
trustedCoreLimit?: number;
taskRelevantLimit?: number;
```

Suggested defaults:

```ts
trustWeight: 1.3
durabilityWeight: 0.8
evidenceWeight: 0.5
contradictionPenalty: 1.5
provisionalPenalty: 0.75
objectiveLinkWeight: 0.4
trustedCoreLimit: 8
taskRelevantLimit: 12
```

Extend `SearchOptions`:

```ts
includeProvisional?: boolean;
includeDisputed?: boolean;
minimumTrustScore?: number;
knowledgeStates?: KnowledgeState[];
knowledgeClasses?: KnowledgeClass[];
preferLocalTrusted?: boolean;
preferLineageMemory?: boolean;
```

### Ranking Formula

Use this in both context assembly and hybrid search:

```ts
finalScore =
  lexicalScore * lexicalWeight +
  semanticScore * semanticWeight +
  recencyScore * recencyWeight +
  trustScore * trustWeight +
  classImportanceScore * durabilityWeight +
  evidenceDensityScore * evidenceWeight +
  objectiveLinkScore * objectiveLinkWeight -
  contradictionScore * contradictionPenalty -
  provisionalPenaltyIfApplicable;
```

### Phase 4 Acceptance Tests

Add:
- `src/__tests__/trust-aware-retrieval.test.ts`
- `src/__tests__/cross-scope-trust.test.ts`

Must cover:
- trusted constraint outranks recent provisional fact
- provisional facts are filtered by default
- disputed facts are filtered by default
- local trusted memory outranks cross-scope memory when scores are close
- parent-task or parent-branch lineage memory can be inherited without leaking unrelated sibling memory

### Phase 4 Exit Criteria

- trusted precision and recall improve
- ambiguous retrieval becomes safer
- isolation accuracy improves in lineage and cross-scope evals

### Plan Amendments

The original plan covers `memoryIsolationAccuracy` well in Phase 4 through cross-scope trust rules, lineage-aware retrieval, and isolation-focused evals.

However, implementation and eval results after Phase 3 show that `postCompactionFidelityScore` remains a first-order blocker and is not addressed explicitly enough by the existing next phases. It appears only as an eval target, not as a concrete implementation stream.

Before continuing, add an explicit compaction-fidelity workstream to the next execution phase:

- preserve trusted constraints, preferences, and identity facts even when summaries are lossy
- score candidate extraction against raw-turn coverage for critical slots before retiring context
- allow compaction outputs to carry forward protected facts or protected slot summaries
- add tests for multi-compaction survival of critical constraints versus secondary details
- update the fidelity eval to verify that trusted core facts survive compaction even when summaries omit them

This amendment is necessary because a 100/100 memory system cannot rely on retrieval/ranking alone if critical memory is already lost during compaction.

## Phase 5: Importance-Aware Lifecycle And Reverification

### Objective

Preserve important trusted memory and decay weak memory aggressively.

### Task Board

- [x] `ml-p5-t1` Extend maintenance policy for trust-aware lifecycle
- [x] `ml-p5-t2` Add SQLite schema v8 for reverification metadata
- [x] `ml-p5-t3` Implement adapter parity for reverification fields
- [x] `ml-p5-t4` Build lifecycle engine
- [x] `ml-p5-t5` Integrate lifecycle engine into maintenance flow
- [x] `ml-p5-t6` Add manager-level reverification entrypoint
- [x] `ml-p5-t7` Add lifecycle and reverification tests
- [x] `ml-p5-t8` Update evals for post-maintenance fidelity

### Exact API Additions

Extend `MaintenancePolicy`:

```ts
trustedCoreRetentionDays?: number;
provisionalRetentionDays?: number;
disputedRetentionDays?: number;
reverificationCadenceDays?: number;
classRetentionOverrides?: Partial<Record<KnowledgeClass, number>>;
requireReconfirmationForProjectFacts?: boolean;
preserveEvidenceForTrustedKnowledge?: boolean;
```

Suggested defaults:

```ts
trustedCoreRetentionDays: 365
provisionalRetentionDays: 14
disputedRetentionDays: 90
reverificationCadenceDays: 30
requireReconfirmationForProjectFacts: true
preserveEvidenceForTrustedKnowledge: true
classRetentionOverrides: {
  identity: 3650,
  preference: 365,
  constraint: 365,
  procedure: 180,
  strategy: 180,
  anti_pattern: 365,
  project_fact: 90,
  episodic_fact: 14
}
```

Extend `MaintenanceReport`:

```ts
reverifiedKnowledgeIds: number[];
demotedKnowledgeIds: number[];
expiredCandidateIds: number[];
```

Optionally add:

```ts
runReverification(options?: { limit?: number }): Promise<{
  reverifiedKnowledgeIds: number[];
  demotedKnowledgeIds: number[];
}>;
```

### Exact Schema Diff

Set `CURRENT_SCHEMA_VERSION = 8`.

Add:

```sql
ALTER TABLE knowledge_memory ADD COLUMN next_reverification_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN last_confirmed_at INTEGER;
ALTER TABLE knowledge_memory ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_km_reverify
  ON knowledge_memory(knowledge_state, next_reverification_at, knowledge_class, trust_score DESC);
```

### Core Files

- `src/core/knowledge-lifecycle.ts` (new)
- `src/core/maintenance.ts`
- `src/core/manager.ts`

### Phase 5 Acceptance Tests

Add:
- `src/__tests__/lifecycle-by-class.test.ts`
- `src/__tests__/reverification.test.ts`

Must cover:
- trusted identity survives maintenance
- provisional one-off fact expires
- stale project fact can be demoted
- successful strategies survive longer than weak episodic facts
- anti-pattern memories are retained conservatively when repeatedly validated by failures
- evidence rows survive trusted-memory cleanup flows

### Phase 5 Exit Criteria

- post-maintenance fidelity improves
- important trusted memory survives much longer than weak memory
- useful procedural and anti-pattern memory survives long enough to help autonomous systems learn

## Phase 6: Quality Modes And Safer Defaults

### Objective

Expose fidelity as a first-class product choice and make the recommended path safer.

### Task Board

- [x] `ml-p6-t1` Add explicit quality-mode API
- [x] `ml-p6-t2` Map quality modes to actual engine behavior
- [x] `ml-p6-t3` Add compatibility bridge from old quality settings
- [x] `ml-p6-t4` Make the recommended default safer
- [x] `ml-p6-t5` Add quality-mode tests
- [x] `ml-p6-t6` Update eval reporting by quality mode

### Exact API Additions

Add:

```ts
export type MemoryQualityMode =
  | 'fast_adoption'
  | 'balanced_memory'
  | 'high_fidelity_memory';
```

Extend `CreateMemoryOptions`:

```ts
qualityMode?: MemoryQualityMode;
```

Compatibility rules:

- keep `qualityTier` temporarily
- map:
  - `offline_default -> fast_adoption`
  - `local_semantic -> balanced_memory`
  - `provider_backed -> high_fidelity_memory` only when grounding/trust features are enabled

### Mode Requirements

`fast_adoption`
- easiest startup path
- weakest trust guarantees

`balanced_memory`
- recommended default
- grounded promotion enabled
- trust-aware retrieval enabled
- safer maintenance defaults

`high_fidelity_memory`
- strictest trust thresholds
- strongest contradiction handling
- safest prompt assembly defaults

### Phase 6 Acceptance Tests

Add:
- `src/__tests__/quality-modes.test.ts`

Must cover:
- same session yields different trust outcomes across modes
- balanced mode beats fast mode on false-memory scenarios
- high-fidelity mode retains constraints best
- high-fidelity mode handles strategy/anti-pattern learning and lineage isolation most safely

### Phase 6 Exit Criteria

- fidelity is explicit and predictable
- the recommended path is no longer the lowest-fidelity one

## Phase 7: Final Hard Gate

### Objective

Make memory quality a permanent release blocker.

### Task Board

- [x] `ml-p7-t1` Lock final thresholds in eval harness
- [x] `ml-p7-t2` Make CI block on memory quality permanently
- [x] `ml-p7-t3` Add baseline delta reporting
- [x] `ml-p7-t4` Publish final score interpretation docs
- [x] `ml-p7-t5` Run final audit and close remaining gaps

### Final Thresholds

- `constraintRetentionRate >= 0.92`
- `preferenceRetentionRate >= 0.90`
- `identityRetentionRate >= 0.95`
- `updateCorrectnessRate >= 0.88`
- `falseMemoryRate <= 0.05`
- `contradictionResolutionAccuracy >= 0.85`
- `trustedMemoryPrecision >= 0.90`
- `trustedMemoryRecall >= 0.88`
- `provisionalLeakRate <= 0.08`
- `postCompactionFidelityScore >= 0.88`
- `postMaintenanceFidelityScore >= 0.86`

### Required Eval Scenarios

- 100-turn AI IDE session
- 100-turn autonomous task runner session
- repeated preference reversals
- evolving project constraints
- assistant speculation that must not become trusted
- tool-verified facts overriding prior beliefs
- successful and failed strategy learning across repeated tasks
- branch/task/run lineage handoff with sibling isolation
- cross-scope retrieval with dangerous overlaps
- maintenance after long idle period
- multiple compactions before recall
- competing slot updates over time

### Phase 7 Acceptance Tests

The hard gate is the eval suite itself. Add unit coverage only if needed for eval contract shape.

### Phase 7 Exit Criteria

- thresholds pass in CI
- release flow blocks on quality regressions
- score claims are fully evidence-backed

### Plan Amendments

The original seven phases materially improved the engine and platform, but a final audit still exposed five finish-line gaps that can prevent an honest 100/100 claim even when the prior gates are green:

- ranking and trust behavior still depends on hidden constants instead of explicit policy in some paths
- the strongest scalable semantic path still has an ANN and adapter-parity ceiling
- contradiction logic is strong, but the operational proof for long-running autonomous and multi-agent behavior was still thinner than the claim
- Node, HTTP, MCP, CLI, Python, docs, and package metadata were close but not yet reconciled to one final product contract
- proof artifacts could still tell a stale or partial story even when current live evals pass

Add the following finish-pass work before calling the repo 100/100:

1. Make retrieval and trust fully policy-driven.
   - remove or externalize hidden ranking/trust constants
   - ensure policy fields actually control scoring outcomes across context assembly and search
   - add proof tests that fail when policy knobs are ignored
2. Close or honestly redefine the semantic/ANN ceiling.
   - implement the strongest real ANN-backed path available
   - align semantic scoring behavior across search and context assembly
   - make the local/no-provider contract explicit if it remains weaker than provider-backed mode
3. Add operational contradiction and coordination proof.
   - extend evals to long-horizon autonomous and multi-agent scenarios
   - document the deployment/concurrency contract for SQLite and Postgres clearly
   - implement any missing writer-safety fix revealed by those evals
4. Reconcile all product surfaces.
   - eliminate placeholder metadata
   - document one authoritative cross-surface contract for Node, HTTP, MCP, CLI, Python, and package exports
5. Refresh proof artifacts and gate alignment.
   - update stale baseline/proof files so delta reporting anchors to a known-good release state
   - ensure release gates, docs, and proof artifacts all describe the same finish line

This amendment is necessary because a repo is not 100/100 merely because the original phase list is complete. It is 100/100 only when the implementation, public contract, and proof artifacts all agree on the same claimed quality bar.

## Recommended Build Order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7

Do not reorder. The phases build on one another.

## Highest-Leverage Starting Tasks

Start with these if you want the fastest path to real score movement:

1. `ml-p0-t3`
2. `ml-p0-t4`
3. `ml-p0-t5`
4. `ml-p0-t6`
5. `ml-p1-t7`
6. `ml-p1-t8`
7. `ml-p1-t9`
8. `ml-p1-t10`
9. `ml-p2-t5`
10. `ml-p2-t6`

## Commit Discipline

Do not bundle an entire phase into one commit.

Recommended cadence:
- 1-2 commits for small tasks
- 2-4 commits for schema + adapter tasks
- 2-3 commits for algorithmic tasks
- 1 commit for tests
- 1 commit for eval updates

## Final Note

This plan is deliberately narrow and unforgiving because the failure mode to avoid is obvious now: building more software without materially improving memory quality.

The repo only gets to call itself 100/100 when these phases are implemented and the hard eval thresholds pass.
