import { createLangChainMemoryBridge, createMemory } from 'ai-memory-layer';

async function main() {
  const manager = createMemory({
    adapter: 'sqlite',
    path: './data/langchain.db',
    preset: 'chat_agent',
    scope: 'langchain-thread',
  });

  const memory = createLangChainMemoryBridge(manager);
  await memory.saveContext(
    { input: 'Remember that the customer prefers weekly summaries.' },
    { output: 'Stored. I will keep that preference in memory.' },
  );

  const variables = await memory.loadMemoryVariables({ input: 'customer preference' });
  console.log(variables.context);

  await manager.close();
}

main().catch(console.error);
