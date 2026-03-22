# memory-layer-client

Python client for the `memory-layer` HTTP service.

## Install

```bash
pip install memory-layer-client
```

For local development and tests:

```bash
pip install -e '.[dev]'
pytest
```

## Quick Start

```python
from memory_layer_client import MemoryClient, MemoryScope

client = MemoryClient(
    "http://localhost:3100",
    api_key="dev-key",
    default_scope=MemoryScope(
        tenant_id="acme",
        system_id="python-worker",
        collaboration_id="release-42",
        scope_id="run-42",
    ),
)

client.store_exchange(
    "Remember that deployments must stay blue-green.",
    "Stored. I will keep rollout constraints in memory.",
)

context = client.get_context(query="rollout constraints")
print(context.token_estimate)
```

## Async Client

```python
import asyncio
from memory_layer_client import AsyncMemoryClient

async def main() -> None:
    client = AsyncMemoryClient("http://localhost:3100", api_key="dev-key")
    await client.store_turn("user", "Track migration status.")
    health = await client.health()
    print(health.active_turn_count)
    await client.aclose()

asyncio.run(main())
```

## Scope Resolution

Each request can inherit a default scope and override it per call. This matches the multi-tenant routing model used by the HTTP server.

`MemoryScope` also supports `collaboration_id`, so Python clients can participate in shared multi-agent workspaces the same way the TypeScript server and SDK do.

## Hosted Inspection And Changes

```python
from memory_layer_client import MemoryClient

client = MemoryClient("http://localhost:3100")

knowledge = client.list_knowledge(limit=20)
detail = client.inspect_knowledge(knowledge.items[0]["id"])
changes = client.poll_changes("2026-03-01T00:00:00Z", scope_level="workspace")
cross_scope = client.search_cross_scope("rollback", scope_level="workspace")
```

## CLI

```bash
memory-layer-client --base-url http://localhost:3100 health
memory-layer-client --base-url http://localhost:3100 search "rollback checklist"
memory-layer-client --base-url http://localhost:3100 inspect-knowledge --limit 10
memory-layer-client --base-url http://localhost:3100 run-reverification --admin-key secret
```
