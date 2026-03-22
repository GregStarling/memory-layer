import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createMemoryRuntime } from '../core/runtime.js';
import { createClaudeMemoryTools } from '../integrations/claude-tools.js';
import { createLangChainMemoryBridge } from '../integrations/langchain.js';
import { createMemoryMcpAdapter } from '../integrations/mcp.js';
import { createOpenAIMemoryTools } from '../integrations/openai-tools.js';
import { prepareVercelAIInput, wrapVercelAIModel } from '../integrations/vercel-ai.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope } from './test-helpers.js';

describe('protocol integrations', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('exposes MCP tool definitions and handlers', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
    const mcp = createMemoryMcpAdapter(createMemoryRuntime(manager));

    expect(mcp.tools.map((tool) => tool.name)).toContain('memory_prepare_call');
    const result = await mcp.callTool('memory_prepare_call', {
      input: 'remember sqlite',
    });
    expect(result).toHaveProperty('prompt');
    await manager.close();
  });

  it('exposes OpenAI and Claude compatible tool definitions', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
    const runtime = createMemoryRuntime(manager);
    const openai = createOpenAIMemoryTools(runtime);
    const claude = createClaudeMemoryTools(runtime);

    expect(openai.tools[0]?.type).toBe('function');
    expect(claude.tools[0]?.name).toBe('memory_start_session');
    const result = await openai.invokeTool('memory_commit_call', {
      userInput: 'hello',
      assistantOutput: 'hi',
    });
    expect(result).toHaveProperty('exchange');
    await manager.close();
  });

  it('bridges to langchain-style memory methods', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
    const bridge = createLangChainMemoryBridge(manager);

    await bridge.saveContext(
      { input: 'Remember weekly summaries.' },
      { output: 'I will keep weekly summaries in memory.' },
    );

    const variables = await bridge.loadMemoryVariables({ input: 'weekly summaries' });

    expect(variables.history).toContain('Remember weekly summaries.');
    expect(variables.context).toContain('weekly summaries');
    await manager.close();
  });

  it('wraps vercel-ai style model calls with memory persistence', async () => {
    const manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async () => ({
        summary: 'summary',
        key_entities: [],
        topic_tags: [],
      }),
      autoCompact: false,
    });
    const runtime = createMemoryRuntime(manager);
    const prepared = await prepareVercelAIInput(runtime, 'Track deploy windows');

    expect(prepared.messages.at(-1)?.content).toBe('Track deploy windows');

    const wrapped = wrapVercelAIModel(runtime, async () => ({
      text: 'Deploy during the maintenance window.',
    }));
    const result = await wrapped('Track deploy windows');

    expect(result.responseText).toContain('maintenance window');
    const context = await manager.getContext('maintenance window');
    expect(context.activeTurns.some((turn) => turn.content.includes('maintenance window'))).toBe(true);
    await manager.close();
  });
});
