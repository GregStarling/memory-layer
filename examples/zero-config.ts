import { createMemory } from 'memory-layer';

async function main(): Promise<void> {
  const memory = createMemory();

  await memory.processExchange(
    'Remember that this project must stay local-first.',
    'Stored. I will keep local-first constraints in memory.',
  );

  const context = await memory.getContext('local-first');
  console.log(context.currentObjective);
  console.log(context.relevantKnowledge);

  memory.close();
}

void main();
