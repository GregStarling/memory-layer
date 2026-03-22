import { describe, it, expect, afterEach } from 'vitest';
import { createMcpServerHandler } from '../server/mcp-server.js';

describe('MCP server handler', () => {
  let handler: ReturnType<typeof createMcpServerHandler>;

  afterEach(async () => {
    if (handler) await handler.close();
  });

  it('lists all expected tools', () => {
    handler = createMcpServerHandler();
    expect(handler.tools.length).toBe(9);
    const names = handler.tools.map((t) => t.name);
    expect(names).toContain('memory_store_turn');
    expect(names).toContain('memory_store_exchange');
    expect(names).toContain('memory_get_context');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_learn_fact');
    expect(names).toContain('memory_track_work');
    expect(names).toContain('memory_force_compact');
    expect(names).toContain('memory_get_health');
    expect(names).toContain('memory_run_maintenance');
  });

  it('stores and retrieves turns via tool calls', async () => {
    handler = createMcpServerHandler();

    const storeResult = await handler.callTool('memory_store_exchange', {
      userContent: 'Always use TypeScript for new code.',
      assistantContent: 'Got it, I will use TypeScript.',
    });
    expect(storeResult.isError).toBeUndefined();
    const stored = JSON.parse(storeResult.content[0].text);
    expect(stored.stored).toBe(true);
    expect(stored.userTurnId).toBeDefined();

    const contextResult = await handler.callTool('memory_get_context', {
      relevanceQuery: 'TypeScript',
    });
    expect(contextResult.isError).toBeUndefined();
    const context = JSON.parse(contextResult.content[0].text);
    expect(context.activeTurnCount).toBeGreaterThan(0);
  });

  it('learns facts and searches for them', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'User prefers dark mode',
      factType: 'preference',
      confidence: 'high',
    });

    const searchResult = await handler.callTool('memory_search', {
      query: 'dark mode',
    });
    const results = JSON.parse(searchResult.content[0].text);
    expect(results.knowledge.length).toBeGreaterThan(0);
    expect(results.knowledge[0].fact).toContain('dark mode');
  });

  it('tracks work items', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_track_work', {
      title: 'Implement search feature',
      kind: 'objective',
      status: 'open',
    });
    const tracked = JSON.parse(result.content[0].text);
    expect(tracked.tracked).toBe(true);
    expect(tracked.workItemId).toBeDefined();
  });

  it('runs maintenance without error', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_run_maintenance', {});
    expect(result.isError).toBeUndefined();
    const report = JSON.parse(result.content[0].text);
    expect(report.expiredWorkingMemory).toBe(0);
    expect(report.retiredKnowledge).toBe(0);
    expect(report.deletedWorkItems).toBe(0);
  });

  it('returns error for unknown tools', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('unknown_tool', {});
    expect(result.isError).toBe(true);
  });
});
