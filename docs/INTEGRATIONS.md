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

The repo now ships tested integrations for:

- Claude-adjacent agent wrapping via `wrapClaudeAgentModel()`
- OpenAI/Claude tool-call surfaces via `createOpenAIMemoryTools()` and `createClaudeMemoryTools()`
- Vercel AI SDK middleware-style wrapping via `wrapVercelAIModel()`
- LangChain chat-history style bridging via `createLangChainMemoryBridge()`

Runnable examples:

- `examples/autonomous-agent.ts`: Claude-style lifecycle wrapping without requiring a provider SDK just to understand the flow
- `examples/tool-calling-agent.ts`: OpenAI-compatible tool surface
- `examples/langchain.ts`: LangChain memory variable bridge
- `examples/multi-agent-postgres.ts`: real Postgres-backed shared memory using `MEMORY_DATABASE_URL`
- `clients/python/`: hosted Python client helpers for service-oriented deployments
