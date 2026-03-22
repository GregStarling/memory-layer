import {
  buildMemoryContext,
  createMemoryManager,
  createSQLiteAdapter,
  extractKnowledge,
  wrapSyncAdapter,
} from '../../dist/index.js';
import { assertScenario, average, ratio } from './shared.mjs';

export async function runContradictionEvals() {
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'contradictions',
    scope_id: 'preference-update',
  };
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const manager = createMemoryManager({
    adapter,
    scope,
    sessionId: 'phase-2-contradictions',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
  });

  async function extractFact(localScope, contents, fact, factType) {
    const sessionId = `${localScope.scope_id}-${Math.random().toString(36).slice(2, 8)}`;
    const turns = adapter.insertTurns(
      contents.map((entry, index) => ({
        ...localScope,
        session_id: sessionId,
        actor: `actor-${index + 1}`,
        role: typeof entry === 'string' ? (index % 2 === 0 ? 'user' : 'assistant') : entry.role,
        content: typeof entry === 'string' ? entry : entry.content,
      })),
    );
    const workingMemory = adapter.insertWorkingMemory({
      ...localScope,
      session_id: sessionId,
      summary: fact,
      key_entities: [],
      topic_tags: [],
      turn_id_start: turns[0].id,
      turn_id_end: turns.at(-1).id,
      turn_count: turns.length,
      compaction_trigger: 'manual',
    });
    return extractKnowledge(asyncAdapter, workingMemory.id, localScope, async () => [
      {
        fact,
        factType,
        confidence: 'high',
      },
    ]);
  }

  try {
    const initial = await extractFact(
      scope,
      ['The user prefers TypeScript.', 'Yes, the user prefers TypeScript for backend work.'],
      'The user prefers TypeScript.',
      'preference',
    );
    const replacement = await extractFact(
      scope,
      ['The user prefers Go.', 'Yes, the user prefers Go now.'],
      'The user prefers Go.',
      'preference',
    );
    const updateContext = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: 'preferred language backend',
    });
    const facts = updateContext.relevantKnowledge.map((item) => item.fact);
    const newestIsPreferred = facts[0]?.includes('Go') ?? false;
    const oldStillPresent = facts.some((fact) => fact.includes('TypeScript'));
    const originalAfter = adapter.getKnowledgeMemoryById(initial[0].id);

    const contradictionScope = { ...scope, scope_id: 'constraint-conflict' };
    const trustedConstraint = await extractFact(
      contradictionScope,
      ['The system must use Docker.', 'The system must use Docker.'],
      'The system must use Docker.',
      'constraint',
    );
    const weakContradiction = await extractFact(
      contradictionScope,
      ['The system must not use Docker.'],
      'The system must not use Docker.',
      'constraint',
    );
    const disputedOriginal = adapter.getKnowledgeMemoryById(trustedConstraint[0].id);

    const assistantScope = { ...scope, scope_id: 'assistant-claim' };
    const assistantOnly = await extractFact(
      assistantScope,
      [{ role: 'assistant', content: 'The user prefers Go.' }],
      'The user prefers Go.',
      'preference',
    );
    const assistantOnlyAssessment = await manager.reverifyKnowledge(assistantOnly[0].id);
    const assistantKnowledge = adapter.getKnowledgeMemoryById(assistantOnly[0].id);

    const metrics = {
      updateCorrectnessRate: ratio(Number(newestIsPreferred), 1),
      contradictionResolutionAccuracy: average([
        Number(disputedOriginal?.knowledge_state === 'disputed'),
        Number(weakContradiction.length === 0),
      ]),
      trustedMemoryPrecision: average([
        Number(newestIsPreferred),
        Number(assistantKnowledge?.knowledge_state !== 'trusted'),
        Number(replacement[0]?.knowledge_state === 'trusted'),
      ]),
      provisionalLeakRate: ratio(Number(assistantKnowledge?.knowledge_state === 'trusted'), 1),
    };

    return {
      metrics,
      scenarios: [
        assertScenario('prefers_latest_update_over_outdated_memory', newestIsPreferred, {
          facts,
        }),
        assertScenario('outdated_memory_is_removed_or_demoted', !oldStillPresent, {
          facts,
          originalState: originalAfter?.knowledge_state ?? null,
        }),
        assertScenario('weak_contradiction_marks_prior_fact_disputed', disputedOriginal?.knowledge_state === 'disputed', {
          originalState: disputedOriginal?.knowledge_state ?? null,
          weakContradictionCount: weakContradiction.length,
        }),
        assertScenario('unsupported_assistant_claim_does_not_become_trusted', assistantKnowledge?.knowledge_state !== 'trusted', {
          state: assistantKnowledge?.knowledge_state ?? null,
          assessment: assistantOnlyAssessment,
        }),
      ],
    };
  } finally {
    await manager.close();
  }
}
