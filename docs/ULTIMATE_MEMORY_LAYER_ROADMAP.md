# Ultimate Memory Layer Roadmap

This document locks in the Hermes-inspired and memorylayer.ai-inspired additions we want to bring into `memory-layer`.

The goal is not to turn `memory-layer` into Hermes. The goal is to make `memory-layer` the best memory substrate for agents, assistants, and autonomous systems.

## Product Thesis

`memory-layer` should win on:

- factual reliability
- trust-aware retrieval
- scoped sharing
- long-horizon memory maintenance
- portable integration surfaces

We will borrow ideas from Hermes where they strengthen memory as a product. We will not absorb agent-shell features that belong in a higher-level runtime.

We will also borrow ideas from `memorylayer.ai` where they improve the external memory API, retrieval ergonomics, and workspace experience without weakening the trust-aware core.

## Locked Additions

### 1. Episodic Recall Summaries

Add a first-class recall surface that does more than return raw turn hits.

Why:

- Hermes' session search is valuable because it turns past conversations into compact, query-focused recaps.
- `memory-layer` already has turn search and time-range recall, but not a dedicated "what happened before?" summarization surface.

What to build:

- `searchEpisodes(query, options?)`
- `summarizeEpisode(...)` over turn ranges or session slices
- `reflect(query, options?)` as a first-class synthesis API over recalled memory
- query-focused recap format:
  - objective
  - actions taken
  - outcomes
  - important files/commands/URLs
  - unresolved items
- retrieval detail levels:
  - `abstract`
  - `overview`
  - `full`

Constraints:

- preserve source references back to turns
- keep episodic recall separate from trusted factual memory
- do not silently promote episode summaries into trusted knowledge
- `reflect()` must clearly report sources and whether it is operating over episodic, declarative, or mixed memory

### 2. Procedural Memory as Skills or Playbooks

Add a reusable procedural layer above `procedure` facts.

Why:

- Hermes is strongest where it turns solved workflows into reusable skills.
- `memory-layer` already models `procedure` knowledge, but not durable executable playbooks.

What to build:

- a `playbook` or `skill` artifact type
- storage for:
  - instructions
  - references
  - templates
  - scripts
  - assets
- APIs to:
  - create a playbook from a successful task
  - revise a playbook after use
  - retrieve relevant playbooks during context assembly

Constraints:

- playbooks are procedural memory, not trusted factual memory
- playbook retrieval should be relevance-ranked and separately labeled
- artifacts must be inspectable and editable by host systems

### 3. Stable Session Snapshot Mode

Add an optional runtime mode that freezes durable memory at session start.

Why:

- Hermes preserves prompt-cache stability by freezing memory injected into the prompt for the session.
- `memory-layer` currently rebuilds bootstrap and live context on each call, which is flexible but less cache-friendly.

What to build:

- optional runtime/session mode:
  - capture a durable snapshot at session start
  - reuse that snapshot across turns
  - refresh only on explicit boundaries
- keep live writes durable on disk/storage even when prompt snapshot is frozen

Constraints:

- this must be opt-in
- default behavior remains dynamic retrieval
- snapshot mode must clearly distinguish:
  - frozen prompt state
  - live persisted state

### 4. Materialized User and Operator Profiles

Add a dedicated profile surface built on top of existing trusted knowledge.

Why:

- Hermes' split between general memory and user-oriented memory is product-useful.
- `memory-layer` already tracks identity, preference, and constraint knowledge with trust states, which is a better foundation than flat notes.

What to build:

- `getProfile()` or equivalent materialized profile API
- profile views such as:
  - user profile
  - operator profile
  - workspace profile
- profile sections:
  - identity
  - preferences
  - communication conventions
  - constraints
  - recurring workflows

Constraints:

- profiles are derived views over trust-scored knowledge
- profiles should expose provenance and trust metadata
- profile writes should still flow through normal evidence-aware memory paths

### 5. External Cognitive Memory API

Add a clean external memory taxonomy on top of the richer internal model.

Why:

- `memorylayer.ai` presents memory in a way that is very easy for SDK users and agent builders to understand.
- `memory-layer` already has stronger internals, but the external API should be simpler than the internal storage model.

What to build:

- first-class external memory types:
  - `episodic`
  - `semantic`
  - `procedural`
  - `working`
- stable mapping from these public types to internal knowledge classes, working memory, and episodic recall surfaces
- consistent use of this taxonomy across:
  - package API
  - HTTP API
  - MCP API
  - docs
  - examples

Constraints:

- do not flatten the internal trust-aware model just to match the public taxonomy
- public type labels should be an interface layer, not the full storage model

### 6. Lightweight Typed Associations

Add explicit associations between memories to support multi-hop recall and synthesis.

Why:

- `memorylayer.ai` has a strong graph story, even if its ontology is more elaborate than we need.
- `memory-layer` would benefit from a small, opinionated association layer for linking facts, episodes, playbooks, and profiles.

What to build:

- an association model linking memory artifacts
- a compact starter relationship set such as:
  - `related_to`
  - `supports`
  - `contradicts`
  - `supersedes`
  - `depends_on`
  - `solves`
  - `applies_to`
  - `derived_from`
- retrieval support for light multi-hop expansion when appropriate
- APIs to inspect associations and traverse related memory

Constraints:

- keep the initial ontology intentionally small
- associations must not replace evidence and trust metadata
- graph expansion must remain bounded and observable

### 7. Workspace-First Onboarding Ergonomics

Add a simpler default experience for common repo- and project-scoped usage.

Why:

- `memorylayer.ai` makes workspace setup very easy, especially for MCP and local project use.
- `memory-layer` has a better scope model, but the zero-config path can be simpler.

What to build:

- workspace auto-defaults for local repo usage
- optional git/repo-based workspace detection for MCP and local tooling
- friendlier top-level examples that start with workspace-first memory before introducing full multi-scope routing

Constraints:

- keep the current multi-scope model intact
- auto-detection must be a convenience layer, not a replacement for explicit scope control

## Supporting Improvements

These are not separate product pillars, but they should accompany the work above:

- richer structured compaction summaries
- explicit separation of declarative, episodic, and procedural memory in formatting
- eval coverage for recall summaries, playbook usefulness, and profile correctness
- MCP and HTTP surfaces for the new APIs from day one
- typed SDK ergonomics for memory categories, detail levels, and associations

## What We Are Not Importing

These are intentionally out of scope for core `memory-layer`:

- a flat `MEMORY.md` or `USER.md` file as the canonical memory store
- built-in messaging gateways
- built-in cron or automation runners
- built-in subagent orchestration
- full CLI-agent shell behavior
- server-side general-purpose code sandboxing as a core memory primitive
- a sprawling graph ontology out of the gate

Those may be good companion products or examples, but they are not the core memory engine.

## Architecture Boundary

The intended stack is:

1. `memory-layer` owns declarative, episodic, and procedural memory primitives.
2. Host agents decide how to use those primitives in prompts, tools, and workflows.
3. Higher-level shells can add delegation, automations, messaging, and execution UX on top.

## Build Order

### Phase 1

- episodic recall summaries
- `reflect()` API
- recall detail levels: `abstract`, `overview`, `full`
- structured output format for recall recaps
- evals for cross-session recall quality
- external memory taxonomy across public APIs

### Phase 2

- materialized user/operator/workspace profiles
- profile retrieval and formatting
- trust-aware profile evals
- workspace-first onboarding and auto-defaults

### Phase 3

- procedural playbooks or skills
- creation and revision APIs
- retrieval and selection logic
- lightweight typed associations
- bounded multi-hop association retrieval

### Phase 4

- stable session snapshot mode
- runtime APIs for explicit refresh boundaries
- cache-efficiency benchmarks

## Success Criteria

We should consider this roadmap successful when:

- `memory-layer` can answer "what happened before?" as well as it answers "what is true?"
- the public API is simpler and more legible than the internal model
- procedural knowledge is reusable instead of trapped as raw facts
- hosts can choose between dynamic retrieval and cache-stable session snapshots
- profile views feel native to the memory model rather than bolted on
- associations improve retrieval and synthesis without overwhelming the trust model
- the product is still clearly a memory substrate, not an agent shell
