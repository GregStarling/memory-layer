/**
 * Multi-Agent PostgreSQL Example
 *
 * Demonstrates two agents sharing a single PostgreSQL memory store,
 * using cross-scope retrieval to access each other's knowledge.
 */
import { createExtractiveSummarizer, createMemoryManager, createRegexExtractor } from 'memory-layer';
import { createPostgresAdapter } from 'memory-layer/adapters/postgres';

async function main() {
  const connectionString = process.env.MEMORY_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Set MEMORY_DATABASE_URL to a real Postgres connection string before running this example.',
    );
  }
  const pgModule = await import('pg');
  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  const pool = new Pool({ connectionString });

  const adapter = createPostgresAdapter(pool);

  // Agent 1: Research agent
  const researcher = createMemoryManager({
    asyncAdapter: adapter,
    scope: {
      tenant_id: 'multi-agent-demo',
      system_id: 'researcher',
      workspace_id: 'shared-workspace',
      scope_id: 'research-session-1',
    },
    sessionId: 'researcher-001',
    summarizer: createExtractiveSummarizer(),
    extractor: createRegexExtractor(),
    crossScopeLevel: 'workspace', // Can read workspace-level knowledge
    autoCompact: true,
    autoExtract: true,
  });

  // Agent 2: Builder agent
  const builder = createMemoryManager({
    asyncAdapter: adapter,
    scope: {
      tenant_id: 'multi-agent-demo',
      system_id: 'builder',
      workspace_id: 'shared-workspace',
      scope_id: 'build-session-1',
    },
    sessionId: 'builder-001',
    summarizer: createExtractiveSummarizer(),
    extractor: createRegexExtractor(),
    crossScopeLevel: 'workspace', // Can read workspace-level knowledge
    autoCompact: true,
    autoExtract: true,
  });

  // Researcher learns something
  await researcher.learnFact(
    'The API rate limit is 100 requests per minute',
    'constraint',
    'high',
  );

  // Builder can find this via cross-scope search
  const results = await builder.searchCrossScope('rate limit', 'workspace');
  console.log('Builder found researcher knowledge:', results);

  await researcher.close();
  await builder.close();
  await pool.end();
}

main().catch(console.error);
