import {
  buildMemoryContext,
  compactTurns,
  createInMemoryAdapter,
  extractKnowledge,
  wrapSyncAdapter,
} from '../../dist/index.js';
import { assertScenario, ratio } from './shared.mjs';

export async function runFalseMemoryEvals() {
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'false-memory',
    scope_id: 'thread-1',
  };
  const sessionId = 'session-1';
  const adapter = createInMemoryAdapter();
  const asyncAdapter = wrapSyncAdapter(adapter);

  try {
    const turns = adapter.insertTurns([
      {
        ...scope,
        session_id: sessionId,
        actor: 'user',
        role: 'user',
        content: 'Please avoid Docker-first deployment paths unless absolutely necessary.',
      },
      {
        ...scope,
        session_id: sessionId,
        actor: 'assistant',
        role: 'assistant',
        content: 'Understood. I will avoid defaulting to Docker-first deployment paths.',
      },
      {
        ...scope,
        session_id: sessionId,
        actor: 'user',
        role: 'user',
        content: 'The safest default is local-first persistence.',
      },
      {
        ...scope,
        session_id: sessionId,
        actor: 'assistant',
        role: 'assistant',
        content: 'Acknowledged. I will preserve the local-first default.',
      },
    ]);

    const compaction = await compactTurns(
      asyncAdapter,
      scope,
      sessionId,
      turns,
      async () => ({
        summary: 'The user wants a Docker-first deployment strategy.',
        key_entities: ['Docker'],
        topic_tags: ['deployment'],
      }),
      'manual',
      0,
    );

    await extractKnowledge(
      asyncAdapter,
      compaction.workingMemory.id,
      scope,
      async () => [
        {
          fact: 'The user wants a Docker-first deployment strategy.',
          factType: 'constraint',
          confidence: 'high',
        },
      ],
    );

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'deployment strategy docker local-first',
    });
    const falseFactSurfaced = context.relevantKnowledge.some((item) =>
      item.fact.includes('Docker-first deployment strategy'),
    );

    return {
      metrics: {
        falseMemoryRate: ratio(Number(falseFactSurfaced), 1),
      },
      scenarios: [
        assertScenario('summary_only_false_fact_is_not_promoted', !falseFactSurfaced, {
          facts: context.relevantKnowledge.map((item) => item.fact),
        }),
      ],
    };
  } finally {
    await asyncAdapter.close();
  }
}
