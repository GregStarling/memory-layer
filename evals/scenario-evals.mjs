import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createClaudeMemoryManager,
  createMemory,
  createMemoryMcpAdapter,
  createMemoryRuntime,
} from '../dist/index.js';
import { detectWorkspace, workspaceIdFromPath } from '../dist/core/workspace-detect.js';

const enforce = process.argv.includes('--enforce');
const evalsDir = path.dirname(fileURLToPath(import.meta.url));

function assertResult(name, passed, detail) {
  return { name, passed, detail };
}

async function runHundredTurnSession({
  preset,
  scope,
  summary,
  facts,
  query,
  unresolvedWorkTitle,
  userTurn,
  assistantTurn,
}) {
  const manager = createClaudeMemoryManager({
    dbPath: ':memory:',
    scope,
    preset,
    summarizer: {
      client: {
        async generate(request) {
          if (request.expectedFormat === 'object') {
            return JSON.stringify({
              summary,
              key_entities: ['memory-layer'],
              topic_tags: ['long-horizon'],
            });
          }
          return JSON.stringify(facts);
        },
      },
    },
    extractor: {
      client: {
        async generate() {
          return JSON.stringify(facts);
        },
      },
    },
    monitorPolicy: {
      floorTurns: 2,
      floorTokens: 1,
      softTurnThreshold: 6,
      hardTurnThreshold: 8,
      softTokenThreshold: 200,
      hardTokenThreshold: 300,
      softRetainTurns: 4,
      hardRetainTurns: 3,
    },
  });
  const runtime = createMemoryRuntime(manager);
  try {
    if (unresolvedWorkTitle) {
      await manager.trackWorkItem(unresolvedWorkTitle, 'unresolved_work', 'blocked');
    }
    for (let index = 0; index < 50; index += 1) {
      await runtime.afterModelCall({
        userInput: userTurn(index),
        assistantOutput: assistantTurn(index),
      });
    }
    const prepared = await runtime.beforeModelCall(query);
    const recall = await manager.recall({
      start_at: 0,
      end_at: Math.floor(Date.now() / 1000) + 10,
    });
    return {
      prepared,
      recall,
    };
  } finally {
    await manager.close();
  }
}

async function loadReplayTrace(name) {
  const raw = await readFile(path.join(evalsDir, 'traces', name), 'utf8');
  return JSON.parse(raw);
}

async function runLocalReplayTrace() {
  const trace = await loadReplayTrace('local-no-provider.json');
  const events = [];
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const voyageApiKey = process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;

  const memory = createMemory({
    preset: 'autonomous_agent',
    policies: {
      monitor: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 2,
        hardTurnThreshold: 4,
        softTokenThreshold: 10,
        hardTokenThreshold: 20,
      },
    },
    onEvent: (event) => events.push(event),
  });

  try {
    for (const turn of trace.turns) {
      await memory.processExchange(turn.user, turn.assistant);
    }
    await memory.forceCompact();
    const context = await memory.getContext(trace.query);
    const facts = [
      ...context.trustedCoreMemory.map((item) => item.fact),
      ...context.taskRelevantKnowledge.map((item) => item.fact),
      ...context.provisionalKnowledge.map((item) => item.fact),
    ];
    const normalizedFacts = facts.map((fact) => fact.toLowerCase());
    const capability = events.find((event) => event.type === 'capability');
    return assertResult(
      trace.name,
      trace.expectedFacts.every((fact) =>
        normalizedFacts.some((item) => item.includes(String(fact).toLowerCase())),
      ) &&
        trace.disallowedFacts.every(
          (fact) => !normalizedFacts.some((item) => item.includes(String(fact).toLowerCase())),
        ) &&
        capability?.meta?.providerBacked === false,
      {
        facts,
        capability: capability?.meta ?? null,
      },
    );
  } finally {
    await memory.close();
    if (openAiApiKey) process.env.OPENAI_API_KEY = openAiApiKey;
    if (voyageApiKey) process.env.VOYAGE_API_KEY = voyageApiKey;
  }
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
  const safeRetrievalAvailable =
    prepared.context.relevantKnowledge.length > 0 ||
    prepared.context.provisionalKnowledge.length > 0 ||
    prepared.context.workingMemory?.summary?.toLowerCase().includes('typescript') ||
    prepared.context.workingMemory?.summary?.toLowerCase().includes('local-first');

  const aiIdeLongRun = await runHundredTurnSession({
    preset: 'ai_ide',
    scope: {
      tenant_id: 'eval',
      system_id: 'quality',
      workspace_id: 'long-run',
      scope_id: 'ai-ide-100',
    },
    summary: 'AI IDE session: preserve local-first TypeScript constraints while refactoring over many turns.',
    facts: [
      { fact: 'The system must remain local-first.', factType: 'constraint', confidence: 'high' },
      { fact: 'The user prefers TypeScript for implementation work.', factType: 'preference', confidence: 'high' },
    ],
    query: 'local-first TypeScript refactor guidance',
    userTurn: (index) =>
      `Turn ${index}: continue the refactor, keep the project local-first, and prefer TypeScript over ad-hoc rewrites.`,
    assistantTurn: (index) =>
      `Response ${index}: I will preserve the local-first constraint and keep the implementation in TypeScript.`,
  });
  const autonomousLongRun = await runHundredTurnSession({
    preset: 'autonomous_agent',
    scope: {
      tenant_id: 'eval',
      system_id: 'quality',
      workspace_id: 'long-run',
      scope_id: 'autonomous-100',
    },
    summary: 'Autonomous runtime: keep rollout work coordinated, local-first, and grounded in the shared checklist.',
    facts: [
      { fact: 'The system must remain local-first.', factType: 'constraint', confidence: 'high' },
      { fact: 'Use the shared rollout checklist before deploys.', factType: 'decision', confidence: 'high' },
    ],
    query: 'rollout checklist local-first deployment',
    unresolvedWorkTitle: 'Resolve rollout checklist blockers',
    userTurn: (index) =>
      `Turn ${index}: continue the rollout task, stay local-first, and use the shared rollout checklist before deploys.`,
    assistantTurn: (index) =>
      `Response ${index}: I will continue the rollout, preserve local-first behavior, and follow the shared checklist.`,
  });
  const aiIdeFacts = [
    ...aiIdeLongRun.prepared.context.trustedCoreMemory.map((item) => item.fact),
    ...aiIdeLongRun.prepared.context.taskRelevantKnowledge.map((item) => item.fact),
    ...aiIdeLongRun.prepared.context.provisionalKnowledge.map((item) => item.fact),
  ];
  const autonomousFacts = [
    ...autonomousLongRun.prepared.context.trustedCoreMemory.map((item) => item.fact),
    ...autonomousLongRun.prepared.context.taskRelevantKnowledge.map((item) => item.fact),
    ...autonomousLongRun.prepared.context.provisionalKnowledge.map((item) => item.fact),
  ];
  const localReplay = await runLocalReplayTrace();

  const results = [
    assertResult('zero_config_retrieval', safeRetrievalAvailable, {
      knowledgeCount: prepared.context.relevantKnowledge.length,
      provisionalCount: prepared.context.provisionalKnowledge.length,
      workingSummary: prepared.context.workingMemory?.summary ?? null,
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
    assertResult(
      'ai_ide_100_turn_session',
      aiIdeLongRun.recall.turns.length === 100 &&
        aiIdeLongRun.recall.workingMemory.length > 0 &&
        aiIdeFacts.some((fact) => fact.toLowerCase().includes('local-first')) &&
        aiIdeFacts.some((fact) => fact.toLowerCase().includes('typescript')),
      {
        turnCount: aiIdeLongRun.recall.turns.length,
        workingMemoryCount: aiIdeLongRun.recall.workingMemory.length,
        facts: aiIdeFacts,
      },
    ),
    assertResult(
      'autonomous_runner_100_turn_session',
      autonomousLongRun.recall.turns.length === 100 &&
        autonomousLongRun.recall.workingMemory.length > 0 &&
        autonomousLongRun.prepared.context.unresolvedWork.includes('Resolve rollout checklist blockers') &&
        autonomousFacts.some((fact) => fact.toLowerCase().includes('checklist')),
      {
        turnCount: autonomousLongRun.recall.turns.length,
        workingMemoryCount: autonomousLongRun.recall.workingMemory.length,
        unresolvedWork: autonomousLongRun.prepared.context.unresolvedWork,
        facts: autonomousFacts,
      },
    ),
    localReplay,
  ];

  // workspace_auto_detect scenario
  const detectedId = detectWorkspace();
  const pathId = workspaceIdFromPath(process.cwd());
  const workspaceAutoDetect = assertResult(
    'workspace_auto_detect',
    typeof detectedId === 'string' &&
      detectedId.length === 16 &&
      /^[0-9a-f]{16}$/.test(detectedId) &&
      typeof pathId === 'string' &&
      pathId.length === 16,
    {
      detectedId,
      pathId,
      isGitRepo: detectedId !== pathId,
    },
  );
  results.push(workspaceAutoDetect);

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
