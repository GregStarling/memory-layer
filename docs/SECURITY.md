# Security Guide

## Authentication

- `apiKey` (env `MEMORY_API_KEY`) protects the general HTTP surface with a single
  bearer token. This is the legacy mode: the key is treated as a **wildcard** —
  it may act on every tenant. On startup the server logs a one-time warning
  recommending migration to the tenant-bound registry below.
- `apiKeys` (env `MEMORY_API_KEYS`) is the tenant-bound key registry. Each key is
  pinned to a tenant (or `'*'`), a cross-scope ceiling, and an optional admin
  flag. Requests whose resolved scope names a **different** tenant are rejected
  with `403`; requests asking for a wider `scope_level` / `crossScopeLevel` than
  the key's ceiling are also `403`. Prefer this for any multi-tenant deployment.
- `adminApiKey` (env `MEMORY_ADMIN_API_KEY`) separately protects force-compaction
  and maintenance endpoints via the `x-admin-key` header. This gate is
  independent of the registry `admin` flag and remains authoritative for admin
  routes.
- MCP transport is intended for local or already-trusted stdio integrations.

### `MEMORY_API_KEYS` encoding

Comma-separated entries; each entry is `key:tenant[:maxCrossScopeLevel][:admin]`.

- `key` — the bearer secret (may not contain `:` or `,`).
- `tenant` — a tenant id, or `*` for all tenants.
- `maxCrossScopeLevel` — optional; one of `scope|workspace|system|tenant`
  (defaults to `tenant`, i.e. no ceiling).
- `admin` — optional literal `admin` marking the key as admin-capable.

Examples:

```
MEMORY_API_KEYS="k1:tenantA:workspace"
MEMORY_API_KEYS="k2:*,k3:tenantB:tenant:admin"
```

Every registered key is compared timing-safely (SHA-256 + `timingSafeEqual`);
the server iterates all entries rather than doing a raw-key hash-map lookup, so
the comparison cost never short-circuits based on which key matched.

Keys are matched against `Authorization: Bearer <key>`. A tenant-bound key that
makes a request with no scope override resolves to the `default` tenant and is
therefore rejected — such keys must supply their tenant explicitly (via
`x-memory-tenant`/`x-memory-system`/`x-memory-scope` headers, `body.scope`, or
the `tenant_id`/`system_id`/`scope_id` query params).

## Rate limiting

- `requestsPerMinute` + `burst` enable an in-process, per-credential token-bucket
  limiter. Buckets are keyed by API key (or remote address when keyless), so
  distinct keys never share a budget. Over-limit requests get `429` with a
  `Retry-After` header. `/healthz` and `/readyz` are never limited.
- Rate limiting is **off by default** (undefined `requestsPerMinute`) for
  backward compatibility. Hosted deployments should set it.

## Error responses

- Unexpected (non-domain) exceptions return a generic `{ "error": "internal
  error", "requestId": "…" }` body with a `500` status. The real error (message
  and stack) is logged server-side with the same request id for correlation.
  Driver/DB internals are never returned to clients.

## Non-loopback posture

- Binding to a non-loopback host (e.g. `0.0.0.0`) with **no** auth configured
  logs a prominent startup warning. The Docker entrypoint hard-fails in this
  configuration; the app itself warns rather than refusing to start.

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
