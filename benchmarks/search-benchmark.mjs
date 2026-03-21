import { createSQLiteAdapter } from '../dist/index.js';

const adapter = createSQLiteAdapter(':memory:');
const scope = {
  tenant_id: 'bench',
  system_id: 'search',
  scope_id: 'run-1',
};

for (let i = 0; i < 2000; i += 1) {
  adapter.insertKnowledgeMemory({
    ...scope,
    fact: `Knowledge fact ${i} about sqlite memory retrieval`,
    fact_type: 'reference',
    source: 'manual',
    confidence: 'high',
  });
}

const startedAt = performance.now();
for (let i = 0; i < 500; i += 1) {
  adapter.searchKnowledge(scope, 'sqlite retrieval');
}
const elapsedMs = performance.now() - startedAt;

console.log(
  JSON.stringify(
    {
      benchmark: 'search',
      iterations: 500,
      totalMs: Math.round(elapsedMs),
      avgMs: Number((elapsedMs / 500).toFixed(3)),
    },
    null,
    2,
  ),
);

adapter.close();
