import { createLocalEmbeddingGenerator, createMemory } from '../../dist/index.js';

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function captureCapabilityMeta(options) {
  const events = [];
  const memory = createMemory({
    adapter: 'memory',
    onEvent: (event) => events.push(event),
    ...options,
  });
  try {
    return events.find((event) => event.type === 'capability')?.meta ?? {};
  } finally {
    await memory.close();
  }
}

async function buildExtractedMemory(mode, turn, summary, fact) {
  const memory = createMemory({
    adapter: 'memory',
    qualityMode: mode,
    summarizer: async () => ({
      summary,
      key_entities: [],
      topic_tags: [],
    }),
    extractor: async () => [fact],
    policies: {
      monitor: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 1,
        hardTurnThreshold: 1,
        softTokenThreshold: 1,
        hardTokenThreshold: 1,
      },
    },
  });
  await memory.processTurn('user', turn);
  await memory.forceCompact();
  return memory;
}

export async function runQualityModeReport() {
  const fastWeak = await buildExtractedMemory(
    'fast_adoption',
    'Use smaller batches for the migration.',
    'Use smaller batches for the migration.',
    {
      fact: 'Use smaller batches for the migration.',
      factType: 'decision',
      confidence: 'high',
    },
  );
  const balancedWeak = await buildExtractedMemory(
    'balanced_memory',
    'Use smaller batches for the migration.',
    'Use smaller batches for the migration.',
    {
      fact: 'Use smaller batches for the migration.',
      factType: 'decision',
      confidence: 'high',
    },
  );
  const highConstraint = createMemory({
    adapter: 'memory',
    qualityMode: 'high_fidelity_memory',
    autoCompact: false,
    autoExtract: false,
  });
  try {
    await highConstraint.learnFact('The system must remain local-first.', 'constraint', 'high');
    const [providerCapability, localSemanticVectors] = await Promise.all([
      captureCapabilityMeta({
        summarizer: 'openai',
        extractor: 'openai',
        qualityTier: 'provider_backed',
      }),
      createLocalEmbeddingGenerator()([
        'PostgreSQL deployment pipeline',
        'pg deploy workflow',
        'Tailwind color palette',
      ]),
    ]);
    const [postgresVector, aliasVector, unrelatedVector] = localSemanticVectors;
    const originalNow = Date.now;
    Date.now = () => new Date('2024-06-01T00:00:00Z').valueOf();
    try {
      await highConstraint.runMaintenance({
        knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
        maxActiveKnowledgeItems: 20,
      });
    } finally {
      Date.now = originalNow;
    }

    return {
      recommendedDefault: 'balanced_memory',
      offlineTiers: {
        fallbackLocalSemanticAvailable: false,
        strongLocalAliasSimilarityBeatsNoise:
          cosine(postgresVector, aliasVector) > cosine(postgresVector, unrelatedVector),
        providerBackedCapability: {
          extractorTier: providerCapability.extractorTier ?? null,
          providerBacked: providerCapability.providerBacked ?? false,
        },
      },
      modes: {
        fast_adoption: {
          weaklyGroundedDecisionState: (await fastWeak.recall({ start_at: 0 })).knowledge[0]?.knowledge_state ?? null,
        },
        balanced_memory: {
          weaklyGroundedDecisionState:
            (await balancedWeak.recall({ start_at: 0 })).knowledge[0]?.knowledge_state ?? null,
        },
        high_fidelity_memory: {
          retainedConstraintAfterLongIdle: (
            await highConstraint.getContext('local-first')
          ).relevantKnowledge.some((item) => item.fact.toLowerCase().includes('local-first')),
        },
      },
    };
  } finally {
    await Promise.all([
      fastWeak.close(),
      balancedWeak.close(),
      highConstraint.close(),
    ]);
  }
}
