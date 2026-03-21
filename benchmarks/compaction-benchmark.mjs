import {
  compactTurns,
  createSQLiteAdapter,
  createSessionId,
} from '../dist/index.js';

const adapter = createSQLiteAdapter(':memory:');
const scope = {
  tenant_id: 'bench',
  system_id: 'compaction',
  scope_id: 'run-1',
};
const sessionId = createSessionId(scope);

for (let i = 0; i < 50; i += 1) {
  adapter.insertTurn({
    ...scope,
    session_id: sessionId,
    actor: i % 2 === 0 ? 'user' : 'assistant',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i} about retrieval and compaction in memory systems`,
    token_estimate: 120,
  });
}

const turns = adapter.getActiveTurns(scope);
const startedAt = performance.now();
await compactTurns(
  adapter,
  scope,
  sessionId,
  turns,
  async (turnsToSummarize) => ({
    summary: `Summarized ${turnsToSummarize.length} turns`,
    key_entities: ['memory-layer'],
    topic_tags: ['benchmark'],
  }),
  'soft',
  8,
);
const elapsedMs = performance.now() - startedAt;

console.log(
  JSON.stringify(
    {
      benchmark: 'compaction',
      totalMs: Math.round(elapsedMs),
      archivedTurns: turns.length - 8,
    },
    null,
    2,
  ),
);

adapter.close();
