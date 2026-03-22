import { buildMemoryContext, createSQLiteAdapter, wrapSyncAdapter } from '../dist/index.js';

const adapter = createSQLiteAdapter(':memory:');
const asyncAdapter = wrapSyncAdapter(adapter);
const scope = {
  tenant_id: 'eval',
  system_id: 'retrieval',
  scope_id: 'scenario-1',
};

adapter.insertKnowledgeMemory({
  ...scope,
  fact: 'The user prefers local-first sqlite deployments',
  fact_type: 'preference',
  source: 'manual',
  confidence: 'high',
});
adapter.insertKnowledgeMemory({
  ...scope,
  fact: 'The project uses tailwind for the UI',
  fact_type: 'reference',
  source: 'manual',
  confidence: 'high',
});

const context = await buildMemoryContext(asyncAdapter, scope, {
  relevanceQuery: 'sqlite local-first',
});

const passed = context.relevantKnowledge[0]?.fact.includes('sqlite') ?? false;
const shouldEnforce = process.argv.includes('--enforce');

console.log(
  JSON.stringify(
    {
      eval: 'retrieval-quality',
      passed,
      topFact: context.relevantKnowledge[0]?.fact ?? null,
    },
    null,
    2,
  ),
);

adapter.close();

if (shouldEnforce && !passed) {
  process.exit(1);
}
