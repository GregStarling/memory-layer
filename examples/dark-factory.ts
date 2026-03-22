/**
 * Dark Factory Example
 *
 * Demonstrates an autonomous agent loop with:
 * - Streaming response support
 * - Cross-scope knowledge retrieval
 * - Aggressive compaction preset
 * - Work item tracking
 */
import {
  createMemory,
  createMemoryRuntime,
  createStreamCollector,
} from 'memory-layer';

const manager = createMemory({
  adapter: 'sqlite',
  path: './data/factory.db',
  scope: {
    tenant_id: 'dark-factory',
    system_id: 'orchestrator',
    workspace_id: 'production',
    scope_id: `run-${Date.now()}`,
  },
  preset: 'autonomous_agent',
  summarizer: 'extractive',
  extractor: 'regex',
});

const runtime = createMemoryRuntime(manager);

async function* mockModelStream(prompt: string): AsyncGenerator<string> {
  // In production, this would be your model's streaming API
  const words = `I will process the task based on the provided context. ${prompt.slice(0, 50)}`.split(' ');
  for (const word of words) {
    yield word + ' ';
  }
}

async function agentLoop() {
  // Bootstrap session with relevant context
  const { bootstrapPrompt } = await runtime.startSession('autonomous orchestration');
  console.log('Session started with bootstrap:', bootstrapPrompt.slice(0, 100));

  // Track the current objective
  await manager.trackWorkItem('Process incoming work queue', 'objective', 'in_progress');

  // Simulate 5 agent iterations
  for (let i = 0; i < 5; i++) {
    const userInput = `Task ${i + 1}: Process batch item ${i + 1}`;

    // Get context-enriched prompt
    const prepared = await runtime.beforeModelCall(userInput);

    // Stream the model response
    const collector = createStreamCollector(manager, 'assistant');
    for await (const chunk of mockModelStream(prepared.prompt)) {
      collector.write(chunk);
      process.stdout.write(chunk); // Stream to stdout
    }
    console.log();

    const assistantOutput = collector.getText();
    await collector.finalize();

    // Record the user turn too
    await manager.processTurn('user', userInput);

    // Learn facts from the interaction
    await manager.learnFact(
      `Batch item ${i + 1} processed successfully`,
      'entity',
      'medium',
    );

    console.log(`Iteration ${i + 1} complete.`);
  }

  // Run maintenance to clean up
  const report = await manager.runMaintenance();
  console.log('Maintenance report:', report);

  await manager.close();
}

agentLoop().catch(console.error);
