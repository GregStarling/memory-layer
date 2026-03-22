import {
  createClaudeMemoryManager,
  createMemoryRuntime,
} from 'ai-memory-layer';

async function main(): Promise<void> {
  const scope = {
    tenant_id: 'acme',
    system_id: 'chat-assistant',
    workspace_id: 'customer-support',
    scope_id: 'conversation-123',
  };

  const manager = createClaudeMemoryManager({
    dbPath: './data/chat-assistant.db',
    scope,
    preset: 'chat_agent',
  });
  const runtime = createMemoryRuntime(manager);

  const prepared = await runtime.beforeModelCall('I prefer short answers and local-first tools.');
  console.log(prepared.prompt);
  await runtime.afterModelCall({
    userInput: 'I prefer short answers and local-first tools.',
    assistantOutput: 'Understood. I will keep replies concise.',
  });

  manager.close();
}

void main();
