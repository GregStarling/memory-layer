import {
  createMemoryManager,
  createRegexExtractor,
  createSQLiteAdapter,
  createSessionId,
} from 'memory-layer';

async function main(): Promise<void> {
  const scope = {
    tenant_id: 'acme',
    system_id: 'chat-assistant',
    workspace_id: 'customer-support',
    scope_id: 'conversation-123',
  };

  const manager = createMemoryManager({
    adapter: createSQLiteAdapter('./data/chat-assistant.db'),
    scope,
    sessionId: createSessionId(scope),
    summarizer: async (turns) => ({
      summary: `Conversation summary across ${turns.length} turns`,
      key_entities: ['customer', 'support'],
      topic_tags: ['support'],
    }),
    extractor: createRegexExtractor(),
  });

  await manager.processTurn('user', 'I prefer short answers and local-first tools.');
  await manager.processTurn('assistant', 'Understood. I will keep replies concise.');

  const context = manager.getContext('local-first short answers');
  console.log(context);

  manager.close();
}

void main();
