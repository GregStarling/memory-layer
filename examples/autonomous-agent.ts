import {
  createMemoryManager,
  createRegexExtractor,
  createSQLiteAdapterWithEmbeddings,
  createSessionId,
} from 'memory-layer';

async function main(): Promise<void> {
  const scope = {
    tenant_id: 'acme',
    system_id: 'autonomous-agent',
    workspace_id: 'dark-factory',
    scope_id: 'run-2026-03-21',
  };

  const adapter = createSQLiteAdapterWithEmbeddings('./data/autonomous-agent.db');
  const manager = createMemoryManager({
    adapter,
    scope,
    sessionId: createSessionId(scope),
    summarizer: async (turns) => ({
      summary: `Agent checkpoint after ${turns.length} turns`,
      key_entities: ['deployment', 'memory'],
      topic_tags: ['automation'],
    }),
    extractor: createRegexExtractor(),
    embeddingAdapter: adapter.embeddings,
    embeddingGenerator: async (texts) =>
      texts.map((text) => new Float32Array([text.length, 1, 0])),
  });

  await manager.processTurn('user', 'The agent must keep deployments local and auditable.');
  await manager.processTurn('assistant', 'Logged. I will prefer local, auditable deployment plans.');

  const search = manager.search('local auditable');
  console.log(search.knowledge);

  manager.close();
}

void main();
