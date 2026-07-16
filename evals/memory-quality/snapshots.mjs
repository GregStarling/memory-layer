import { createMemory } from '../../dist/composition/quick.js';
import { createMemoryRuntime } from '../../dist/core/runtime.js';
import { assertScenario, ratio, tagEvalOutput } from './shared.mjs';

function makeScope(overrides = {}) {
  return {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'snapshots',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function buildSnapshotFingerprint(result) {
  // Build a stable fingerprint of the prompt-injected state. The snapshot
  // contract says the prompt and context (and derived messages) must not
  // change between beforeModelCall invocations until refreshSnapshot runs.
  return JSON.stringify({
    prompt: result.prompt,
    bootstrapPrompt: result.bootstrapPrompt,
    activeTurnCount: result.context.activeTurns.length,
    relevantKnowledgeCount: result.context.relevantKnowledge.length,
    trustedCoreCount: result.context.trustedCoreMemory.length,
    tokenEstimate: result.context.tokenEstimate,
    messageCount: result.messages.length,
  });
}

// ---------- Metric 1: snapshot_stability ----------
// 10 consecutive beforeModelCall invocations must return byte-identical
// context fingerprints while live writes happen in between.
async function evalSnapshotStability() {
  const memory = createMemory({
    adapter: 'memory',
    scope: makeScope({ scope_id: 'stability' }),
    autoCompact: false,
    autoExtract: false,
  });
  try {
    await memory.learnFact('The project uses TypeScript strict mode.', 'constraint', 'high');
    await memory.learnFact('Deploy target is us-east-1.', 'decision', 'high');

    const runtime = createMemoryRuntime(memory, { snapshotMode: true });
    await runtime.startSession('project setup');

    const baseline = await runtime.beforeModelCall('first call');
    const baselineFp = buildSnapshotFingerprint(baseline);

    let stableCount = 0;
    const fingerprints = [baselineFp];
    for (let i = 0; i < 10; i++) {
      // Mutate durable state between calls to prove the cache is frozen.
      await memory.processExchange(`user turn ${i}`, `assistant reply ${i}`);
      const next = await runtime.beforeModelCall(`call ${i}`);
      const fp = buildSnapshotFingerprint(next);
      fingerprints.push(fp);
      if (fp === baselineFp) stableCount++;
    }

    const score = ratio(stableCount, 10);
    const scenarios = [
      assertScenario('snapshot_is_byte_stable_across_10_calls', stableCount === 10, {
        stableCount,
        uniqueFingerprints: new Set(fingerprints).size,
      }),
    ];
    return { score, scenarios };
  } finally {
    await memory.close();
  }
}

// ---------- Metric 2: snapshot_live_writes ----------
// Turns committed during snapshot mode must still be written durably.
// Snapshots freeze the prompt-injected context, not the underlying store.
async function evalSnapshotLiveWrites() {
  const memory = createMemory({
    adapter: 'memory',
    scope: makeScope({ scope_id: 'live-writes' }),
    autoCompact: false,
    autoExtract: false,
  });
  try {
    const runtime = createMemoryRuntime(memory, { snapshotMode: true });
    await runtime.startSession('durable writes test');

    const beforeTurns = (await memory.getContext('durable')).activeTurns.length;

    // 5 exchanges committed under snapshot mode. Each call goes through
    // beforeModelCall (cached) + afterModelCall (durable write).
    for (let i = 0; i < 5; i++) {
      await runtime.wrapModelCall(
        async () => `assistant reply ${i}`,
        `user turn ${i}`,
      );
    }

    // Pull context from the manager directly (bypassing the snapshot) to
    // verify the turns actually landed in durable storage.
    const liveContext = await memory.getContext('durable');
    const afterTurns = liveContext.activeTurns.length;
    const writesLanded = afterTurns - beforeTurns;

    // Each wrapModelCall writes both a user and an assistant turn = 10 total.
    const expectedWrites = 10;
    const score = ratio(Math.min(writesLanded, expectedWrites), expectedWrites);
    const scenarios = [
      assertScenario('turns_persist_during_snapshot_mode', writesLanded >= expectedWrites, {
        beforeTurns,
        afterTurns,
        writesLanded,
        expectedWrites,
      }),
    ];
    return { score, scenarios };
  } finally {
    await memory.close();
  }
}

// ---------- Metric 3: snapshot_refresh ----------
// refreshSnapshot must pick up knowledge added after the snapshot was taken.
async function evalSnapshotRefresh() {
  const memory = createMemory({
    adapter: 'memory',
    scope: makeScope({ scope_id: 'refresh' }),
    autoCompact: false,
    autoExtract: false,
  });
  try {
    await memory.learnFact('Initial fact: staging uses port 8080.', 'reference', 'high');

    const runtime = createMemoryRuntime(memory, { snapshotMode: true });
    await runtime.startSession('staging');

    const before = await runtime.beforeModelCall('staging details');
    const beforeFacts = before.context.relevantKnowledge.map((k) => k.fact);
    const hasInitial = beforeFacts.some((f) => f.includes('port 8080'));

    // Add knowledge while the snapshot is still frozen — the cached call
    // must NOT see this yet.
    await memory.learnFact(
      'New fact: production uses port 443.',
      'reference',
      'high',
    );
    const stillCached = await runtime.beforeModelCall('staging details');
    const cachedFacts = stillCached.context.relevantKnowledge.map((k) => k.fact);
    const newFactHiddenBeforeRefresh = !cachedFacts.some((f) => f.includes('port 443'));

    // Now explicitly refresh — the new knowledge should appear.
    const refreshed = await runtime.refreshSnapshot('staging details');
    const refreshedFacts = refreshed?.context.relevantKnowledge.map((k) => k.fact) ?? [];
    const newFactVisibleAfterRefresh = refreshedFacts.some((f) => f.includes('port 443'));
    // And a subsequent beforeModelCall should reflect the refreshed snapshot.
    const afterCall = await runtime.beforeModelCall('staging details');
    const afterFacts = afterCall.context.relevantKnowledge.map((k) => k.fact);
    const beforeModelCallShowsRefresh = afterFacts.some((f) => f.includes('port 443'));

    const checks = [
      hasInitial,
      newFactHiddenBeforeRefresh,
      newFactVisibleAfterRefresh,
      beforeModelCallShowsRefresh,
    ];
    const passedCount = checks.filter(Boolean).length;
    const score = ratio(passedCount, checks.length);

    const scenarios = [
      assertScenario('initial_snapshot_contains_seeded_knowledge', hasInitial, {
        beforeFacts,
      }),
      assertScenario('snapshot_hides_new_knowledge_until_refresh', newFactHiddenBeforeRefresh, {
        cachedFacts,
      }),
      assertScenario('refresh_snapshot_picks_up_new_knowledge', newFactVisibleAfterRefresh, {
        refreshedFacts,
      }),
      assertScenario('before_model_call_reflects_refreshed_snapshot', beforeModelCallShowsRefresh, {
        afterFacts,
      }),
    ];
    return { score, scenarios };
  } finally {
    await memory.close();
  }
}

// ---------- Run all ----------
export async function runSnapshotEvals(_options = {}) {
  const [stability, liveWrites, refresh] = await Promise.all([
    evalSnapshotStability(),
    evalSnapshotLiveWrites(),
    evalSnapshotRefresh(),
  ]);

  const metrics = {
    snapshotStability: stability.score,
    snapshotLiveWrites: liveWrites.score,
    snapshotRefresh: refresh.score,
  };

  const scenarios = [
    ...stability.scenarios,
    ...liveWrites.scenarios,
    ...refresh.scenarios,
  ];

  return tagEvalOutput('snapshots', { metrics, scenarios });
}
