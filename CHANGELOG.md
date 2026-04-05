# Changelog

All notable changes to `memory-layer` are documented here.

## 2.0.0

- Repositioned `memory-layer` as a standalone memory platform for AI systems, with reusable manager, runtime, HTTP, and MCP surfaces.
- Added multi-scope request routing for HTTP and MCP servers, plus stronger scope-aware retrieval behavior.
- Introduced pluggable token estimation, richer extraction and monitor customization, batch storage operations, and pagination support.
- Improved retrieval quality with hybrid ranking updates, semantic defaults, embedding retry/caching helpers, and a local embedding fallback.
- Added provenance-backed knowledge metadata, confidence scoring, verification state, contradiction auditing, and consolidation during maintenance.
- Hardened runtime behavior with circuit breakers, admin separation, body limits, health endpoints, and event streaming.
- Expanded the evidence layer with evaluation fixes, coverage thresholds, snapshot coverage, and cross-adapter validation.
- Added OpenAPI, Docker, release automation, product docs, and a larger example/integration surface for adoption.

# Changelog

All notable changes to this project should be documented in this file.

The format is based on Keep a Changelog and the project currently tracks
unreleased work before its first public release.

## Unreleased

### Breaking

- **`getProfile` / `memory_get_profile` / `GET /v1/profile` now default to trusted knowledge only.** Provisional-state knowledge was previously included by default; callers must now opt in with `includeProvisional: true` (or `?includeProvisional=true`) to see it. The tool description has always said profiles are built from trusted knowledge, so this fixes the default to match the contract — but any caller that was relying on provisional leakage will see fewer entries. Disputed entries continue to require `includeDisputed: true`.

### Fixed

- Added retrieval, context assembly, observability, summarizer/extractor helpers, knowledge growth, policy controls, semantic search, hybrid ranking, and a `MemoryManager` facade.
- Added examples, eval scripts, benchmark scripts, CI, package hardening, and release validation checks.
