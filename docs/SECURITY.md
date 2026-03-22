# Security Guide

## Authentication

- `apiKey` protects the general HTTP surface with bearer auth.
- `adminApiKey` separately protects force-compaction and maintenance endpoints.
- MCP transport is intended for local or already-trusted stdio integrations.

## Recommended Defaults

- Bind the HTTP server to `127.0.0.1` unless you intentionally expose it.
- Keep `bodyLimitBytes` close to your expected prompt sizes.
- Run the service behind TLS termination when exposed beyond localhost.

## Sensitive Data Handling

- Use `redactText` to scrub secrets before they enter turns, working memory, or knowledge memory.
- Avoid sharing tenant-level scopes across customers.
- Audit `relevantKnowledge` and `searchCrossScope()` use before enabling broad cross-scope retrieval.

## Release Hygiene

- Only publish built assets under `dist/`.
- Keep provider SDKs as optional peers so non-provider installs stay lean.
- Use `npm run release:check` before publishing.
