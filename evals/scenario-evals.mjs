import {
  createClaudeMemoryManager,
  createMemoryMcpAdapter,
  createMemoryRuntime,
} from '../dist/index.js';

const enforce = process.argv.includes('--enforce');

function assertResult(name, passed, detail) {
  return { name, passed, detail };
}

async function runScenarios() {
  const scope = {
    tenant_id: 'eval',
    system_id: 'quality',
    workspace_id: 'default',
    scope_id: 'thread-1',
  };
  const realNow = Date.now;
  Date.now = () => new Date('2024-01-01T00:00:00Z').valueOf();
  const manager = createClaudeMemoryManager({
    dbPath: ':memory:',
    scope,
    preset: 'autonomous_agent',
    summarizer: {
      client: {
        async generate(request) {
          if (request.expectedFormat === 'object') {
            return '{"summary":"The user wants local-first TypeScript workflows.","key_entities":["TypeScript"],"topic_tags":["memory"]}';
          }
          return '[{"fact":"The user prefers TypeScript","factType":"preference","confidence":"high"}]';
        },
      },
    },
    extractor: {
      client: {
        async generate() {
          return '[{"fact":"The user prefers TypeScript","factType":"preference","confidence":"high"}]';
        },
      },
    },
    monitorPolicy: {
      floorTurns: 1,
      floorTokens: 1,
      softTurnThreshold: 50,
      hardTurnThreshold: 2,
      softTokenThreshold: 50_000,
      hardTokenThreshold: 5,
      intraSessionGapSeconds: 10,
    },
  });
  const runtime = createMemoryRuntime(manager);
  const mcp = createMemoryMcpAdapter(runtime);

  await manager.trackWorkItem('Ship the memory layer', 'objective', 'in_progress');
  await manager.trackWorkItem('Fix retrieval regressions', 'unresolved_work', 'blocked');
  await manager.trackWorkItem('Old completed task', 'objective', 'done');
  await runtime.afterModelCall({
    userInput: 'Please remember that we are building a local-first AI memory layer.',
    assistantOutput: 'Understood. I will keep local-first requirements in mind.',
  });
  await manager.forceCompact();

  const prepared = await runtime.beforeModelCall('TypeScript local-first');
  const bootstrap = await runtime.startSession('TypeScript');
  const recall = await manager.recall({ start_at: 0, end_at: Math.floor(Date.now() / 1000) + 10 });
  const mcpPrepared = await mcp.callTool('memory_prepare_call', {
    input: 'TypeScript local-first',
  });

  Date.now = () => new Date('2024-01-10T00:00:00Z').valueOf();
  const maintenance = await manager.runMaintenance({
    workingMemoryTtlSeconds: 1,
    completedWorkItemTtlSeconds: 1,
    knowledgeStaleAfterSeconds: 1,
    minKnowledgeAccessCount: 0,
    maxActiveKnowledgeItems: 50,
  });
  Date.now = realNow;

  const results = [
    assertResult('zero_config_retrieval', prepared.context.relevantKnowledge.length > 0, {
      knowledgeCount: prepared.context.relevantKnowledge.length,
    }),
    assertResult('bootstrap_objective', bootstrap.bootstrap.activeObjectives.length > 0, {
      objectives: bootstrap.bootstrap.activeObjectives.length,
    }),
    assertResult('runtime_unresolved_work', prepared.context.unresolvedWork.includes('Fix retrieval regressions'), {
      unresolvedWork: prepared.context.unresolvedWork,
    }),
    assertResult('temporal_recall', recall.turns.length >= 2 && recall.workItems.length >= 2, {
      turnCount: recall.turns.length,
      workItemCount: recall.workItems.length,
    }),
    assertResult('protocol_adapter_path', Boolean(mcpPrepared.prompt), {
      prompt: mcpPrepared.prompt?.slice(0, 40) ?? null,
    }),
    assertResult(
      'lifecycle_maintenance',
      maintenance.expiredWorkingMemoryIds.length > 0 ||
        maintenance.retiredKnowledgeIds.length > 0 ||
        maintenance.deletedWorkItemIds.length > 0,
      {
      expiredWorkingMemoryIds: maintenance.expiredWorkingMemoryIds,
      retiredKnowledgeIds: maintenance.retiredKnowledgeIds,
      deletedWorkItemIds: maintenance.deletedWorkItemIds,
      },
    ),
  ];

  const passed = results.every((result) => result.passed);
  console.log(
    JSON.stringify(
      {
        eval: 'scenario-evals',
        passed,
        passRate: results.filter((result) => result.passed).length / results.length,
        results,
      },
      null,
      2,
    ),
  );

  await manager.close();

  if (enforce && !passed) {
    process.exit(1);
  }
}

void runScenarios();
