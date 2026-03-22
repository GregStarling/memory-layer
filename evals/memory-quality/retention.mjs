import { createMemory } from '../../dist/index.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

function hasFact(items, needle) {
  const loweredNeedle = needle.toLowerCase();
  return items.some((item) => item.fact.toLowerCase().includes(loweredNeedle));
}

async function addNoise(memory, count) {
  for (let index = 0; index < count; index += 1) {
    await memory.processExchange(
      `Noise user turn ${index + 1}: discussing unrelated implementation detail ${index + 1}.`,
      `Noise assistant turn ${index + 1}: acknowledging unrelated implementation detail ${index + 1}.`,
    );
  }
}

export async function runRetentionEvals(_options = {}) {
  const memory = createMemory({
    adapter: 'memory',
    scope: {
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'retention',
      scope_id: 'thread-1',
    },
    autoCompact: true,
    autoExtract: false,
    policies: {
      monitor: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 4,
        hardTurnThreshold: 6,
        softTokenThreshold: 64,
        hardTokenThreshold: 128,
      },
    },
  });

  try {
    await memory.learnFact('The system must remain local-first.', 'constraint', 'high');
    await memory.learnFact('The user prefers TypeScript for implementation work.', 'preference', 'high');
    await memory.learnFact('The assistant identity is Memory Layer.', 'entity', 'high');
    await memory.learnFact('Procedure: run tests before shipping changes.', 'decision', 'high');
    await memory.trackWorkItem('Ship the grounded memory rewrite', 'objective', 'in_progress');

    await addNoise(memory, 8);
    await memory.forceCompact();

    const context = await memory.getContext('local-first TypeScript Memory Layer run tests ship');

    const constraintHit = hasFact(context.relevantKnowledge, 'local-first');
    const preferenceHit = hasFact(context.relevantKnowledge, 'TypeScript');
    const identityHit = hasFact(context.relevantKnowledge, 'Memory Layer');
    const procedureHit = hasFact(context.relevantKnowledge, 'run tests before shipping');
    const trustedConstraintHit = hasFact(context.trustedCoreMemory, 'local-first');
    const trustedPreferenceHit = hasFact(context.trustedCoreMemory, 'TypeScript');
    const trustedIdentityHit = hasFact(context.trustedCoreMemory, 'Memory Layer');
    const objectiveHit = context.activeObjectives.some((item) => item.title.includes('grounded memory rewrite'));

    const metrics = {
      constraintRetentionRate: ratio(Number(constraintHit), 1),
      preferenceRetentionRate: ratio(Number(preferenceHit), 1),
      identityRetentionRate: ratio(Number(identityHit), 1),
      procedureRetentionRate: ratio(Number(procedureHit), 1),
      trustedMemoryRecall: average([
        Number(trustedConstraintHit),
        Number(trustedPreferenceHit),
        Number(trustedIdentityHit),
        Number(procedureHit),
      ]),
    };

    return tagEvalOutput('retention', {
      metrics,
      scenarios: [
        assertScenario('retains_constraint_memory', constraintHit, {
          facts: context.relevantKnowledge.map((item) => item.fact),
          trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
        }),
        assertScenario('retains_preference_memory', preferenceHit, {
          facts: context.relevantKnowledge.map((item) => item.fact),
          trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
        }),
        assertScenario('retains_identity_memory', identityHit, {
          facts: context.relevantKnowledge.map((item) => item.fact),
          trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
        }),
        assertScenario('retains_procedure_memory', procedureHit, {
          facts: context.relevantKnowledge.map((item) => item.fact),
        }),
        assertScenario('retains_active_objective_context', objectiveHit, {
          objectives: context.activeObjectives.map((item) => item.title),
        }),
      ],
      diagnostic: {
        metricTraces: {
          constraintRetentionRate: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
          },
          preferenceRetentionRate: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
          },
          identityRetentionRate: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
          },
          procedureRetentionRate: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
          },
          trustedMemoryRecall: {
            stage: 'trusted_core_selection',
            trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
          },
        },
        scenarioTraces: {
          retains_constraint_memory: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
            trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
          },
          retains_preference_memory: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
            trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
          },
          retains_identity_memory: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
            trustedCoreFacts: context.trustedCoreMemory.map((item) => item.fact),
          },
          retains_procedure_memory: {
            stage: 'context_selection',
            relevantKnowledge: context.relevantKnowledge.map((item) => item.fact),
          },
          retains_active_objective_context: {
            stage: 'objective_selection',
            activeObjectives: context.activeObjectives.map((item) => item.title),
          },
        },
      },
    });
  } finally {
    await memory.close();
  }
}
