import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createMemoryRuntime } from '../core/runtime.js';
import { createClaudeMemoryTools } from '../integrations/claude-tools.js';
import { createMemoryMcpAdapter } from '../integrations/mcp.js';
import { createOpenAIMemoryTools } from '../integrations/openai-tools.js';
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
});
