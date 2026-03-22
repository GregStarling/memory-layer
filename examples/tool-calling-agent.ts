import {
  createMemory,
  createMemoryRuntime,
  createOpenAIMemoryTools,
} from 'ai-memory-layer';

async function main(): Promise<void> {
  const manager = createMemory({
    adapter: 'sqlite',
    path: './data/tool-agent.db',
    scope: {
      tenant_id: 'acme',
      system_id: 'tool-agent',
      workspace_id: 'shared-tools',
      scope_id: 'run-1',
    },
    preset: 'autonomous_agent',
  });

  const runtime = createMemoryRuntime(manager);
  const tools = createOpenAIMemoryTools(runtime);

  console.log(tools.tools);
  console.log(
    await tools.invokeTool('memory_prepare_call', {
      input: 'Plan the next autonomous step and remember the deployment constraint.',
    }),
  );

  await manager.close();
}

void main();
