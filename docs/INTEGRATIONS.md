# Integration Guide

## Core Choices

Pick the narrowest integration surface that fits your system:

- Package API: best for Node apps and AI IDE extensions
- HTTP API: best for polyglot services and hosted memory
- MCP server: best for tools that already use MCP

## AI IDE Pattern

Use `createMemoryRuntime()` to inject prompt-ready context before each model call and persist the exchange afterward:

```ts
const prepared = await runtime.beforeModelCall(userInput);
const result = await model(prepared.prompt);
await runtime.afterModelCall({
  userInput,
  assistantOutput: result,
});
```

## Hosted Service Pattern

Run one HTTP service and route each request into its own scope:

- `tenant_id`: customer or org
- `system_id`: product surface
- `workspace_id`: shared project memory
- `scope_id`: thread, task, run, or conversation

Operational contract:

- Use a single SQLite-backed service when one process should own writes.
- Use Postgres-backed hosting when multiple workers or agents need concurrent shared-memory writes.
- Use `collaboration_id` when memory must be intentionally shared across distinct systems without collapsing all workspace memory together.

## Autonomous Agent Pattern

Use the `autonomous_agent` preset, aggressive compaction, work-item tracking, and periodic maintenance:

```ts
await manager.trackWorkItem('Finish migration rollout', 'objective', 'in_progress');
await runtime.afterModelCall({ userInput, assistantOutput });
await manager.runMaintenance();
```

## Framework Adapters

The repo now ships reference integrations for:

- Vercel AI SDK middleware-style wrapping
- LangChain chat-history style memory bridging
- Python HTTP client helpers for service-oriented deployments

See `src/integrations/` and `clients/python/` for concrete examples.
