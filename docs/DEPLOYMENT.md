# Deployment Guide

`memory-layer` can run embedded in-process or as a standalone HTTP/MCP service.

## Embedded Package

Use the package directly when your application already runs in Node.js:

```ts
import { createMemory } from 'ai-memory-layer';

const memory = createMemory({
  adapter: 'sqlite',
  path: './data/memory.db',
  preset: 'ai_ide',
  scope: 'default',
});
```

This is the lowest-friction option for AI IDEs, copilots, and single-service agents.

The zero-config quick path is pure-JS and ephemeral. For durable local storage, install the optional `better-sqlite3` package and pass `adapter: 'sqlite'` with a file path.

## Standalone HTTP Service

Run the built-in server when multiple processes need shared memory:

```bash
npx memory-layer serve \
  --transport http \
  --db ./data/memory.db \
  --preset autonomous_agent \
  --port 3100
```

Recommended environment variables:

```bash
MEMORY_DB_PATH=./data/memory.db
MEMORY_TRANSPORT=http
MEMORY_PORT=3100
MEMORY_API_KEY=replace-me
MEMORY_ADMIN_API_KEY=replace-me-admin
```

## Docker

Build and run the provided image:

```bash
docker build -t memory-layer .
docker run --rm \
  -p 3100:3100 \
  -v "$(pwd)/data:/data" \
  -e MEMORY_API_KEY=local-dev-key \
  -e MEMORY_ADMIN_API_KEY=local-dev-admin \
  memory-layer
```

The container persists SQLite data under `/data/memory.db`.

## MCP Transport

Use the MCP server when integrating with AI tools that speak the Model Context Protocol:

```bash
npx memory-layer serve --transport mcp --db ./data/memory.db --preset ai_ide
```

The server reads and writes on stdio, so it fits directly into MCP-compatible runtimes.

## Production Notes

- Use a file-backed SQLite database or Postgres for durable deployments.
- Install `better-sqlite3` only when you want the durable SQLite path.
- Install `pg` only when you want the hosted Postgres path.
- Treat SQLite as the lowest-friction embedded path. Its semantic retrieval is an in-process scan over local embeddings, which is appropriate for local and moderate-sized workloads but not the strongest scaling path.
- Treat SQLite HTTP/MCP deployments as a single-process service contract. It is the right fit when one runtime owns writes and other components talk to that one service.
- Use Postgres when multiple processes, workers, or hosted instances need to write shared memory concurrently. That is the operationally safe multi-writer path.
- For the strongest hosted retrieval path, use Postgres with the `pgvector` extension enabled and keep the `knowledge_embeddings` HNSW index from `src/adapters/postgres/schema.sql`.
- Put `MEMORY_API_KEY` behind an API gateway or private network if the service is shared.
- Reserve `MEMORY_ADMIN_API_KEY` for compaction and maintenance automation.
- Keep `bodyLimitBytes` low unless you intentionally ingest large prompts or transcripts.
- Enable SSE consumers on `/v1/events` when you want real-time observability hooks.
