# Operations Guide

## Health Endpoints

- `GET /healthz`: process liveness
- `GET /readyz`: process readiness and active scope count
- `GET /v1/health`: per-scope memory counters
- `GET /v1/events`: server-sent events for memory activity

## Compaction and Maintenance

Use the admin surface for lifecycle operations:

```bash
curl -X POST http://localhost:3100/v1/compact \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "x-admin-key: $MEMORY_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope":{"tenant_id":"acme","system_id":"ai-ide","scope_id":"task-42"}}'
```

```bash
curl -X POST http://localhost:3100/v1/maintenance \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "x-admin-key: $MEMORY_ADMIN_API_KEY"
```

## Scope Routing

Requests can resolve scope three ways:

1. `scope` object in the JSON body
2. Query parameters: `tenant_id`, `system_id`, `workspace_id`, `scope_id`
3. Headers: `x-memory-tenant`, `x-memory-system`, `x-memory-workspace`, `x-memory-scope`

Use body scope when the request already has a JSON payload. Use headers for shared gateways or framework middleware.

## Recommended Alerts

- Sustained growth in `activeTurnCount`
- Low or zero `knowledgeCount` for a workload that should learn
- Repeated `compacted: false` results during forced compaction
- Large `expiredWorkingMemory` or `retiredKnowledge` spikes during maintenance

## Data Hygiene

- Redact sensitive text at ingest using `redactText`.
- Prefer tenant and workspace boundaries that match your product’s isolation model.
- Export memory before major schema or provider changes.
