import { createSQLiteAdapterWithEmbeddings } from '../dist/index.js';

const adapter = createSQLiteAdapterWithEmbeddings(':memory:');
const scope = {
  tenant_id: 'bench',
  system_id: 'semantic',
  scope_id: 'run-1',
};

for (let i = 0; i < 1000; i += 1) {
  const knowledge = adapter.insertKnowledgeMemory({
    ...scope,
    fact: `Semantic fact ${i}`,
    fact_type: 'reference',
    source: 'manual',
    confidence: 'high',
  });
  adapter.embeddings.storeEmbedding(
    knowledge.id,
    new Float32Array([i % 10, (i + 1) % 10, (i + 2) % 10]),
  );
}

const startedAt = performance.now();
for (let i = 0; i < 250; i += 1) {
  adapter.embeddings.findSimilar(scope, new Float32Array([1, 2, 3]), { limit: 10 });
}
const elapsedMs = performance.now() - startedAt;

console.log(
  JSON.stringify(
    {
      benchmark: 'semantic',
      iterations: 250,
      totalMs: Math.round(elapsedMs),
      avgMs: Number((elapsedMs / 250).toFixed(3)),
    },
    null,
    2,
  ),
);

adapter.close();
