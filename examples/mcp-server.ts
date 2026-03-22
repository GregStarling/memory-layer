import {
  createClaudeMemoryManager,
  createMemoryMcpAdapter,
  createMemoryRuntime,
} from 'memory-layer';

async function main(): Promise<void> {
  const manager = createClaudeMemoryManager({
    dbPath: './data/mcp-memory.db',
    scope: {
      tenant_id: 'acme',
      system_id: 'mcp-server',
      scope_id: 'session-1',
    },
    preset: 'chat_agent',
  });

  const runtime = createMemoryRuntime(manager);
  const adapter = createMemoryMcpAdapter(runtime);

  console.log(adapter.tools);
  console.log(
    await adapter.callTool('memory_start_session', {
      relevanceQuery: 'memory adoption',
    }),
  );

  manager.close();
}

void main();
