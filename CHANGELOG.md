# Changelog

All notable changes to `memory-layer` are documented here.

## 4.5.0 - 2026-07-15

### Added

- Retrieval quality eval rebuilt as a 102-case categorized dataset (exact-term, paraphrase, distractor-resistance, cross-class, trust-vs-recency) scoring MRR/recall@k against an in-run exact-token baseline the gate must demonstrably beat. Paraphrase performance under the offline tier is reported honestly as known-weak.
- Temporal replay equivalence property test: seeded random operation sequences checkpointed and replayed over SQLite and Postgres event logs, asserting live-vs-replayed state equality.
- Concurrency test tier (Postgres-only, CI): claim races, optimistic-lock races, lazy-expiry double-emission, and parallel compaction now have real multi-connection race tests.
- Postgres adapter behavioral coverage is measured in CI via a dedicated vitest config that runs every pg-gated suite — including the three 4.3.0-era verification suites whose Postgres legs had never executed in CI.
- Benchmark tracking: per-release results under `benchmarks/results/`, with a warn-only CI comparison against the previous release.

### Changed

- Memory-quality evals report raw per-metric actuals with explicit pass/fail and `knownWeak` flags; the former min-capped 0-100 score is replaced by a pass rate explicitly labeled as such. Metrics previously computed from 1-3 examples now use 20+ materially distinct cases.
- Regex-against-schema pseudo-tests for the Postgres adapter removed in favor of the live behavioral suites.

## 4.4.0 - 2026-07-14

Consolidated release covering the security, data-integrity, adapter-parity, and honest-surfaces work landed since 4.1.0.

### Added

- Tenant-bound API keys (`MEMORY_API_KEYS`), secure-by-default CORS (`MEMORY_CORS_ORIGIN`), rate limiting, `MEMORY_ALLOW_UNAUTHENTICATED` opt-out, Docker startup guard, and `docs/SECURITY.md`.
- Atomic mutation+event writes, event-cursor pagination correctness, embedding dimension/model versioning with real HNSW usage, and an `expireStaleHandoffs`/`expireStaleClaims` reaper replacing side-effectful reads.
- Cross-adapter conformance suite pinning search semantics, rank scale (0,1], ordering, filters-before-LIMIT, and visibility across the in-memory, SQLite, and Postgres adapters — running against real Postgres in CI.
- Visibility classes enforced end-to-end on every cross-scope read path (lexical, semantic, event-log, and temporal replay). `learnFact`, MCP `memory_learn_fact`, and `POST /v1/facts` accept an optional visibility class so facts can be shared deliberately (`workspace`, `shared_collaboration`, `tenant`); facts remain private by default.
- The five documented-but-unimplemented HTTP endpoints are now real: `POST /v1/documents`, `GET /v1/documents/{id}`, `GET /v1/export/markdown`, `POST /v1/lint/knowledge`, `POST /v1/promote-response`. Five served-but-undocumented routes added to the OpenAPI spec, with a bidirectional spec-to-route parity test.
- Presets set real default context token budgets (ai_ide 8000, chat_agent 4000, autonomous_agent 6000) with a trim trace; `UNLIMITED_TOKEN_BUDGET` is exported as the explicit unbounded opt-in.
- Optional `created_at` on `NewKnowledgeMemory`, honored by all adapters with integer coercion on Postgres.

### Fixed

- Postgres: concurrent claim race, optimistic locking without a version guard, search returning superseded records by default, scoped `deleteEmbedding` no-op, `insertPlaybook` dropping `visibility_class`, `to_tsquery` crashes on empty or non-Latin queries, and unbounded time ranges binding non-finite values to INTEGER columns.
- SQLite: work items permanently unclaimable after lease expiry, destructive migration ordering, vector search returning retired knowledge, and multi-term search standardized to any-term semantics across all adapters.
- Examples import the correct package name and typecheck in CI; README claims corrected to match the code (contradiction detection scope, offline-tier retrieval, replay limits, multi-tenancy trust model).

## 4.1.0 - 2026-04-08

### Fixed

- Hosted manager caches now normalize equivalent implicit and explicit scopes to the same cache key, so live alias and ontology updates propagate consistently across transports.
- Durable alias and ontology config now validates payload shape before persistence and safely ignores malformed stored config during reloads.

## 4.0.0 - 2026-04-08

### Added

- **Phase 5 features**: temporal event log, session state projections, coordination visibility with work claims and handoffs.
- SQLite migration hardening with forward-only schema versioning (v13-v14).
- Technical debt cleanup for 100/100 codebase score.

### Fixed

- Postgres confidence constraint migration now drops by name instead of pattern-matching the definition, fixing idempotency on repeated schema applies.
- Release workflow made idempotent: npm publish skips if version already exists, PyPI uses `skip-existing`.
- PyPI publishing restricted to canonical repo (GregStarling/memory-layer).

## 3.1.0 - 2026-04-06

### Added

- **Source document ingestion** with content-hash deduplication, token estimation, and per-scope document listing.
- **Knowledge linting** for quality analysis — detects orphan knowledge, trust distribution skew, evidence concentration, contradiction clusters, and stale provisional facts.
- **Markdown export** of the knowledge base, grouped by class, topic, or flat, with optional evidence, trust metadata, and changelog sections.
- **Promote response** — elevate knowledge from assistant turns into the knowledge store.
- **Scope isolation guards** on work items, claims, handoffs, and related mutations so cross-scope writes are rejected at the manager level.
- `deleteExpiredKnowledgeCandidates` maintenance step cleans up unpromoted candidates older than 30 days.
- `getWorkClaimById`, `getHandoffById` adapter methods for direct ID lookups.
- Batch-fetch optimisation in hybrid search to avoid N+1 queries on semantic-only hits.
- `visibility_class` column on associations and `source_document_id` on knowledge evidence (Postgres schema v15).
- New OpenAPI endpoints: `/v1/documents`, `/v1/documents/{id}`, `/v1/export/markdown`, `/v1/lint/knowledge`, `/v1/promote-response`.

### Changed

- `getProfile` MCP response now wraps the profile under a `profile` key for transport consistency.
- Scope validation in HTTP and MCP servers now explicitly validates field types instead of blind casts.
- `factType` enum narrowed to `preference | entity | decision | constraint | reference`.
- OpenAPI work-claim fields normalised from `lease_seconds` to `leaseSeconds`.

## 3.0.0 - 2026-04-05

### Breaking

- **`getProfile` / `memory_get_profile` / `GET /v1/profile` now default to trusted knowledge only.** Callers that relied on provisional-state knowledge appearing by default must now opt in with `includeProvisional: true` or `?includeProvisional=true`.
- **`operator_supervisor` now widens further by default.** When no explicit `crossScopeLevel` is configured, `operator_supervisor` now defaults to tenant-level fetch and can surface `tenant`-visibility knowledge, work items, playbooks, claims, and handoffs.

### Changed

- Hardened snapshot, replay, and historical bootstrap behavior so temporal reads use more consistent historical state.
- Added stronger HTTP and MCP validation, bounded diff/reporting flows, transport parity updates, and batch maintenance lookups.
- Expanded coverage around the in-memory adapter and temporal replay stack so the package clears the release gate with the existing threshold policy.

### Fixed

- Corrected snapshot watermark handling and historical bootstrap leakage in runtime and transport snapshot flows.
- Aligned HTTP and MCP validation behavior for malformed numeric and identifier inputs.
- Cleaned up release metadata so publish-time package normalization no longer rewrites the CLI bin target.

## 2.0.0

- Repositioned `memory-layer` as a standalone memory platform for AI systems, with reusable manager, runtime, HTTP, and MCP surfaces.
- Added multi-scope request routing for HTTP and MCP servers, plus stronger scope-aware retrieval behavior.
- Introduced pluggable token estimation, richer extraction and monitor customization, batch storage operations, and pagination support.
- Improved retrieval quality with hybrid ranking updates, semantic defaults, embedding retry/caching helpers, and a local embedding fallback.
- Added provenance-backed knowledge metadata, confidence scoring, verification state, contradiction auditing, and consolidation during maintenance.
- Hardened runtime behavior with circuit breakers, admin separation, body limits, health endpoints, and event streaming.
- Expanded the evidence layer with evaluation fixes, coverage thresholds, snapshot coverage, and cross-adapter validation.
- Added OpenAPI, Docker, release automation, product docs, and a larger example/integration surface for adoption.
