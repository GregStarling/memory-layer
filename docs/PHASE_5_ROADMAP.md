# Phase 5 Roadmap: Knowledge Intelligence

Phases 1-4 made `memory-layer` the most reliable memory substrate for agents: trust-scored facts, episodic recall, procedural playbooks, typed associations, session snapshots, scoped multi-tenancy, document ingestion, and self-maintaining lifecycle.

Phase 5 makes it intelligent. The system should not just store and retrieve — it should discover patterns, reason about time, reflect on what it knows, and orient agents before they start working.

## Product Thesis (updated)

`memory-layer` wins on:

- factual reliability (trust lifecycle, evidence chains, contradiction detection)
- trust-aware retrieval (8-dimension hybrid ranking with scope, recency, trust, evidence)
- scoped sharing (5-level multi-tenant isolation with cross-scope widening)
- long-horizon memory maintenance (lifecycle management, candidate expiration, reverification)
- portable integration surfaces (Node, HTTP, MCP, Python client, 5 framework adapters)

Phase 5 adds:

- **graph intelligence** — the association graph becomes an analysis target, not just a retrieval aid
- **temporal truth** — facts model when they were true, not just that they existed
- **reflective memory** — the system synthesizes new knowledge from what it already knows
- **curated context** — agents get orientation, not just search results

## Competitive Context

These additions draw from techniques proven in four competing systems, adapted to `memory-layer`'s trust-aware architecture:

| Technique | Source | Our Adaptation |
|-----------|--------|----------------|
| Surprise detection via graph topology | graphify | `discover()` API over association graph |
| Bi-temporal fact modeling | Zep/Graphiti | Validity windows on knowledge facts |
| Post-compaction reflection / sleep-time compute | Letta | `reflectOnKnowledge()` pass that synthesizes across knowledge |
| Ontology-grounded entity resolution | Cognee | Optional alias map for canonical deduplication |
| Edge provenance classes | graphify | `extracted`/`inferred`/`ambiguous` on associations |
| Materialized core memory | Letta | Always-in-context bundle built on profile + snapshot |
| Enrichment pipeline over existing memory | Cognee (Memify) | Folded into reflection pass |
| Rationale capture | graphify + Codex review | `rationale` field on knowledge and playbooks |

What we are not importing:

- Criteria-weighted retrieval (Mem0) — the existing `ContextPolicy` already supports weight tuning across 8 dimensions; this is a documentation gap, not a feature gap
- Visible defrag (Letta) — `runMaintenance()` already consolidates and cleans up; the graph report covers visibility
- Hyperedges / group relationships — playbooks plus pairwise associations cover the use cases; the data model change cascades through storage, retrieval, traversal, export, and temporal replay
- Topology-based clustering — emergent cluster labels are not actionable without a consumer; revisit if graph report creates demand
- Full ontology-first design (Cognee) — adds onboarding friction for marginal dedup improvement; keep optional and lightweight
- HTML/SVG/GraphML export — presentation concern, not memory concern
- AST/code parsing — belongs in agent-layer tooling, not the base memory engine

---

## Phase 5.1 — Graph Intelligence

*Make the association graph an analysis target, not just a retrieval aid.*

### Surprise Analysis

Add a `discover()` API that analyzes the association graph topologically to surface connections the agent didn't know to look for.

Why:

- The lint system answers "what's wrong with my knowledge?" but never "what's interesting?"
- Cross-class bridges between facts in different knowledge domains are often the most valuable insights an agent can surface
- graphify proves that betweenness centrality and community-boundary detection reliably find non-obvious connections in mixed knowledge bases

What to build:

- `discover(options?)` on MemoryManager returning `DiscoveryReport`
- betweenness centrality over the association graph to identify bridge nodes
- cross-class bridge detection: edges that connect facts in different `knowledge_class` groups
- composite surprise scoring: cross-class bonus, cross-scope bonus, low-degree-to-high-degree bonus, weak-confidence bonus
- each result includes an explanation of why it's surprising
- HTTP: `GET /v1/discover`
- MCP: `memory_discover`

Constraints:

- read-only analysis, no mutations
- bounded computation: cap graph traversal, limit results
- lives alongside lint as a peer analysis surface

### Edge Provenance

Add epistemic metadata to associations so traversal and context assembly can prefer strong, verified links over weak, inferred ones.

Why:

- Every knowledge fact has a trust score, evidence count, and verification status. Associations have none of this — they're all treated equally during traversal.
- `autoDetectAssociations` creates inferred edges that should carry less weight than explicit user-created or extraction-grounded edges
- graphify's EXTRACTED/INFERRED/AMBIGUOUS classification on edges directly improves retrieval quality

What to build:

- add `provenance` field to `Association`: `'extracted' | 'inferred' | 'ambiguous'`
- add `confidence` field to `Association`: `0.0 - 1.0`
- `autoDetectAssociations` tags output as `inferred` with computed confidence
- explicit `addAssociation` calls are `extracted` with confidence `1.0`
- context assembly's association expansion prefers high-confidence edges
- schema migration: one column addition to associations table across all three adapters + Postgres schema.sql

Constraints:

- backward-compatible: existing associations default to `inferred` / `0.8`
- do not change the association type ontology (`related_to`, `supports`, `contradicts`, etc.)
- confidence influences retrieval ranking but does not gate inclusion

### Graph Report

Add a `getGraphReport()` API that produces a compact orientation artifact — not an exhaustive export, but a curated briefing an agent reads at session start.

Why:

- the markdown export is an audit artifact ("here's everything the system knows")
- agents need an orientation artifact ("here's what matters, what's surprising, and where to look")
- graphify's GRAPH_REPORT.md proves that a single curated page is more useful than a full graph dump

What to build:

- `getGraphReport()` on MemoryManager returning structured markdown
- combines: discover results (top surprises), lint issues (top problems), high-degree knowledge (most connected facts), knowledge gaps, active contradictions, recent changes summary
- compact enough to inject into a system prompt (target: under 2000 tokens)
- HTTP: `GET /v1/report`
- MCP: `memory_get_report`

Constraints:

- depends on discover and lint (runs both internally)
- must stay within a token budget to be prompt-injectable
- orientation, not exhaustive: top 5 surprises, top 5 issues, top 10 facts

---

## Phase 5.2 — Temporal Truth

*Model when facts were true, not just that they existed.*

### Validity Windows

Add optional temporal bounds to knowledge facts so the system can answer "what was true on date X?" without full event-log replay.

Why:

- Zep/Graphiti's bi-temporal model is the most technically rigorous approach to temporal reasoning in the competitor space
- `memory-layer` has temporal replay via event log reconstruction, which is correct but expensive
- many facts are naturally time-bounded ("the deploy target is us-east-1 starting March 3rd", "the rate limit was 100/s until the upgrade")
- explicit validity windows give O(1) temporal queries for the common case

What to build:

- add nullable `valid_from` and `valid_until` (epoch seconds) to `KnowledgeMemory` and `NewKnowledgeMemory`
- extraction pipeline populates them when source text contains temporal language ("starting next Monday", "as of Q3", "until the migration completes")
- `learnFact()` accepts optional validity bounds
- facts without bounds behave as today: true from creation until retirement
- schema migration across all three adapters

### Temporal Query Shortcut

Add a fast query path that uses validity windows instead of full temporal replay.

What to build:

- `getFactsAt(timestamp, options?)` that filters by `valid_from <= timestamp` and (`valid_until IS NULL OR valid_until > timestamp`)
- falls back to existing `getContextAt()` replay when windows aren't set
- HTTP: `GET /v1/facts-at?timestamp=...`
- MCP: `memory_get_facts_at`

Constraints:

- validity windows are optional — the system must work identically when they're not set
- do not remove or replace the existing temporal replay system; this is a fast path, not a replacement
- extraction of temporal language should be conservative: only populate bounds when the text is unambiguous

### Time-Aware Formatting

Teach the prompt formatter and export system to render temporal bounds explicitly when present.

Why:

- temporal truth only matters if the agent sees it in context — storing `valid_until` in the database but rendering the fact without qualification defeats the purpose
- operators reviewing exported knowledge need to see which facts are time-bounded at a glance

What to build:

- context assembly appends temporal qualifiers to time-bounded facts: "Valid until 2026-09-30", "In effect starting 2026-04-01"
- markdown export renders validity windows in fact metadata
- graph report flags soon-to-expire facts (within configurable horizon)
- inspection endpoints include formatted temporal bounds

Constraints:

- only render qualifiers when validity windows are explicitly set; facts without bounds render as today
- formatting must be concise — one short qualifier, not a paragraph

---

## Phase 5.3 — Reflective Memory

*The system synthesizes new knowledge from what it already knows.*

### Post-Compaction Reflection

Add a reflection pass that runs after compaction (or on a schedule) and looks across the combined knowledge base for higher-order patterns that no single conversation turn could have produced.

Why:

- Letta's sleep-time compute is the single highest-leverage idea from any competitor: letting agents think about what they know while idle
- Cognee's Memify pipeline proves that post-hoc enrichment over existing memory produces genuinely new knowledge
- `memory-layer`'s compaction pipeline extracts facts from individual summaries but never looks across them
- a reflection pass that asks "given everything I now know, what patterns or connections did I miss?" produces knowledge that is qualitatively different from extraction

What to build:

- `reflectOnKnowledge(options?)` on MemoryManager
- triggered optionally after compaction, or on explicit call, or on a schedule
- reads: recent working memory summaries + active knowledge + active playbooks
- runs the extractor over the combined text looking for:
  - recurring themes across sessions
  - implicit constraints never explicitly stated
  - emerging strategies or anti-patterns
  - connections between facts that were extracted independently
- produces new knowledge tagged with `source: 'reflection'`
- new evidence type: `'reflection'` added to `EvidenceSourceType`
- reflection-sourced facts start as `provisional` (they're inferred, not grounded in direct observation)
- HTTP: `POST /v1/reflect-knowledge`
- MCP: `memory_reflect_knowledge`

Constraints:

- reflection must not hallucinate connections — the extractor operates over real memory text, not free generation
- reflection-sourced facts must be clearly labeled and carry lower initial trust than extraction-sourced facts
- reflection is expensive (reads the full knowledge base); must be rate-limited or manually triggered
- do not conflate with the existing `reflect()` episodic API — that synthesizes over recalled episodes; this synthesizes over the knowledge base itself

### Rationale Capture

Add a `rationale` field to knowledge facts and playbooks so the system stores not just what is true but why it's believed or why a procedure exists.

Why:

- graphify's code review found that capturing "WHY" annotations alongside facts dramatically improves the usefulness of extracted knowledge
- playbooks that explain their reasoning are more trustworthy and more reusable than bare procedures
- the `why` is often more durable than the `what` — a deployment procedure changes, but the reason behind it (compliance, performance, cost) persists

What to build:

- add nullable `rationale` text field to `KnowledgeMemory` and `Playbook`
- extraction pipeline populates it when source text contains causal language ("because", "in order to", "the reason is", "this ensures")
- `learnFact()` and `createPlaybook()` accept optional rationale
- surfaced in context assembly, markdown export, and graph report
- schema migration across all adapters

Constraints:

- rationale is informational metadata, not a trust signal — it does not affect trust scoring or lifecycle
- extraction of causal language should be conservative: only populate when the text clearly explains reasoning
- rationale is nullable; the system works identically when it's absent

### Derived Memory Pipelines

Add structured post-reflection outputs that materialize specific artifact types from the knowledge base.

Why:

- reflection is the analysis engine; derived pipelines are the materialization layer
- Cognee's Memify pipeline proves that the most valuable outputs are specific artifact types, not just "new facts"
- agents and operators want actionable outputs: draft playbooks, coding rules, project summaries — not just "the system noticed a pattern"

What to build:

- a pipeline framework that runs after reflection (or independently) and produces typed outputs:
  - **playbook candidates** from repeated successful workflows
  - **coding rule candidates** from repeated constraints + successful patterns
  - **anti-pattern candidates** from failed-use history + dispute patterns
  - **project summaries** from trusted hubs and rationale-rich facts
- each output is a draft that requires operator or agent confirmation before promotion
- outputs carry provenance back to the source knowledge that generated them
- HTTP: `POST /v1/derive` with output type selection
- MCP: `memory_derive`

Constraints:

- derived outputs are suggestions, not automatic promotions — they enter the trust pipeline like any other candidate
- the pipeline framework should be extensible: teams can add custom derivation types
- must be clearly separated from the reflection pass itself — reflection discovers patterns, derivation produces artifacts

### Memory Curation View

Add a first-class curation surface that explains what the system has done to memory and why.

Why:

- maintenance, reflection, ontology resolution, and derived pipelines all modify the knowledge base
- operators need one place that answers "what changed, what was merged, what was retired, and why"
- today's `MaintenanceReport` covers lifecycle actions but not reflection outputs, ontology merges, or derived artifacts
- as the system becomes more autonomous, visible curation becomes essential for operator trust

What to build:

- `getCurationSummary(options?)` that aggregates recent actions from all sources:
  - maintenance: retired facts, expired candidates, demoted knowledge
  - reflection: new patterns discovered, facts promoted from reflection
  - ontology: entities merged, aliases resolved
  - derived pipelines: playbook/rule/summary candidates produced
- structured timeline format with action type, affected entities, and explanation
- compact enough for agent consumption; detailed enough for operator review
- HTTP: `GET /v1/curation`
- MCP: `memory_get_curation`

Constraints:

- curation is a read-only aggregation view, not a new write path
- must not duplicate information already in `MaintenanceReport` — extends it, references it
- should be useful even before reflection and ontology are enabled (maintenance actions alone are valuable)

---

## Phase 5.4 — Core Memory View

*Agents get a curated, always-in-context bundle of what matters most.*

### Materialized Core Memory

Add a first-class concept of "core memory" — a tiny, stable, always-available bundle of the most critical trusted knowledge that gets injected into every prompt regardless of the relevance query.

Why:

- Letta's core memory (always-in-context, like RAM) is the most intuitive concept in their architecture — agents always know who they are, what their constraints are, and what they're working on
- `memory-layer` has `getProfile()` and `captureSnapshot()` which approximate this, but neither is explicitly designed as a "pin this to every prompt" primitive
- the gap shows up in practice: agents re-discover their own identity facts on every session because the relevance query doesn't always match identity knowledge

What to build:

- `getCoreMemory()` on MemoryManager
- returns a compact, token-budgeted bundle of:
  - identity facts (trusted, `knowledge_class: 'identity'`)
  - active constraints (trusted, `knowledge_class: 'constraint'`)
  - workspace norms (trusted, workspace-scoped preferences)
  - active work items (open/in-progress)
  - top active playbook (most recently used)
- deterministic ordering: identity → constraints → norms → work → playbook
- token budget cap (configurable, default 1500 tokens)
- overflow strategy: trim by class priority, keeping identity and constraints even when over budget
- built on top of existing `getProfile()` and `getContext()` internals — not a new storage layer
- HTTP: `GET /v1/core-memory`
- MCP: `memory_get_core_memory`

Constraints:

- core memory is a derived view, not a separate storage tier — all data comes from the existing trust-scored knowledge and coordination systems
- the bundle must be stable across turns within a session (cache it, refresh on explicit boundaries)
- must not duplicate the snapshot system — core memory is a subset selection strategy, not a frozen state

### Custom Facets

Add user-defined tags on knowledge facts so teams can shape memory to their domain without changing the core taxonomy.

Why:

- `knowledge_class` is a fixed enum (`identity`, `preference`, `constraint`, etc.) that covers generic use cases
- domain teams need labels like `incident_rca`, `deployment_policy`, `team_norm`, `coding_rule`, `customer_context` that the built-in classes don't express
- custom facets should be usable in retrieval filters, export grouping, reflection scoping, and lint reports
- this is distinct from criteria-weighted retrieval (which tunes scoring) — facets are domain labels, not ranking signals

What to build:

- add optional `tags: string[]` field to `KnowledgeMemory` and `NewKnowledgeMemory`
- `learnFact()`, `ingestDocument()`, and extraction pipeline can attach tags
- retrieval accepts optional `tags` filter in search options
- markdown export supports `groupBy: 'tag'`
- lint and graph report can scope analysis to specific tags
- HTTP: tags passed as query/body parameters on existing endpoints
- MCP: tags as optional fields on existing tools
- schema migration: one column across all adapters

Constraints:

- tags are freeform strings, not a managed taxonomy — the system does not validate or enforce a tag vocabulary
- tags do not replace `knowledge_class` — they supplement it
- tags do not affect trust scoring or lifecycle

---

## Phase 5.5 — Entity Intelligence

*Smarter entity resolution and optional domain modeling.*

### Canonical Alias Resolution

Add a lightweight alias map so the system resolves common name variants to canonical forms during extraction.

Why:

- the most common source of duplicate knowledge is inconsistent naming: "Postgres" vs "PostgreSQL" vs "pg", "TypeScript" vs "TS", "k8s" vs "Kubernetes"
- `memory-layer`'s `normalizeFactText` and `slot_key` deduplication handles exact-match duplicates but not semantic equivalents
- this should be simple to configure and immediate to use — no ontology concepts required

What to build:

- optional `aliases` config on `MemoryManagerConfig`: a map of canonical names to alias arrays, e.g. `{ "PostgreSQL": ["Postgres", "pg", "postgres"] }`
- applied during extraction: before deduplication, extracted entity names are resolved against the alias map
- matched entities get the canonical name; unmatched entities pass through unchanged
- alias resolution creates `extracted` associations between the canonical entity and contexts where aliases appeared
- aliases can be provided statically (config) or stored per-scope
- HTTP: `POST /v1/aliases` to set/update; `GET /v1/aliases` to retrieve
- MCP: `memory_set_aliases`, `memory_get_aliases`

Constraints:

- alias resolution is string matching, not semantic inference — it resolves known variants, not novel ones
- the system should never auto-merge entities it hasn't been told are equivalent
- alias config is optional; the system works identically without it

### Incremental Alias Discovery

Allow the reflection pass to suggest alias merges over time.

Why:

- manually maintaining an alias map is tedious; the system should notice when the same concept appears under different names
- Cognee's self-improving ontology proves that incremental alias growth is more practical than upfront configuration

What to build:

- during reflection, compare entity names across knowledge facts using normalized string similarity
- when high-similarity pairs are found (e.g., "rate limiter" and "rate-limiter"), surface them as merge candidates
- candidates appear in the curation summary and graph report
- operator or agent confirms the merge, which adds the alias to the map
- HTTP: `GET /v1/alias-candidates`
- MCP: `memory_get_alias_candidates`

Constraints:

- alias candidates are suggestions, not automatic merges — confirmation is required
- similarity threshold should be conservative to avoid false positives

### Ontology Packs (Optional)

For teams that need richer entity modeling, add an optional ontology layer on top of alias resolution.

Why:

- some domains (healthcare, finance, enterprise ops) need canonical entity types, constrained relationships, and validation rules
- this builds on alias resolution by adding structure: not just "these names are the same" but "this entity is a medication, and medications relate to conditions via treats/contraindicates"

What to build:

- optional `ontology` config on `MemoryManagerConfig` that extends aliases with:
  - entity type definitions (beyond built-in `knowledge_class`)
  - relationship constraints (which types connect via which edge types)
  - validation rules flagged during extraction and in lint reports
- ontology relationships injected as `extracted` associations with confidence `1.0`
- ontology can be shared across scopes (workspace-level config)
- HTTP: `POST /v1/ontology` to set/update; `GET /v1/ontology` to retrieve
- MCP: `memory_set_ontology`, `memory_get_ontology`

### Domain Schemas (Memory Packs)

Add optional, lightweight entity and edge type schemas for high-value verticals.

Why:

- Zep/Graphiti's custom entity and edge types let teams define domain-specific graph structures
- a healthcare deployment needs `patient`, `medication`, `condition` as first-class entity types with specific relationship constraints
- this should be additive and optional — the base system works without any schema

What to build:

- optional `schema` config that defines:
  - custom entity types (beyond the built-in `knowledge_class` values)
  - custom relationship types (beyond the built-in `AssociationType` values)
  - validation rules (which entity types can connect via which relationship types)
- schema violations flagged during extraction and in lint reports
- schema can be shared across scopes (workspace-level config)

Constraints:

- schemas are optional — the system is fully functional without them
- schemas constrain and validate, they do not change the storage model
- do not build a full ontology engine — this is lightweight typing for domain teams, not an OWL processor
- revisit scope: if real user demand is low, ship ontology resolution without domain schemas

---

## Phase 5.6 — Advanced

*Items that require user demand signal before committing.*

### Attachable Memory Bundles

Shared knowledge blocks that can be attached to or detached from agents at runtime, enabling "give agent B the same domain knowledge as agent A."

Why:

- Letta's attach/detach memory blocks concept solves a real multi-agent coordination problem
- `memory-layer`'s scope model already supports cross-scope knowledge sharing, but there's no concept of a portable, curated knowledge package

What to build:

- `MemoryBundle`: a named, versioned collection of knowledge facts and playbooks
- `exportBundle(options)` to create a bundle from current scope
- `importBundle(bundle, options)` to merge a bundle into current scope (with conflict resolution via the existing trust pipeline)
- bundles can be workspace-scoped or tenant-scoped for sharing

### Incremental Corpus Refresh

Selective reprocessing for large document corpora so updates don't require full re-ingestion.

Why:

- graphify's SHA256 file-level caching enables efficient incremental updates
- as document ingestion scales, full re-ingestion becomes prohibitive

What to build:

- track content hash per source document (already done in 3.1)
- `refreshDocuments()` that re-ingests only documents whose content has changed
- selective fact invalidation: facts linked to changed documents are marked for re-extraction

### Hyperedges / Group Relationships

Add support for relationships that span more than two nodes.

Why:

- some knowledge is fundamentally higher-order: "these 4 facts together define the deployment policy", "this incident connects 3 work items, 2 facts, and 1 playbook"
- pairwise associations can approximate this but lose the "jointly" semantics

What to build:

- a `Hyperedge` type: a named group of 3+ node references with a relationship label and optional description
- storage, retrieval, and traversal support across all adapters
- surfaced in graph report, markdown export, and context assembly

Constraints:

- ship only after association provenance, rationale, and graph reporting are proven valuable
- the data model change cascades through storage, retrieval, traversal, export, and temporal replay — scope carefully
- revisit only if multiple users independently request group relationship semantics that playbooks can't serve

### Lightweight Cluster Summaries

Add derived cluster labels and summaries for association neighborhoods as a graph report output.

Why:

- clusters are only valuable if they produce actionable outputs: onboarding summaries, retrieval expansion hints, knowledge gap detection
- this should remain a derived lens, not a core storage primitive

What to build:

- community detection over the association graph (Leiden or similar)
- per-cluster summary: top facts, cohesion score, relationship to other clusters
- surfaced in graph report as an optional section
- can inform retrieval expansion: "this query matched cluster X, here are related facts from the same cluster"

Constraints:

- clusters are computed, not stored — they're derived from the current graph state
- cluster labels are ephemeral (recomputed on each analysis pass), not durable identifiers

---

## Dependencies

```
5.1 Graph Intelligence ──────────────────────────────────────┐
  (surprise analysis, edge provenance, graph report)         │
                                                             │
5.2 Temporal Truth ──────────────────────────────────────┐   │
  (validity windows, getFactsAt, time-aware formatting)  │   │
                                                         │   │
5.3 Reflective Memory ──────────────────────────────────────┤
  (reflection, rationale, derived pipelines, curation)   │   │
  benefits from 5.1 (reflection references surprises)    │   │
                                                         │   │
5.4 Core Memory & Domain Shaping ───────────────────────────┤
  (core memory view, custom facets)                      │   │
  benefits from 5.3 (rationale enriches core memory;     │   │
  facets shape reflection and derived outputs)           │   │
                                                         │   │
5.5 Entity Intelligence ────────────────────────────────────┤
  (alias resolution, alias discovery, ontology packs)    │   │
  benefits from 5.3 (reflection discovers aliases)       │   │
                                                         │   │
5.6 Advanced ───────────────────────────────────────────────┘
  (bundles, incremental refresh, hyperedges,
   cluster summaries)
  depends on nothing but benefits from all above
```

5.1 and 5.2 are independent and can ship in parallel.
5.3 benefits from 5.1 but does not require it.
5.4 benefits from 5.3 but does not require it.
5.5 benefits from 5.3 but does not require it.
5.6 ships when demand materializes.

---

## What Phase 5 Does Not Include

These are intentionally excluded from core `memory-layer`:

- **Topology-based clustering as a storage primitive** — emergent cluster labels are not actionable without a clear consumer. The graph report provides orientation without requiring community detection. Cluster summaries may be added as a derived output in 5.6 if demand materializes.
- **Criteria-weighted retrieval as a separate feature** — the existing `ContextPolicy` already supports weight tuning across 8 dimensions. Custom facets (5.4) address the domain-labeling gap. Per-query weight overrides may be added later as a ContextPolicy extension.
- **HTML/SVG/GraphML graph visualization** — presentation concern outside the memory substrate boundary.
- **AST/code-specific extraction** — belongs in agent-layer tooling or optional ingestion adapters.
- **Full ontology engine** — Cognee's approach requires OWL-level modeling; we want lightweight alias mapping first, optional ontology packs second, never a knowledge representation system.
- **Git-backed memory files** — the relational storage model is superior for scope isolation, lifecycle, maintenance, and concurrency.
- **Built-in cron, messaging, or agent orchestration** — these belong in higher-level runtimes.

---

## Success Criteria

Phase 5 is successful when:

- `memory-layer` can answer "what's surprising in my knowledge?" as well as it answers "what is true?" and "what happened before?"
- agents receive a compact, curated orientation at session start instead of re-discovering their own context
- the system generates new knowledge through reflection that no single conversation turn could have produced
- facts carry temporal bounds that enable cheap point-in-time queries without full event-log replay
- association edges carry provenance and confidence that improve retrieval quality
- knowledge and playbooks explain their reasoning via rationale fields
- teams can shape memory to their domain with custom facets without changing the core taxonomy
- operators can see what the system did to memory and why through a unified curation view
- entity naming is consistent through alias resolution, with incremental discovery reducing manual maintenance
- the product remains a memory substrate, not an agent shell, knowledge representation engine, or graph database

## Architecture Boundary (unchanged)

1. `memory-layer` owns declarative, episodic, procedural, and reflective memory primitives.
2. Host agents decide how to use those primitives in prompts, tools, and workflows.
3. Higher-level shells can add delegation, automations, messaging, and execution UX on top.
