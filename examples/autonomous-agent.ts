import {
  createMemory,
  createMemoryRuntime,
  wrapClaudeAgentModel,
} from 'ai-memory-layer';

async function main(): Promise<void> {
  const scope = {
    tenant_id: 'acme',
    system_id: 'autonomous-agent',
    workspace_id: 'dark-factory',
    scope_id: 'run-2026-03-21',
  };

  const manager = createMemory({
    adapter: 'sqlite',
    path: './data/autonomous-agent.db',
    scope,
    preset: 'autonomous_agent',
  });
  const runtime = createMemoryRuntime(manager, {
    inferWorkItems: () => [
      {
        title: 'Prepare local deployment plan',
        kind: 'objective',
        status: 'in_progress',
      },
    ],
  });

  const runAgentTurn = wrapClaudeAgentModel(runtime, async (prepared) => {
    console.log(prepared.system);
    console.log(prepared.tools.map((tool) => tool.name));
    return {
      text: 'Logged. I will prefer local, auditable deployment plans.',
    };
  });
  const wrapped = await runAgentTurn('The agent must keep deployments local and auditable.');

  const search = await manager.search('local auditable');
  console.log(search.knowledge);
  console.log(wrapped.trackedWorkItems);
  console.log(manager.recall({ start_at: 0 }));

  await manager.close();
}

void main();
