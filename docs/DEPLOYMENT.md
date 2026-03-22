# Deployment Guide

`memory-layer` can run embedded in-process or as a standalone HTTP/MCP service.

## Embedded Package

Use the package directly when your application already runs in Node.js:

```ts
import { createMemory } from 'memory-layer';

const memory = createMemory({
  adapter: 'sqlite',
  path: './data/memory.db',
  preset: 'ai_ide',
  scope: 'default',
});
```

This is the lowest-friction option for AI IDEs, copilots, and single-service agents.

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
- Put `MEMORY_API_KEY` behind an API gateway or private network if the service is shared.
- Reserve `MEMORY_ADMIN_API_KEY` for compaction and maintenance automation.
- Keep `bodyLimitBytes` low unless you intentionally ingest large prompts or transcripts.
- Enable SSE consumers on `/v1/events` when you want real-time observability hooks.
