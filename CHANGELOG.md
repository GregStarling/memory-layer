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

- Added retrieval, context assembly, observability, summarizer/extractor helpers, knowledge growth, policy controls, semantic search, hybrid ranking, and a `MemoryManager` facade.
- Added examples, eval scripts, benchmark scripts, CI, package hardening, and release validation checks.
