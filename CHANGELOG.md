# Changelog

All notable changes to `memory-layer` are documented here.

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
