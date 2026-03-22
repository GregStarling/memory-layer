# memory-layer-client

Python client for the `memory-layer` HTTP service.

## Install

```bash
pip install memory-layer-client
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
