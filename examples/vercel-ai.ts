import {
  createMemory,
  createMemoryRuntime,
  prepareVercelAIInput,
  wrapVercelAIModel,
} from 'memory-layer';

async function fakeGenerateText(input: { system?: string; messages: Array<{ role: string; content: string }> }) {
  return {
    text: `Handled with ${input.messages.length} memory messages.`,
  };
}

async function main() {
  const manager = createMemory({
    adapter: 'sqlite',
    path: './data/vercel-ai.db',
    preset: 'chat_agent',
    scope: 'demo-thread',
  });
  const runtime = createMemoryRuntime(manager);

  const prepared = await prepareVercelAIInput(runtime, 'Remember the rollout window.');
  console.log(prepared.system);

  const runWithMemory = wrapVercelAIModel(runtime, fakeGenerateText);
  const result = await runWithMemory('Deploy after the maintenance window.');
  console.log(result.responseText);

  await manager.close();
}

main().catch(console.error);
