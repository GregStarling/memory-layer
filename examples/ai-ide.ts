import {
  createMemoryRuntime,
  createOpenAIMemoryManager,
} from 'memory-layer';

async function main(): Promise<void> {
  const sharedWorkspace = 'repo-memory';
  const taskScope = {
    tenant_id: 'acme',
    system_id: 'ai-ide',
    workspace_id: sharedWorkspace,
    scope_id: 'refactor-task-42',
  };

  const manager = createOpenAIMemoryManager({
    dbPath: './data/ai-ide.db',
    scope: taskScope,
    preset: 'ai_ide',
    crossScopeLevel: 'workspace',
  });
  const runtime = createMemoryRuntime(manager);

  manager.trackWorkItem('Preserve hybrid retrieval behavior', 'objective', 'in_progress');
  const prepared = await runtime.beforeModelCall(
    'Refactor the manager but keep semantic retrieval working.',
  );
  console.log(prepared.bootstrapPrompt);
  console.log(prepared.messages);
  await runtime.afterModelCall({
    userInput: 'Refactor the manager but keep semantic retrieval working.',
    assistantOutput: 'I will preserve hybrid retrieval and check the session bootstrap path.',
  });

  manager.close();
}

void main();
