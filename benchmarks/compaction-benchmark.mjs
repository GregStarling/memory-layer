import {
  compactTurns,
  createSQLiteAdapter,
  createSessionId,
  wrapSyncAdapter,
} from '../dist/index.js';

// compactTurns expects an AsyncStorageAdapter. Wrap the native sync adapter
// (as real consumers / the test suite do) so the atomic-storage transaction
// runs on the sync path instead of handing an async fn to better-sqlite3.
const syncAdapter = createSQLiteAdapter(':memory:');
const adapter = wrapSyncAdapter(syncAdapter);
const scope = {
  tenant_id: 'bench',
  system_id: 'compaction',
  scope_id: 'run-1',
};
const sessionId = createSessionId(scope);

for (let i = 0; i < 50; i += 1) {
  syncAdapter.insertTurn({
    ...scope,
    session_id: sessionId,
    actor: i % 2 === 0 ? 'user' : 'assistant',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i} about retrieval and compaction in memory systems`,
    token_estimate: 120,
  });
}

const turns = syncAdapter.getActiveTurns(scope);
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

syncAdapter.close();
