import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMcpServerHandler, startMcpServer } from '../server/mcp-server.js';
import { createSQLiteAdapter } from '../adapters/sqlite/index.js';

const mockedReadline = {
  lineHandler: null as ((line: string) => void | Promise<void>) | null,
};

vi.mock('readline', () => ({
  createInterface: () => ({
    on(event: string, handler: (line: string) => void | Promise<void>) {
      if (event === 'line') {
        mockedReadline.lineHandler = handler;
      }
      return this;
    },
    close() {},
  }),
}));

describe('MCP server handler', () => {
  let handler: ReturnType<typeof createMcpServerHandler>;
  let cleanupDbPath: string | null = null;

  afterEach(async () => {
    if (handler) await handler.close();
    if (cleanupDbPath) {
      rmSync(cleanupDbPath, { force: true });
      cleanupDbPath = null;
    }
  });

  it('lists all expected tools', () => {
    handler = createMcpServerHandler();
    expect(handler.tools.length).toBe(62);
    const names = handler.tools.map((t) => t.name);
    expect(names).toContain('memory_store_turn');
    expect(names).toContain('memory_store_exchange');
    expect(names).toContain('memory_get_context');
    expect(names).toContain('memory_request_context');
    expect(names).toContain('memory_get_context_config');
    expect(names).toContain('memory_set_default_context_contract');
    expect(names).toContain('memory_put_context_contract');
    expect(names).toContain('memory_delete_context_contract');
    expect(names).toContain('memory_put_context_invariant');
    expect(names).toContain('memory_delete_context_invariant');
    expect(names).toContain('memory_set_context_escalation_policy');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_search_cross_scope');
    expect(names).toContain('memory_learn_fact');
    expect(names).toContain('memory_track_work');
    expect(names).toContain('memory_update_work_item');
    expect(names).toContain('memory_claim_work_item');
    expect(names).toContain('memory_renew_work_claim');
    expect(names).toContain('memory_release_work_claim');
    expect(names).toContain('memory_list_work_claims');
    expect(names).toContain('memory_handoff_work_item');
    expect(names).toContain('memory_accept_handoff');
    expect(names).toContain('memory_reject_handoff');
    expect(names).toContain('memory_cancel_handoff');
    expect(names).toContain('memory_list_pending_handoffs');
    expect(names).toContain('memory_stream_changes');
    expect(names).toContain('memory_force_compact');
    expect(names).toContain('memory_get_health');
    expect(names).toContain('memory_run_maintenance');
    expect(names).toContain('memory_search_episodes');
    expect(names).toContain('memory_summarize_episode');
    expect(names).toContain('memory_reflect');
    expect(names).toContain('memory_search_cognitive');
    expect(names).toContain('memory_get_profile');
    expect(names).toContain('memory_create_playbook');
    expect(names).toContain('memory_search_playbooks');
    expect(names).toContain('memory_revise_playbook');
    expect(names).toContain('memory_create_playbook_from_task');
    expect(names).toContain('memory_use_playbook');
    expect(names).toContain('memory_get_associations');
    expect(names).toContain('memory_add_association');
    expect(names).toContain('memory_remove_association');
    expect(names).toContain('memory_snapshot');
    // Phase 5 tools
    expect(names).toContain('memory_discover');
    expect(names).toContain('memory_get_report');
    expect(names).toContain('memory_get_facts_at');
    expect(names).toContain('memory_reflect_knowledge');
    expect(names).toContain('memory_derive');
    expect(names).toContain('memory_get_curation');
    expect(names).toContain('memory_get_core_memory');
    expect(names).toContain('memory_set_aliases');
    expect(names).toContain('memory_get_aliases');
    expect(names).toContain('memory_get_alias_candidates');
    expect(names).toContain('memory_set_ontology');
    expect(names).toContain('memory_get_ontology');
    expect(names).toContain('memory_export_bundle');
    expect(names).toContain('memory_import_bundle');
    expect(names).toContain('memory_refresh_documents');
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
      includeDebug: true,
    });
    expect(contextResult.isError).toBeUndefined();
    const context = JSON.parse(contextResult.content[0].text);
    expect(context.activeTurnCount).toBeGreaterThan(0);
    expect(context.sessionState).toBeTruthy();
    expect(context.debugTrace).toBeTruthy();
  });

  it('returns context expansion resolutions via tool calls', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_request_context', {
      reason: 'missing_workspace_context',
      contract: {
        view: 'workspace_shared',
        crossScopeLevel: 'workspace',
      },
    });
    expect(result.isError).toBeUndefined();
    const resolution = JSON.parse(result.content[0].text);
    expect(resolution.requiresEscalation).toBe(false);
    expect(resolution.proposedContract.view).toBe('workspace_shared');
  });

  it('manages context governance via tool calls', async () => {
    handler = createMcpServerHandler();

    const configResult = await handler.callTool('memory_put_context_contract', {
      name: 'executor',
      contract: {
        tokenBudget: 2000,
        knowledgeClasses: ['constraint'],
      },
    });
    expect(configResult.isError).toBeUndefined();

    await handler.callTool('memory_put_context_invariant', {
      id: 'english-only',
      title: 'Language',
      instruction: 'All responses must be in English.',
      severity: 'important',
    });
    await handler.callTool('memory_set_context_escalation_policy', {
      policy: {
        defaultDecision: 'allow',
        byChange: {
          increase_token_budget: 'deny',
        },
      },
    });

    const governance = await handler.callTool('memory_get_context_config', {});
    const snapshot = JSON.parse(governance.content[0].text);
    expect(snapshot.contracts.executor.tokenBudget).toBe(2000);
    expect(snapshot.invariants[0].id).toBe('english-only');

    const resolutionResult = await handler.callTool('memory_request_context', {
      reason: 'need_higher_budget',
      currentContract: 'executor',
      contract: {
        tokenBudget: 4000,
      },
    });
    const resolution = JSON.parse(resolutionResult.content[0].text);
    expect(resolution.decision).toBe('denied');
  });

  it('deletes contracts and invariants via tool calls', async () => {
    handler = createMcpServerHandler();

    // Create a contract and invariant
    await handler.callTool('memory_put_context_contract', {
      name: 'test-contract',
      contract: { tokenBudget: 1000 },
    });
    await handler.callTool('memory_put_context_invariant', {
      id: 'test-inv',
      title: 'Test',
      instruction: 'Test instruction.',
      severity: 'advisory',
    });

    // Delete contract
    const deleteContract = await handler.callTool('memory_delete_context_contract', {
      name: 'test-contract',
    });
    expect(deleteContract.isError).toBeUndefined();
    const contractResult = JSON.parse(deleteContract.content[0].text);
    expect(contractResult.deleted).toBe(true);

    // Delete invariant
    const deleteInvariant = await handler.callTool('memory_delete_context_invariant', {
      id: 'test-inv',
    });
    expect(deleteInvariant.isError).toBeUndefined();
    const invariantResult = JSON.parse(deleteInvariant.content[0].text);
    expect(invariantResult.deleted).toBe(true);

    // Verify they are gone
    const config = await handler.callTool('memory_get_context_config', {});
    const snapshot = JSON.parse(config.content[0].text);
    expect(snapshot.contracts).toEqual({});
    expect(snapshot.invariants).toEqual([]);
  });

  it('returns deleted: false for nonexistent governance resources', async () => {
    handler = createMcpServerHandler();

    const deleteContract = await handler.callTool('memory_delete_context_contract', {
      name: 'nonexistent',
    });
    const contractResult = JSON.parse(deleteContract.content[0].text);
    expect(contractResult.deleted).toBe(false);

    const deleteInvariant = await handler.callTool('memory_delete_context_invariant', {
      id: 'nonexistent',
    });
    const invariantResult = JSON.parse(deleteInvariant.content[0].text);
    expect(invariantResult.deleted).toBe(false);
  });

  it('returns error for invalid governance input', async () => {
    handler = createMcpServerHandler();

    // Invalid contract view
    const badContract = await handler.callTool('memory_put_context_contract', {
      name: 'bad',
      contract: { view: 'not_a_view' },
    });
    expect(badContract.isError).toBe(true);

    // Missing required invariant fields
    const badInvariant = await handler.callTool('memory_put_context_invariant', {
      id: 'bad',
      title: 'Missing instruction',
    });
    expect(badInvariant.isError).toBe(true);
  });

  it('denies expansion when maxTokenBudget ceiling is exceeded', async () => {
    handler = createMcpServerHandler({
      escalationPolicy: {
        defaultDecision: 'allow',
        maxTokenBudget: 3000,
      },
    });

    const result = await handler.callTool('memory_request_context', {
      reason: 'need_higher_budget',
      contract: { tokenBudget: 5000 },
    });
    const resolution = JSON.parse(result.content[0].text);
    expect(resolution.decision).toBe('denied');
    expect(resolution.rationale).toBeTruthy();
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

  it('reports circuit breaker diagnostics in health output', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_get_health', {});
    expect(result.isError).toBeUndefined();
    const report = JSON.parse(result.content[0].text);
    expect(report.circuitBreakers.embeddings.state).toBeDefined();
  });

  it('supports scope overrides per tool call', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'Thread A fact',
      factType: 'reference',
      scope: { tenant_id: 'acme', system_id: 'assistant', scope_id: 'thread-a' },
    });
    await handler.callTool('memory_learn_fact', {
      fact: 'Thread B fact',
      factType: 'reference',
      scope: { tenant_id: 'acme', system_id: 'assistant', scope_id: 'thread-b' },
    });

    const resultA = await handler.callTool('memory_search', {
      query: 'fact',
      scope: { tenant_id: 'acme', system_id: 'assistant', scope_id: 'thread-a' },
    });
    const resultB = await handler.callTool('memory_search', {
      query: 'fact',
      scope: { tenant_id: 'acme', system_id: 'assistant', scope_id: 'thread-b' },
    });

    expect(JSON.parse(resultA.content[0].text).knowledge[0].fact).toContain('Thread A');
    expect(JSON.parse(resultB.content[0].text).knowledge[0].fact).toContain('Thread B');
  });

  it('supports cross-scope search tools', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'Shared workspace memory',
      factType: 'reference',
      scope: {
        tenant_id: 'acme',
        system_id: 'assistant',
        workspace_id: 'shared',
        scope_id: 'thread-a',
      },
    });

    const result = await handler.callTool('memory_search_cross_scope', {
      query: 'shared workspace',
      scopeLevel: 'workspace',
      scope: {
        tenant_id: 'acme',
        system_id: 'assistant',
        workspace_id: 'shared',
        scope_id: 'thread-b',
      },
    });

    expect(JSON.parse(result.content[0].text).knowledge[0].fact).toContain('Shared workspace memory');
  });

  it('waits for initialize before emitting stdio lifecycle messages', async () => {
    mockedReadline.lineHandler = null;
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      await startMcpServer();
      expect(writes).toEqual([]);
      expect(mockedReadline.lineHandler).toBeTypeOf('function');

      await mockedReadline.lineHandler?.(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        }),
      );

      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
        },
      });
    } finally {
      stdoutSpy.mockRestore();
      mockedReadline.lineHandler = null;
    }
  });

  it('shares collaboration memory across systems through MCP tools', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'Rollback playbook lives with the release captain',
      factType: 'reference',
      scope: {
        tenant_id: 'acme',
        system_id: 'planner',
        workspace_id: 'factory',
        collaboration_id: 'release-42',
        scope_id: 'run-a',
      },
    });

    const result = await handler.callTool('memory_search_cross_scope', {
      query: 'release captain',
      scopeLevel: 'workspace',
      scope: {
        tenant_id: 'acme',
        system_id: 'executor',
        workspace_id: 'factory',
        collaboration_id: 'release-42',
        scope_id: 'run-b',
      },
    });

    expect(JSON.parse(result.content[0].text).knowledge[0].fact).toContain('release captain');
  });

  it('memory_search_cognitive returns grouped results', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'User prefers vim keybindings',
      factType: 'preference',
      confidence: 'high',
    });

    const result = await handler.callTool('memory_search_cognitive', {
      query: 'vim',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.byType).toBeDefined();
    expect(parsed.all).toBeDefined();
    expect(parsed.all.length).toBeGreaterThan(0);
    expect(parsed.all[0].item.type).toBe('semantic');
    expect(parsed.all[0].item.fact).toContain('vim');
  });

  it('memory_search_cognitive filters by types', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'Deploy with Docker',
      factType: 'constraint',
      confidence: 'high',
    });

    // Only search procedural — constraint maps to semantic, so no results
    const result = await handler.callTool('memory_search_cognitive', {
      query: 'Docker',
      types: ['procedural'],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.byType.procedural.length).toBe(0);
  });

  it('memory_search_episodes returns error without structuredClient', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_store_exchange', {
      userContent: 'Deploy the API',
      assistantContent: 'Done.',
    });

    const result = await handler.callTool('memory_search_episodes', {
      query: 'deploy',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('structuredClient');
  });

  it('memory_summarize_episode returns error without structuredClient', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_summarize_episode', {
      sessionId: 'sess-1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('structuredClient');
  });

  it('memory_reflect returns error without structuredClient', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_reflect', {
      query: 'test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('structuredClient');
  });

  it('memory_get_profile returns a profile', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_learn_fact', {
      fact: 'User prefers dark mode',
      factType: 'preference',
      confidence: 'high',
    });

    const result = await handler.callTool('memory_get_profile', {});
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.profile.view).toBe('user');
    expect(body.profile.sections).toBeDefined();
    expect(body.profile.generatedAt).toBeDefined();
  });

  it('memory_get_profile accepts view and sections params', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_get_profile', {
      view: 'workspace',
      sections: ['constraints', 'workflows'],
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.profile.view).toBe('workspace');
  });

  it('memory_search_episodes validates required fields', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_search_episodes', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('memory_reflect validates required fields', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_reflect', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('memory_summarize_episode validates required fields', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_summarize_episode', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sessionId');
  });

  it('memory_create_playbook creates and returns a playbook', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_create_playbook', {
      title: 'Deploy procedure',
      description: 'How to deploy',
      instructions: '1. Build\n2. Push',
      tags: ['deploy', 'ci'],
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.playbook).toBeDefined();
    expect(parsed.playbook.id).toBeGreaterThan(0);
    expect(parsed.playbook.title).toBe('Deploy procedure');
    expect(parsed.playbook.tags).toEqual(['deploy', 'ci']);
  });

  it('memory_search_playbooks finds matching playbooks', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_create_playbook', {
      title: 'Deploy to staging',
      description: 'Staging deployment',
      instructions: 'Run deploy.sh',
    });

    const result = await handler.callTool('memory_search_playbooks', {
      query: 'deploy',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.playbooks.length).toBeGreaterThan(0);
    expect(parsed.playbooks[0].title).toContain('Deploy');
  });

  it('memory_revise_playbook revises and returns playbook + revision', async () => {
    handler = createMcpServerHandler();

    const createResult = await handler.callTool('memory_create_playbook', {
      title: 'Revisable',
      description: 'Will be revised',
      instructions: 'Original',
    });
    const createParsed = JSON.parse(createResult.content[0].text);
    const playbookId = createParsed.playbook.id;

    const reviseResult = await handler.callTool('memory_revise_playbook', {
      playbookId,
      newInstructions: 'Updated instructions',
      revisionReason: 'Improved clarity',
    });
    expect(reviseResult.isError).toBeUndefined();
    const parsed = JSON.parse(reviseResult.content[0].text);
    expect(parsed.playbook.id).toBe(playbookId);
    expect(parsed.playbook.instructions).toBe('Updated instructions');
    expect(parsed.revision.id).toBeGreaterThan(0);
    expect(parsed.revision.instructions).toBe('Original');
    expect(parsed.revision.revision_reason).toBe('Improved clarity');
  });

  it('memory_create_playbook validates required fields', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_create_playbook', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('title');
  });

  it('memory_revise_playbook validates required fields', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_revise_playbook', {});
    expect(result.isError).toBe(true);
  });

  it('memory_snapshot capture returns a snapshot id', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_store_exchange', {
      userContent: 'Always use TypeScript',
      assistantContent: 'Understood.',
    });

    const result = await handler.callTool('memory_snapshot', {
      action: 'capture',
      sessionId: 'session-capture',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.snapshot).toBeTruthy();
    expect(typeof parsed.snapshot.snapshotId).toBe('string');
    expect(typeof parsed.snapshot.frozenAt).toBe('number');
    expect(parsed.snapshot.sessionId).toBe('session-capture');
    expect(parsed.snapshot.bootstrap).toBeDefined();
    expect(parsed.snapshot.context).toBeDefined();
  });

  it('memory_snapshot get returns null before capture', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_snapshot', {
      action: 'get',
      sessionId: 'session-get-empty',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.snapshot).toBeNull();
  });

  it('memory_snapshot get returns snapshot after capture', async () => {
    handler = createMcpServerHandler();

    await handler.callTool('memory_snapshot', {
      action: 'capture',
      sessionId: 'session-get-present',
    });
    const result = await handler.callTool('memory_snapshot', {
      action: 'get',
      sessionId: 'session-get-present',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.snapshot).toBeTruthy();
    expect(typeof parsed.snapshot.snapshotId).toBe('string');
  });

  it('memory_snapshot refresh produces a new snapshot id', async () => {
    handler = createMcpServerHandler();

    const first = await handler.callTool('memory_snapshot', {
      action: 'capture',
      sessionId: 'session-refresh',
    });
    const firstId = JSON.parse(first.content[0].text).snapshot.snapshotId;

    // Small delay to ensure different snapshot ID (uses Date.now() + random)
    await new Promise((r) => setTimeout(r, 2));

    const refreshed = await handler.callTool('memory_snapshot', {
      action: 'refresh',
      sessionId: 'session-refresh',
    });
    const parsed = JSON.parse(refreshed.content[0].text);
    expect(parsed.snapshot).toBeTruthy();
    expect(parsed.snapshot.snapshotId).not.toBe(firstId);
  });

  it('memory_snapshot isolates snapshots across sessions', async () => {
    handler = createMcpServerHandler();

    const a = await handler.callTool('memory_snapshot', {
      action: 'capture',
      sessionId: 'session-a',
    });
    const b = await handler.callTool('memory_snapshot', {
      action: 'capture',
      sessionId: 'session-b',
    });
    const aId = JSON.parse(a.content[0].text).snapshot.snapshotId;
    const bId = JSON.parse(b.content[0].text).snapshot.snapshotId;
    expect(aId).not.toBe(bId);

    // Each get should only see its own snapshot
    const getA = await handler.callTool('memory_snapshot', {
      action: 'get',
      sessionId: 'session-a',
    });
    expect(JSON.parse(getA.content[0].text).snapshot.snapshotId).toBe(aId);
  });

  it('memory_snapshot rejects invalid action', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_snapshot', {
      action: 'invalid',
      sessionId: 'test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('action');
  });

  it('memory_snapshot requires sessionId', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('memory_snapshot', { action: 'capture' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sessionId');
  });

  it('memory_snapshot captures the latest event watermark', async () => {
    cleanupDbPath = `/tmp/memory-layer-mcp-watermark-${Date.now()}-${Math.random()}.sqlite`;
    handler = createMcpServerHandler({ dbPath: cleanupDbPath });
    const adapter = createSQLiteAdapter(cleanupDbPath);

    await handler.callTool('memory_store_exchange', {
      userContent: 'First event',
      assistantContent: 'Second event',
    });

    const latestCursor = adapter.getTemporalWatermark('temporal')?.last_event_id ?? null;
    const snapshot = await handler.callTool('memory_snapshot', {
      action: 'capture',
      sessionId: 'session-watermark',
    });
    adapter.close();

    expect(JSON.parse(snapshot.content[0].text).snapshot.watermarkEventId).toBe(latestCursor);
  });

  it('rejects oversized MCP diff ranges at the default transport cap', async () => {
    cleanupDbPath = `/tmp/memory-layer-mcp-diff-${Date.now()}-${Math.random()}.sqlite`;
    handler = createMcpServerHandler({ dbPath: cleanupDbPath });
    const adapter = createSQLiteAdapter(cleanupDbPath);

    for (let index = 0; index < 5001; index += 1) {
      adapter.insertTurn({
        tenant_id: 'default',
        system_id: 'default',
        workspace_id: '',
        collaboration_id: '',
        scope_id: 'default',
        session_id: 'session-1',
        actor: 'user',
        role: 'user',
        content: `turn-${index}`,
      });
    }
    adapter.close();

    const result = await handler.callTool('memory_diff_state', {
      from: 0,
      to: Math.floor(Date.now() / 1000) + 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('maximum of 5000');
  });

  it('returns error for unknown tools', async () => {
    handler = createMcpServerHandler();

    const result = await handler.callTool('unknown_tool', {});
    expect(result.isError).toBe(true);
  });

  it('rejects malformed MCP tool inputs', async () => {
    handler = createMcpServerHandler();

    const badLimit = await handler.callTool('memory_search', {
      query: 'test',
      limit: 'abc',
    } as never);
    expect(badLimit.isError).toBe(true);

    const badScope = await handler.callTool('memory_search', {
      query: 'test',
      scope: [],
    } as never);
    expect(badScope.isError).toBe(true);

    const badScopeLevel = await handler.callTool('memory_search_cross_scope', {
      query: 'test',
      scopeLevel: 'planet',
    } as never);
    expect(badScopeLevel.isError).toBe(true);

    const badStateAt = await handler.callTool('memory_get_state_at', {
      asOf: 'NaN',
    } as never);
    expect(badStateAt.isError).toBe(true);

    const badTimelineCursor = await handler.callTool('memory_get_timeline', {
      cursor: 'abc',
    } as never);
    expect(badTimelineCursor.isError).toBe(true);

    const badDiff = await handler.callTool('memory_diff_state', {
      from: 'Infinity',
      to: 1,
    } as never);
    expect(badDiff.isError).toBe(true);

    const badExpectedVersion = await handler.callTool('memory_update_work_item', {
      id: 1,
      expectedVersion: 'NaN',
    } as never);
    expect(badExpectedVersion.isError).toBe(true);

    const badWorkItemId = await handler.callTool('memory_update_work_item', {
      id: 'bad',
    } as never);
    expect(badWorkItemId.isError).toBe(true);

    const badLease = await handler.callTool('memory_claim_work_item', {
      workItemId: 1,
      actor: { actor_kind: 'agent', actor_id: 'planner' },
      leaseSeconds: 'Infinity',
    } as never);
    expect(badLease.isError).toBe(true);

    const badExpiresAt = await handler.callTool('memory_handoff_work_item', {
      workItemId: 1,
      fromActor: { actor_kind: 'agent', actor_id: 'planner' },
      toActor: { actor_kind: 'human', actor_id: 'operator' },
      summary: 'Take over',
      expiresAt: 'Infinity',
    } as never);
    expect(badExpiresAt.isError).toBe(true);

    const badCognitiveTrust = await handler.callTool('memory_search_cognitive', {
      query: 'test',
      minimumTrustScore: 'Infinity',
    } as never);
    expect(badCognitiveTrust.isError).toBe(true);

    const badProfileTrust = await handler.callTool('memory_get_profile', {
      minimumTrustScore: 'NaN',
    } as never);
    expect(badProfileTrust.isError).toBe(true);

    const badEpisodeTimeRange = await handler.callTool('memory_search_episodes', {
      query: 'deploy',
      timeRange: { start_at: 'bad' },
    } as never);
    expect(badEpisodeTimeRange.isError).toBe(true);

    const badReflectTimeRange = await handler.callTool('memory_reflect', {
      query: 'deploy',
      timeRange: { end_at: 'bad' },
    } as never);
    expect(badReflectTimeRange.isError).toBe(true);

    const badSourceWorkingMemoryId = await handler.callTool('memory_create_playbook_from_task', {
      title: 'Deploy',
      description: 'Ship it',
      sessionId: 'session-1',
      sourceWorkingMemoryId: 'bad',
    } as never);
    expect(badSourceWorkingMemoryId.isError).toBe(true);
  });
});
