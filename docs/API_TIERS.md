# API tiers & taxonomy map

This document is the map of the public `ai-memory-layer` surface (`src/index.ts`)
and of the three overlapping vocabularies the library uses to describe memory.
It was introduced in **Phase 6.5** as part of the 5.0.0 API-surface diet.

> Compatibility note (D-BREAK): 5.0.0 is a breaking major, but every symbol an
> in-repo test / eval / example imports stays exported. The green test suite is
> the back-compat proof. Only symbols with **zero** in-repo usage that are clearly
> internal plumbing are candidates for removal, and only one such symbol was cut
> in 6.5 (see [Removed](#removed-in-65)).

## The tiers

The barrel is organized into three commented tiers. Tier placement is about
**how often you reach for a symbol**, not about whether it is deprecated —
deprecation is an orthogonal, per-symbol flag.

### Tier 1 — Core daily API

The ~15 symbols almost every consumer touches.

| Symbol | Kind | Purpose |
| --- | --- | --- |
| `createMemory` / `createMemoryWithAsyncAdapter` | fn | Build a manager from a sync or async adapter. |
| `resolveEffectiveConfig` | fn | Inspect the fully-merged config + per-field provenance without building. |
| `createMemoryManager` | fn | Low-level manager factory (bring your own adapter/summarizer). |
| `createMemoryRuntime` | fn | Runtime wrapper for the before/after model-call lifecycle. |
| `createSQLiteAdapter(WithEmbeddings)` | fn | First-class durable adapter. |
| `createInMemoryAdapter(WithEmbeddings)` | fn | First-class ephemeral adapter. |
| `MemoryManager`, `MemoryManagerConfig` | type | The manager and its config shape. |
| `CreateMemoryOptions`, `CreateMemoryAsyncOptions` | type | Options for the quick factories. |
| `MemoryQualityMode` | type | Canonical fidelity profile selector. |
| `EffectiveManagerConfig`, `ConfigFieldSource`, `EffectiveConfigField` | type | Return types of `resolveEffectiveConfig`. |
| `MemoryScope` | type | The tenant/system/scope addressing key. |
| `Turn`, `KnowledgeMemory`, `WorkItem`, `SearchResult`, `SearchOptions` | type | Load-bearing domain records. |

### Tier 2 — Capabilities, contracts, integrations, providers

Everything you reach for once you go past the happy path: presets and
provider-configured managers; context assembly / formatting / monitoring; the
cognitive overlay and episodic recall; profiles; the knowledge lifecycle
(maintenance, reflection, discovery, derivation, curation, aliases, clusters,
bundles); the full contract surface (identity, governance, storage, coordination,
temporal, errors, observability, policy, embeddings) and domain type vocabulary;
framework/provider integrations (Claude, OpenAI, LangChain, Vercel AI, MCP,
middleware); the server transports; and the summarizer/extractor/embedding
providers.

### Tier 3 — Advanced / low-level building blocks (6.0.0 removal candidates)

Powerful but rarely imported directly — the primitives the higher tiers are
built from. These are the audit list for the next breaking major (6.0.0):
token estimators (`estimateTokens`, `createModelTokenEstimator`,
`createTiktokenEstimator`, `createSessionId`), the event emitter, `createMemorySync`,
the circuit breaker, orchestrator internals (`compactTurns`, `commitCompaction`,
`promoteToKnowledge`, `extractKnowledge`), extractor internals, streaming
primitives, `wrapSyncAdapter`, embedding-resilience wrappers, and the
summarizer/extractor prompt scaffolding.

They remain exported this major (D-BREAK) because in-repo evals/examples/tests
import several of them (`compactTurns`, `extractKnowledge`, `createStreamCollector`,
`wrapSyncAdapter`, `createRegexExtractor`, `createModelTokenEstimator`, …). Grep
before cutting any of them in 6.0.0.

### Removed in 6.5

- `estimateTokensLocal` — a redundant re-export alias of `estimateTokens` with
  **zero** usage anywhere in the repo (`git grep estimateTokensLocal` matched only
  the alias line itself). `estimateTokens` stays exported (Tier 3).

### Deprecated in 6.5

- `CreateMemoryOptions.qualityTier` — see [Quality profiles](#quality-profiles-qualitymode-vs-qualitytier).
  Still accepted this major; removed in 6.0.0.

## Quality profiles: `qualityMode` vs `qualityTier`

Two option fields historically selected memory fidelity, and they overlapped.
6.5 makes **`qualityMode` the canonical named profile** and deprecates
`qualityTier`.

- `qualityMode: 'fast_adoption' | 'balanced_memory' | 'high_fidelity_memory'` —
  the named profile. Drives `QUALITY_MODE_CONFIG`, which layers extraction /
  context / maintenance policy over the workload preset.
- `qualityTier: 'offline_default' | 'local_semantic' | 'provider_backed'`
  **(@deprecated)** — the legacy field conflated fidelity with the
  storage/embedding *capability* tier. It is still accepted, is mapped onto the
  equivalent `qualityMode` (`offline_default`/`local_semantic` → `balanced_memory`,
  `provider_backed` → `high_fidelity_memory`), and still steers the local-embedding
  fallback in `resolveEmbeddingGenerator`. Passing it emits a **one-time**
  console/logger warning (matching the JSDoc `@deprecated` convention used for the
  flat manager shims). If both are supplied, `qualityMode` wins.

`resolveEffectiveConfig(options)` reports the resolved `qualityMode`, the
originating `qualityTier` (or `null`), and every policy field annotated with its
provenance: `default` < `preset` < `qualityMode` < `user`.

## Taxonomy map

The library uses three vocabularies. **Knowledge classes are canonical.** The
cognitive overlay is a documented *view* over them (plus non-knowledge sources),
and derived types are *products* computed from them.

### 1. Knowledge classes (canonical) — `KnowledgeClass`

The internal, authoritative classification stored on every `KnowledgeMemory`:

`identity` · `preference` · `constraint` · `procedure` · `strategy` ·
`anti_pattern` · `project_fact` · `episodic_fact`

Each fact also carries a `KnowledgeState` lifecycle:
`candidate → provisional → trusted` (with `disputed` / `superseded` / `retired`).

### 2. Cognitive overlay (a view) — `CognitiveMemoryType`

A simpler four-type public taxonomy for consumers who think in cognitive-science
terms: `episodic` · `semantic` · `procedural` · `working`. Defined in
`src/contracts/cognitive.ts`; served by `searchCognitive` in `src/core/cognitive.ts`.

Forward map — `mapKnowledgeClassToCognitive(knowledgeClass)`:

| Knowledge class | Cognitive type |
| --- | --- |
| `identity`, `preference`, `constraint`, `project_fact`, `episodic_fact`, `strategy`, `anti_pattern` | `semantic` |
| `procedure` | `procedural` |

Reverse map — `mapCognitiveToKnowledgeClasses(type)`:

| Cognitive type | Backed by | Knowledge classes |
| --- | --- | --- |
| `semantic` | knowledge memory | identity, preference, constraint, project_fact, episodic_fact, strategy, anti_pattern |
| `procedural` | knowledge memory | procedure |
| `episodic` | **conversational turns** (`searchTurns`) | *(none — `[]`)* |
| `working` | **working-memory summaries** (`getActiveWorkingMemory`) | *(none — `[]`)* |

**Why `episodic: []` and `working: []` are correct, not dead** (Phase 6.5
investigation): `mapCognitiveToKnowledgeClasses` is total over the four cognitive
types, so it must return something for all of them. `episodic` and `working` are
**not sourced from knowledge classes at all** — `searchCognitive` resolves them
from raw turns and working memory respectively (see `core/cognitive.ts`
`if (requestedTypes.includes('episodic'))` and `('working')` branches). The empty
arrays are the honest signal "no knowledge class maps here; resolve from the
non-knowledge source." The reverse map only ever feeds the `semantic`/`procedural`
branch of `searchCognitive`, so the empty arrays are load-bearing (they keep the
`Record` total) rather than dead.

Note the intentional asymmetry: the `episodic_fact` knowledge class maps *forward*
to `semantic` (it is a durable, extracted fact **about** an episode), which is
distinct from the raw-turn `episodic` cognitive view.

### 3. Derived types (products) — `DerivedOutputType`

Outputs `derive()` computes from reflection results + active knowledge, not a
storage classification. Built-ins (`src/core/derived.ts`):
`playbook_candidate` · `coding_rule` · `anti_pattern` · `project_summary`
(plus custom types via `registerDerivationHandler`).

## Promotion story

### Facts: turns → knowledge → trust

Turns are compacted/extracted into knowledge candidates, which move through the
`KnowledgeState` trust pipeline (`candidate → provisional → trusted`) as evidence
accrues. Fidelity thresholds along this path come from the resolved `qualityMode`.

### Derived `playbook_candidate` → `Playbook`

What **is** implemented today:

1. `reflect()` / `reflectOnKnowledge()` surfaces recurring patterns.
2. `derive()` turns those into `playbook_candidate` `DerivedOutput`s. Two sources
   feed a candidate (`derivePlaybookCandidates` in `core/derived.ts`):
   - reflection patterns with `occurrences >= 3`, and
   - clusters of **≥ 3 trusted `procedure`-class facts** sharing a subject.
3. When `derive()` is called with a `materialize` adapter, each candidate is
   written back as a **`candidate`-state `project_fact`** tagged
   `derived:playbook_candidate` (with `source_turn_ids` provenance) — it re-enters
   the trust pipeline as a normal knowledge candidate.
4. First-class **`Playbook`** entities are authored separately via the
   `playbooks` capability (`manager.playbooks.createPlaybook` /
   `createPlaybookFromTask`), are versioned (`PlaybookRevision`), and track usage
   (`recordPlaybookUse`).

**Gap / future work:** there is **no automatic promotion** from a materialized
`playbook_candidate` knowledge fact into a `Playbook` entity. The candidate is a
*suggestion* that a human or agent confirms; authoring the `Playbook` is a
separate, explicit step. Closing that loop (auto-drafting a `Playbook` from a
high-trust `derived:playbook_candidate`) is deferred, not implemented.

### `procedure`-class facts vs playbooks

- A **`procedure`** knowledge-class fact is an atomic "how-to" statement living in
  the trust pipeline like any other fact; it maps to the `procedural` cognitive
  type.
- A **`Playbook`** is a curated, versioned, multi-step workflow artifact with its
  own lifecycle (`PlaybookStatus`, revisions, usage counts).

They relate through derivation: **≥ 3 trusted `procedure` facts on one subject
surface as a `playbook_candidate`** suggestion (step 2 above), but procedure facts
are the raw material — the `Playbook` is the confirmed, structured product.
