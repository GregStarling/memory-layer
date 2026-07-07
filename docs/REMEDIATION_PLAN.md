# Remediation Plan — July 2026 System Audit

Source: full-system audit of `ai-memory-layer` v4.1.0 (2026-07-06). Five audit passes: promise-vs-reality, core architecture, storage/multi-tenancy, server surfaces, verification infrastructure.

Organizing principle: fix what corrupts or loses data first, then what leaks or lies, then what drifts, then what sprawls. Each item has acceptance criteria (AC). Phases 0–2 are patch/minor releases; Phase 6 is the next major.

---

## Phase 0 — Ship-stoppers (release as 4.1.1, immediately)

> **STATUS: IMPLEMENTED 2026-07-06** (uncommitted). All items 0.1–0.7 fixed with regression tests; two rounds (initial + review fixes). Full suite 828 passed / 18 gated-skipped, tsc clean. Postgres concurrency tests are gated on `POSTGRES_TEST_URL` — first CI run must confirm they pass. Known accepted deviations: ALTER probes also tolerate `no such table` (fresh-DB statement ordering; revisit in Phase 3), `resolveSearchOptions` duplicated locally in pg adapter pending Phase 3.1 extraction.

Correctness bugs that break advertised features today. No API changes.

### 0.1 SQLite: work items permanently unclaimable after lease expiry/release  **[VERIFIED]**
- **Where:** `src/adapters/sqlite/index.ts:2110-2184`, `src/adapters/sqlite/schema.ts:622`
- **Bug:** expired/released claim rows are updated in place but still occupy the `UNIQUE(work_item_id)` slot in `work_claims_current`; the next claim's INSERT hits `SQLITE_CONSTRAINT_UNIQUE` → remapped to `ConflictError` forever.
- **Fix:** make `work_claims_current` hold only the *current* claim: on claim, `INSERT ... ON CONFLICT(work_item_id) DO UPDATE` guarded on `status != 'active' OR expires_at <= @now`, moving the displaced row into a `work_claims_history` table (or reuse the event log as history, since claim events are already emitted). Migration required (see 0.3 for migration safety first — land 0.3 in the same release).
- **AC:** claim → expire → reclaim succeeds; claim → release → reclaim (same and different actor) succeeds; claim → active foreign claim still throws `ConflictError`. Regression test reproducing the audit's empirical repro.

### 0.2 Postgres: concurrent claim race — two actors both win
- **Where:** `src/adapters/postgres/index.ts:2141-2185`
- **Bug:** check-then-write under READ COMMITTED with an unguarded `ON CONFLICT (work_item_id) DO UPDATE` — the second committer silently steals an active claim.
- **Fix:** drop the pre-SELECT as the authority; make the upsert self-guarding:
  `ON CONFLICT (work_item_id) DO UPDATE SET ... WHERE work_claims_current.status <> 'active' OR work_claims_current.expires_at <= EXCLUDED.claimed_at`
  then check `rowCount`; 0 affected rows → `ConflictError`. Keep the SELECT only to produce a rich error message.
- **AC:** new concurrency test: N parallel `claimWorkItem` calls on one item → exactly 1 success, N−1 `ConflictError` (run in `postgres-integration.test.ts` against the real pgvector service in CI).

### 0.3 SQLite migrations: version stamped before destructive work; no atomicity; no downgrade guard
- **Where:** `src/adapters/sqlite/schema.ts:404, 725-733, 862-991`
- **Fixes:**
  1. Reorder: run all version-gated migrations first, stamp `schema_meta = CURRENT_SCHEMA_VERSION` **last**.
  2. Wrap `createSQLiteSchema` in a single transaction (`db.exec('BEGIN')`/`COMMIT` or better-sqlite3 `.transaction()`); the v17→v18 RENAME/copy/drop rebuild must be atomic.
  3. Add recovery: on open, if `context_contracts_v17` exists and `context_contracts` is empty, complete the interrupted copy before proceeding.
  4. Downgrade guard: if `schema_meta > CURRENT_SCHEMA_VERSION`, throw a clear "database was created by a newer version" error instead of silently re-stamping down.
  5. Stop swallowing `ALTER TABLE` probe failures indiscriminately (`schema.ts:337-343, 370-376, 390-396`): catch only the "duplicate column" error message; rethrow disk-full/locked errors.
  6. Remove the duplicated `memory_event_log` + index creation blocks (`schema.ts:557-612` vs `735-791`).
- **AC:** kill-the-process test (or fault-injection wrapper) mid-v17→v18 leaves either old state or new state, never stranded `_v17` data; opening a v(N+1) DB with v(N) code throws; suite green.

### 0.4 Postgres search returns superseded/retired records by default
- **Where:** `src/adapters/postgres/index.ts:1241` (turns), `:1698, :1721` (knowledge)
- **Fix:** resolve options through the same `resolveSearchOptions` defaults as SQLite/memory (`activeOnly` defaults `true`). Extract the resolver to a shared module (first brick of Phase 3.1).
- **AC:** cross-adapter test: supersede a fact, search with no options → absent on all three adapters; `activeOnly: false` → present on all three.

### 0.5 Postgres `deleteEmbedding` scoped call is a silent no-op
- **Where:** `src/adapters/postgres/index.ts:3350-3361`
- **Fix:** correct the placeholder offsets (scope params start at `$2`; use `scopeWhere('km', 2)` or rebuild params).
- **AC:** test: insert embedding → scoped delete → `findSimilar` no longer returns it (Postgres).

### 0.6 SQLite vector search returns retired knowledge
- **Where:** `src/adapters/sqlite/embeddings.ts:111`
- **Fix:** add `retired_at IS NULL` to match Postgres (`postgres/index.ts:3307`) and in-memory.
- **AC:** retire a fact → semantic search excludes it on all three adapters.

### 0.7 Optimistic locking without version guard in the UPDATE
- **Where:** `src/adapters/sqlite/index.ts:2017-2037`, `src/adapters/postgres/index.ts:2070-2088`
- **Fix:** `UPDATE ... WHERE id = ? AND version = ?`; 0 rows affected → `ConflictError`(stale version). Remove reliance on the prior SELECT.
- **AC:** two interleaved updates with the same `expectedVersion` → exactly one succeeds (pg concurrency test; SQLite unit test via manual interleave).

---

## Phase 1 — Security & tenancy (release as 4.2.0)

> **STATUS: IMPLEMENTED 2026-07-06** (uncommitted at time of writing → committed). Items 1.1–1.5 done with tests; two rounds (initial + adversarial-security-review fixes). Review caught real gaps the workers missed: CORS still wildcard, Docker guard fail-open (transport/empty-host), and health probes requiring auth — all fixed. Back-compat preserved (legacy key = wildcard + warning; rate limiting and CORS both off/none by default). New: `MEMORY_API_KEYS` registry (key→tenant binding), `MEMORY_CORS_ORIGIN`, `MEMORY_ALLOW_UNAUTHENTICATED` opt-out, `docker-entrypoint.sh` startup guard, `docs/SECURITY.md`. Full suite 899 passed; lint/build/coverage/eval gates green locally.

The storage layer isolates correctly; the API layer must stop being cooperative.

### 1.1 Bind credentials to tenants
- **Where:** `src/server/http-server.ts:298-351, 410, 716-720`, `src/server/scope-propagation.ts`
- **Design:** replace the single `MEMORY_API_KEY` with a key registry: `MEMORY_API_KEYS` (or config file / admin endpoint) mapping `key → { tenant_id | '*', maxCrossScopeLevel, adminAllowed }`. `resolveRequestScope` validates the client-supplied five-tuple against the authenticated principal: mismatched `tenant_id` → 403; requested `crossScopeLevel` above the key's ceiling → 403. Keep single-key `'*'` mode for backward compat (localhost/dev), but log a startup warning when a wildcard key (or no key) serves non-loopback.
- **AC:** integration test — key bound to tenant A + `x-memory-tenant: B` → 403 on every route (assert via route-table sweep, not a sample).

### 1.2 Secure-by-default shipping config
- **Where:** `Dockerfile`, `docker-compose.yml`, `src/server/http-server.ts:412, 700-706`
- **Fixes:** Docker requires `MEMORY_API_KEY` when `MEMORY_HOST=0.0.0.0` (entrypoint check, fail fast); CORS default becomes same-origin/none — wildcard only via explicit `MEMORY_CORS_ORIGIN=*`; add Docker `HEALTHCHECK` hitting `/healthz`; add an app healthcheck to compose.
- **AC:** `docker compose up` without a key refuses to start (with a clear message); browser `fetch` from a foreign origin is blocked by default.

### 1.3 Stop leaking internals in 500s
- **Where:** `src/server/http-server.ts:1996-1997`
- **Fix:** for non-`MemoryDomainError` exceptions return a generic message + request id; log the real error server-side.
- **AC:** forced internal error → response body contains no driver/DB text.

### 1.4 Rate limiting
- **Fix:** token-bucket per key (in-memory, per-process is fine at this scale), configurable, off by default for loopback. 429 with `Retry-After`.
- **AC:** burst past the limit → 429; under limit → unaffected.

### 1.5 Scope the ops scripts
- **Where:** `scripts/export-memory.mjs:12-26`, `scripts/import-memory.mjs`
- **Fixes:** `--tenant` (and optional full scope) required for export unless `--all-tenants` is passed explicitly; import must fail (not `INSERT OR REPLACE`) on id collision, offer `--remap-ids`, and refuse rows whose scope doesn't match the declared target scope.
- **AC:** export for tenant A contains zero tenant-B rows; import with colliding ids exits non-zero without writing.

---

## Phase 2 — Data integrity: event log & embeddings (4.3.0)

### 2.1 Make mutation + event atomic in adapter primitives
- **Where:** SQLite: `insertValidatedTurn` (`sqlite/index.ts:805-838`), `insertValidatedKnowledgeMemory` (:844-916), `archiveTurn` (:1163-1191), `updateKnowledgeMemory` (:1864-1879), touch/retire/supersede, playbook ops. Postgres: same primitives, worse — the two statements can run on **different pooled connections** (`postgres/index.ts:1146-1170`).
- **Fix:** SQLite — wrap each primitive in `db.transaction()`. Postgres — every primitive that writes row + event acquires one client and wraps in `BEGIN/COMMIT` (honoring an ambient transaction client when inside `this.transaction`).
- **AC:** fault-injection test (event insert throws) → row insert rolls back; no orphaned rows or orphaned events.

### 2.2 Close event-coverage gaps and the promotion atomicity hole
- **Where:** `promoteKnowledgeCandidate` state flip (`sqlite/index.ts:1478-1484`, `postgres/index.ts:1590-1597`) not transactional with the knowledge insert; no events for candidates, evidence, audit rows, compaction log, `updateSourceDocument`, `setScopeConfig`, governance upserts.
- **Fix:** promotion = one transaction (candidate flip + knowledge insert + event). Add events for the missing mutation classes (at minimum: candidate lifecycle, governance changes, source documents — anything `getStateAt` claims to reconstruct). Document explicitly which entities are outside temporal replay's contract.
- **AC:** crash-between test for promotion; replayed state at T equals live state snapshot taken at T for every replayed entity kind (property test on the SQLite adapter, see 5.3).

### 2.3 Event pagination cursor correctness
- **Where:** `sqlite/index.ts:483-506` — cursor is `event_id > ?` while ordering is `(created_at, event_id)`.
- **Fix:** order by `event_id` alone (append-only monotonic ids make this the honest ordering), or make the cursor composite. Stop accepting caller-supplied `created_at` on `insertMemoryEvent`, or ignore it for ordering purposes.
- **AC:** paging through a log with backdated timestamps yields no skips/repeats.

### 2.4 Embedding dimension & model versioning; make HNSW real
- **Where:** `postgres/schema.sql:407-419`, `sqlite/embeddings.ts:30-78`, `embeddings/*`
- **Design:** add `model` + `dimensions` columns to embedding storage on all adapters. Queries filter `WHERE model = ? AND dimensions = ?` — mismatched vectors are excluded *in SQL*, never compared. On Postgres, migrate `embedding vector` → typed `vector(N)` per active configuration (or a partial HNSW index per `(model, dimensions)` on an expression); build HNSW and verify with a test that inspects `pg_indexes`. Emit a `degraded_mode`-style event when stored embeddings don't match the active provider (surfaced via `getRuntimeDiagnostics`), and add a `reembed` maintenance operation (batch re-embed with the active provider).
- **AC:** provider dimension change → queries still succeed (old vectors excluded, warning emitted), `reembed` restores coverage; fresh Postgres install has a live HNSW index; SQLite/memory/pg agree on mismatch behavior.

### 2.5 Lazy lease expiry: no side-effectful reads
- **Where:** `sqlite/index.ts:2337-2369` (list ops mutate + emit events, untransactioned; double-emission under two readers)
- **Fix:** reads compute *effective* status (`expires_at <= now → expired`) without writing. Actual expiry writes happen in claim/renew/release paths (transactional) and in a `expireStaleClaims` maintenance step (called by the existing maintenance scheduler — this is the "reaper" the lease abstraction implies).
- **AC:** two concurrent list calls on an expired claim → at most one `work_claim.expired` event ever; reads never write.

---

## Phase 3 — Adapter parity (4.4.0)

The promise "same API, one line changed" requires same semantics. Strategy: extract shared logic, then pin behavior with a conformance suite that runs against all three adapters.

### 3.1 Shared adapter kernel (`src/adapters/shared/`)
- Move: `resolveSearchOptions`/`resolvePaginationOptions` (currently duplicated at `memory/index.ts:150+` and `sqlite/index.ts:245+`; missing on pg — root cause of 0.4), `tokenize`/`scoreText` (char-identical copies at `memory/index.ts:130-148` and `sqlite/index.ts:218-235`), scope-predicate builders, post-filter helpers.
- **AC:** duplication gone (verified by the conformance suite exercising defaults once, not per-adapter).

### 3.2 Unify search semantics and rank scales
- **Where:** `sqlite/index.ts:213-216, 1596, 3089`; `postgres/index.ts` tsquery paths; `memory/index.ts:130-148`
- **Fixes:**
  1. SQLite: fix `normalizeRank` — BM25 is negative-is-better; map to (0,1] via e.g. `1/(1+max(0,-raw))` so lexical ranking is no longer a constant 1.0. Fix `searchPlaybooks` returning the array index as rank.
  2. SQLite: sanitize FTS5 input *first* (treat user text as literal terms; explicit operator syntax opt-in), not only on error-retry.
  3. Postgres: switch `plainto_tsquery` → `websearch_to_tsquery` or OR-composed lexemes to match the partial-match semantics of the other adapters; decide and document one matching contract (recommend: unstemmed OR-of-terms with phrase bonus, matching the shared `scoreText`).
  4. Normalize all adapter ranks to a documented 0–1 scale so `rankKnowledge`'s lexical dimension is comparable across backends.
- **AC:** conformance suite asserts: same corpus + query → same *set* of results on all adapters (ordering may differ only within documented tie-break rules); stemming/operator behavior matches the documented contract everywhere.

### 3.3 Filters before LIMIT
- **Where:** `sqlite/index.ts:1611-1617`, `postgres/index.ts:1709-1715` (post-LIMIT filtering starves results; memory filters pre-limit)
- **Fix:** push trust/state/class/tag predicates into SQL WHERE on SQLite and Postgres (all are plain columns; tags need JSON containment — `EXISTS` over `json_each` / `@>` on jsonb).
- **AC:** corpus where top-N lexical hits are low-trust → high-trust matches beyond N are still returned when filtered; identical results across adapters.

### 3.4 Ordering parity
- **Where:** `getWorkingMemoryBySession` (sqlite ASC vs pg DESC), `get*ByTimeRange` (reversed), `getActiveWorkItems` (`updated_at` vs `id`)
- **Fix:** pick one ordering per method (document in the storage contract docstring), align all adapters.
- **AC:** conformance suite asserts ordering per contract on all adapters.

### 3.5 Postgres dropped-field parity
- **Where:** `insertWorkItem` drops `visibility_class`/`source_working_memory_id`/`created_at` (`postgres/index.ts:1961-1966`); `insertTurn` ignores `created_at` (:1148); `insertCompactionLog` drops `error` (:2714-2721)
- **Fix:** persist every contract field; honor caller-supplied `created_at` (needed for imports and time-range integrity).
- **AC:** round-trip test per entity: insert with all fields → read back equal, on all adapters.

### 3.6 Visibility class end-to-end
- **Where:** `insertKnowledgeMemory` drops `visibility_class` on SQLite **and** Postgres (in-memory honors it); `manager.searchKnowledge` cross-scope applies no visibility filter (`manager.ts:1310-1312`); `resolveVisibleKnowledge` only runs when a context `view` is set (`context.ts:227-233`)
- **Fix:** persist the column on both adapters (schema migration); apply visibility filtering on every cross-scope read path, not just view-scoped context assembly.
- **AC:** a `private` fact in scope A never surfaces to scope B at any widening level via `searchKnowledge`, `getContext`, or temporal reads.

### 3.7 Transaction semantics parity
- **Where:** `adapters/sync-to-async.ts:187-199` (no rollback), `memory/index.ts:2273-2275` (`transaction(fn)` = `fn()`)
- **Fix:** in-memory: implement snapshot/rollback (structured-clone the store maps around `fn`). Wrapped sync adapters: delegate to the native adapter's transaction (the wrapper can detect it — make `getNativeSyncAdapter` sniffing internal to the wrapper instead of leaking into core; see 6.4).
- **AC:** a failing multi-step workflow leaves no partial state on any adapter.

### 3.8 Postgres governance persistence (hosted parity)
- **Where:** optional governance methods (`getGovernanceState` etc.) exist only in SQLite; hosted deployments silently don't persist contracts/invariants
- **Fix:** implement the optional governance methods on Postgres (tables already conceptually defined by the SQLite v18 shape).
- **AC:** put contract → restart server on Postgres → contract still active.

### 3.9 Scope-model documentation & guards
- **Where:** `contracts/identity.ts:73-86` — `workspace` widening ignores `system_id`; **no** level filters `collaboration_id`; `workspace_id` defaults `'default'` so unrelated systems co-mingle
- **Fix (design decision, then code):** document the widening matrix precisely; add `collaboration` as a real filter dimension for `shared_collaboration` visibility; consider warning when widening matches records only via defaulted `'default'` workspace. Also: tighten `source_documents` scope columns (`tenant_id` DEFAULT `''` at `sqlite/schema.ts:687`, `postgres/schema.sql:677`) to NOT NULL without default, and add scope params to adapter by-id reads (`contracts/storage.ts:83, 121, 195, 204`) as an optional-but-recommended defense-in-depth signature (enforced when provided).
- **AC:** documented matrix matches conformance-suite assertions; `shared_collaboration` items don't surface outside their collaboration.

### 3.10 Cross-adapter conformance suite (the enforcement mechanism)
- One spec file per storage contract area, parameterized over `[memory, sqlite, postgres]` (pg skipped locally without `POSTGRES_TEST_URL`, mandatory in CI where the pgvector service exists). This suite is the acceptance harness for 3.2–3.9 and the permanent guard against re-divergence.
- **AC:** suite runs all three adapters in CI; any Phase 3 behavior is asserted exactly once, in it.

---

## Phase 4 — Honest surfaces: docs, spec, examples (can ship alongside Phases 1–3)

### 4.1 OpenAPI truth
- Delete (or implement — see 4.5) the five phantom paths: `/v1/documents`, `/v1/documents/{id}`, `/v1/export/markdown`, `/v1/lint/knowledge`, `/v1/promote-response` (openapi.yaml:2409-2648). Add the missing real ones: `/v1/sessions/{id}/snapshot`, `/v1/sessions/{id}/refresh`.
- Add a **path-set parity assertion** to `openapi-contract.test.ts`: every spec path has a route, every route has a spec path (allowlist for admin/health if intentionally undocumented).
- **AC:** parity test green; generated clients hit no 404s.

### 4.2 README & claims cleanup (finish the uncommitted rewrite)
- The working-tree README rewrite (−432 lines) is directionally right — land it, plus:
  - Remove "100/100 codebase score" (or restate as "regression-gated evals"); the current framing is self-graded (`evals/memory-quality/shared.mjs:70-98`, threshold fitted at `:48`).
  - Caveat contradiction detection: slot-key matching over a fixed vocabulary (`extractor.ts:54-66, 462-493`), not general semantic contradiction detection.
  - State that `reflect({query})` requires an LLM client; fix or fence the zero-config example (`manager.ts:2870-2883`).
  - Token budgets: document that no budget is set by default; see 4.4.
  - Multi-tenancy: document the trust model (post-1.1: keys bind to tenants; pre-1.1: single trust domain).
  - Python client: replace "full HTTP API surface parity" with the actual coverage statement.
  - Offline tier: call "semantic similarity" what it is (hashed lexical/trigram matching).
- Document temporal replay limits: 5,000-event default cap (`temporal.ts:130-153`), lexical-only ranking in replay, pre-cutover inexactness.

### 4.3 Examples in CI
- Fix wrong package names (`examples/hosted-service.ts:1`, `examples/multi-agent-postgres.ts:8` import `memory-layer/...` instead of `ai-memory-layer/...`) and the nonexistent `wrapped.trackedWorkItems` (`examples/autonomous-agent.ts:42`).
- Add `tsc --noEmit` over `examples/` (against built `dist/` types) to CI.
- **AC:** CI fails if an example drifts.

### 4.4 Default token budgets
- **Where:** `contracts/policy.ts:176` (`Number.MAX_SAFE_INTEGER`), `presets.ts` (no preset sets a budget)
- **Fix:** each preset sets a realistic default budget (e.g. ai_ide 8k, chat_agent 4k, autonomous_agent 6k — tune against evals); keep unbounded available explicitly (`tokenBudget: 'unlimited'`). Document tiktoken wiring; consider auto-using it via optional dependency detection like better-sqlite3.
- **AC:** default `getContext()` output for an oversized corpus is trimmed with a trace; eval suite budgets updated.

### 4.5 Decide the Phase-5 wiki endpoints
- The manager already implements documents/lint/markdown-export/promote-response — only HTTP routes are missing. Recommend: implement the five routes (small — each is a thin dispatch to an existing manager method) rather than deleting them from the spec, since MCP already exposes them (`memory_refresh_documents` exists). Whichever way, 4.1's parity test enforces the outcome.

### 4.6 Small stuff
- CLI `--help`: document `MEMORY_PORT` (`bin/memory-server.mjs:48-62`).
- Remove stray empty `memory-layer/src/__tests__/` nested dir; find the mis-CWD'd script that created it; add `memory-layer/` to `.gitignore`.
- Reconcile `.npmignore` vs `files` (keep `files`, delete `.npmignore`).
- Verify PyPI publishes under exactly one name (stale `memory_layer_client-3.0.0.dist-info` suggests a rename; deprecate the old name if it exists on PyPI).
- Single publish pipeline: eliminate the "parallel repos" race at the source — one canonical repo/workflow publishes; the other consumes.

---

## Phase 5 — Verification that verifies (parallel with Phases 2–3; gates them)

### 5.1 Real retrieval eval
- Replace the 2-fact/1-query gate (`evals/retrieval-quality.mjs`) with a dataset of ≥100 fact/query pairs including: paraphrase matches (no shared keywords), distractors, cross-class ranking cases, trust-vs-recency tradeoffs. Score MRR/recall@k with thresholds that a pure `grep` baseline demonstrably fails. Keep the delta-ratchet mechanism (it's the honest part).

### 5.2 Memory-quality evals: reframe and de-fit
- Remove the score cap presentation (report raw metric values, not `min(x/threshold,1)`-averaged "100"); flag threshold-below-baseline entries (e.g. `aliasResolutionQuality: (2/3)*0.85` at `shared.mjs:48`) as "known-weak" rather than passing; grow single-example metrics (`falseMemoryRate` from 1 example) to ≥20 cases each. Keep mocked-LLM determinism for CI, but add an optional live-provider eval profile for local runs.

### 5.3 Postgres behavioral coverage
- Remove `src/adapters/postgres/**` from the coverage-threshold exclusion (`vitest.config.ts:27`) once the conformance suite (3.10) runs against pg in CI; delete the regex-against-schema.sql pseudo-tests (`postgres-adapter.test.ts:15-24`) in favor of behavioral asserts.
- Temporal replay equivalence tests against SQLite **and** Postgres event logs (currently in-memory only, `temporal-replay.test.ts:581`): property test — random op sequence, checkpoint live state at T, replay to T, assert equality.

### 5.4 Concurrency test tier
- New `*.concurrency.test.ts` tier (pg-only, CI service): claim races (0.2), optimistic-lock races (0.7), lazy-expiry double-emission (2.5), parallel compaction on one scope.

### 5.5 Benchmarks with memory
- Check in benchmark results per release (`benchmarks/results/<version>.json`); CI compares against previous and warns on >20% regression. Low priority; do last.

---

## Phase 6 — Architecture consolidation (5.0.0)

Breaking release. Everything above lands first so 5.0.0 is purely structural.

### 6.1 Mechanize the sync/async storage duality  *(highest payoff/effort ratio — can start early, non-breaking)*
- Define `StorageAdapter` once; derive `AsyncStorageAdapter` via a mapped type; replace the hand-written 107-method `wrapSyncAdapter` (`adapters/sync-to-async.ts`) with a `Proxy`/loop. Divergence becomes a compile error.
- **AC:** adding a storage method in one place fails the build until implemented everywhere; ~500 lines deleted.

### 6.2 Capability facades on `MemoryManager`
- Split the 92-method facade (`manager.ts:252-506`) into namespaces: `memory.coordination.*`, `memory.governance.*`, `memory.temporal.*`, `memory.playbooks.*`, `memory.curation.*`, `memory.graph.*`; top level keeps ~15 daily drivers (`processTurn`, `getContext`, `search`, `learnFact`, `getProfile`, `runMaintenance`, `close`, …). Ship flat methods as deprecated delegating shims for one major; remove in 6.0.0.
- Extract the manager's mutable caches (governance, last-maintenance/reflection/derived at `manager.ts:778-783`) into the owning capability modules.
- **AC:** top-level surface ≤ 20 methods; each namespace independently testable.

### 6.3 One operation registry → generated HTTP + MCP
- Define operations once (name, params schema, manager method, result serializer, auth requirements); generate the ~82 HTTP routes and a curated MCP toolset from it. Split MCP into a default core set (~20 tools) and an `--admin-tools` set (63 is past LLM tool-selection comfort). OpenAPI becomes generated output, making 4.1's parity structural.
- **AC:** adding an operation = one registry entry; transport-parity test replaced by construction; MCP default set ≤ 25 tools.

### 6.4 Composition layer & layering fixes
- Move `quick.ts`, `provider-managers.ts`, `presets.ts` → `src/composition/`; move `sync-to-async` and `StructuredGenerationClient` types → `contracts/`; core imports only contracts. Make native-transaction detection internal to the async wrapper so `manager.ts:176`/`orchestrator.ts:54` stop sniffing adapters. Untangle the two type-only contract cycles.
- **AC:** dependency-cruiser (or eslint boundary rule) added to CI enforcing contracts ← core ← composition/adapters/server.

### 6.5 API surface diet
- Tier the 374 exports: Tier 1 (core ~15 symbols), Tier 2 (capabilities/contracts), stop barrel-exporting internals. Deprecate `qualityTier` vs `qualityMode` overlap (fold into named profiles); add `resolveEffectiveConfig()` returning the merged config with per-field provenance.
- Unify the three taxonomies (knowledge classes / cognitive overlay / derived types): knowledge classes canonical; cognitive overlay becomes a documented view (and stop hardcoding `episodic: []`); define the promotion story `derived playbook_candidate → playbook` and `procedure`-class facts' relation to playbooks.

### 6.6 Provider error discipline & Python client
- Wrap summarizer/embedding/integration throws in `ProviderUnavailableError` at the boundary (13 bare `Error` throws in summarizers alone).
- Python client: generate sync + async from the operation registry (6.3) or a shared template; drop hand-maintained ~1,400-line duplication.

---

## Sequencing & release train

| Release | Contents | Gate |
|---------|----------|------|
| **4.1.1** (now) | Phase 0 (0.1–0.7) | new claim/migration/parity regression tests |
| **4.2.0** | Phase 1 (security) + 4.1/4.2/4.6 doc truth | tenant-binding integration tests |
| **4.3.0** | Phase 2 (event/embedding integrity) + 5.3/5.4 tests | replay-equivalence property test green on SQLite+pg |
| **4.4.0** | Phase 3 (parity) + 3.10 conformance suite + 4.4/4.5 | conformance suite green on all 3 adapters in CI |
| **4.5.0** | Phase 5 evals (5.1/5.2/5.5) + 6.1 (non-breaking) | grep-baseline fails the new retrieval eval |
| **5.0.0** | Phase 6 (6.2–6.6) | boundary lint in CI; deprecation shims in place |

Dependencies to respect: 0.3 (migration safety) lands with/before 0.1 (which needs a migration). 3.10 (conformance suite) is written incrementally as each 3.x item is fixed — it's the acceptance harness, not an afterthought. 6.3 (registry) should precede large new endpoint work so the phantom-endpoint class can't recur. 1.1 is additive (wildcard-key compat mode) so it stays minor; flipping secure-by-default for non-Docker deployments waits for 5.0.0.

## Explicitly deferred / accepted as-is
- `streamChanges` stays polling-based (documented, not renamed) — fine at current scale.
- Offline extractor stays regex-grade — the trust gate is the quality mechanism; docs say so honestly (4.2).
- In-memory adapter keeps simpler search (documented) but must pass the shared *semantics contract* (3.2) for defaults/filters/ordering.
- `bootstrapTemporalCutover` full-DB replay lock window: document "first open after upgrade should be done by one process"; revisit only if reported.
