import {
  createClaudeMemoryManager,
  createMemoryRuntime,
} from 'memory-layer';

async function main(): Promise<void> {
  const scope = {
    tenant_id: 'acme',
    system_id: 'autonomous-agent',
    workspace_id: 'dark-factory',
    scope_id: 'run-2026-03-21',
  };

  const manager = createClaudeMemoryManager({
    dbPath: './data/autonomous-agent.db',
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

  const wrapped = await runtime.wrapModelCall(async (payload) => {
    console.log(payload.prompt);
    return 'Logged. I will prefer local, auditable deployment plans.';
  }, 'The agent must keep deployments local and auditable.');

  const search = await manager.search('local auditable');
  console.log(search.knowledge);
  console.log(wrapped.trackedWorkItems);
  console.log(manager.recall({ start_at: 0 }));

  manager.close();
}

void main();
