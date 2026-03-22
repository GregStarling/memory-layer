import {
  buildMemoryContext,
  compactTurns,
  createInMemoryAdapter,
  extractKnowledge,
  wrapSyncAdapter,
} from '../../dist/index.js';
import { assertScenario, average, ratio } from './shared.mjs';

function containsFact(context, fragment) {
  return context.relevantKnowledge.some((item) => item.fact.toLowerCase().includes(fragment.toLowerCase()));
}

function containsSummaryDetail(context, fragment) {
  const needle = fragment.toLowerCase();
  if (context.workingMemory?.summary?.toLowerCase().includes(needle)) {
    return true;
  }
  return context.recentSummaries.some((item) => item.summary.toLowerCase().includes(needle));
}

export async function runFidelityEvals() {
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'fidelity',
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
        content: 'Critical constraint: the system must remain local-first and avoid remote persistence by default.',
      },
      {
        ...scope,
        session_id: sessionId,
        actor: 'assistant',
        role: 'assistant',
        content: 'Understood.',
      },
      {
        ...scope,
        session_id: sessionId,
        actor: 'user',
        role: 'user',
        content: 'Secondary detail: the dashboard theme should stay green.',
      },
      {
        ...scope,
        session_id: sessionId,
        actor: 'assistant',
        role: 'assistant',
        content: 'Acknowledged.',
      },
    ]);

    const compaction = await compactTurns(
      asyncAdapter,
      scope,
      sessionId,
      turns,
      async () => ({
        summary: 'The project uses green UI styling. Mention the theme update.',
        key_entities: ['UI'],
        topic_tags: ['ui'],
      }),
      'manual',
      0,
    );

    await extractKnowledge(asyncAdapter, compaction.workingMemory.id, scope, async (summary) => {
      const facts = [];
      if (summary.includes('green UI styling')) {
        facts.push({
          fact: 'The project uses green UI styling.',
          factType: 'reference',
          confidence: 'medium',
        });
      }
      return facts;
    });

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'local-first persistence dashboard theme',
    });
    const preservedConstraint = containsFact(context, 'local-first');
    const preservedSecondary =
      containsFact(context, 'green UI styling') || containsSummaryDetail(context, 'green UI styling');

    return {
      metrics: {
        postCompactionFidelityScore: average([
          Number(preservedConstraint),
          Number(preservedSecondary),
        ]),
      },
      scenarios: [
        assertScenario('critical_constraint_survives_compaction', preservedConstraint, {
          facts: context.relevantKnowledge.map((item) => item.fact),
        }),
        assertScenario('secondary_detail_can_survive_compaction', preservedSecondary, {
          facts: context.relevantKnowledge.map((item) => item.fact),
          summaries: [
            context.workingMemory?.summary ?? null,
            ...context.recentSummaries.map((item) => item.summary),
          ].filter(Boolean),
        }),
      ],
    };
  } finally {
    await asyncAdapter.close();
  }
}
