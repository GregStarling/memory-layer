/**
 * Concurrency 5.4 — test 4: parallel compaction on one scope.
 *
 * N compactions of the SAME seeded scope/session run concurrently, each through
 * its own connection with the SAME turn snapshot and `retainedTurnCount = 0`.
 *
 * HONEST outcome (verified against the adapter source, not assumed):
 *   - `commitCompaction` runs the whole compaction as ONE transaction
 *     (`runAtomicStorage` → `adapter.transaction`), but there is NO advisory
 *     lock and `archiveTurn`'s UPDATE has NO turn-status guard, so the system
 *     does NOT serialize the compaction LOGIC and does NOT dedup.
 *   - The only ordering comes incidentally from the `projection_watermarks` row
 *     lock every event write takes: it makes the transactions execute one at a
 *     time and, because a waiter holds only its own fresh rows, guarantees NO
 *     deadlock. It does NOT turn later calls into no-ops.
 *
 * So we assert the guarantees that actually hold — no lost turns, internal
 * consistency of each compaction's rows, all calls succeed — and we assert the
 * (honest) duplicate coverage rather than inventing a "compacted once" claim.
 * See the report for the reviewer note on this de-facto serialization.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { MemoryScope } from '../../contracts/identity.js';
import type { Turn } from '../../contracts/types.js';
import { compactTurns, type Summarizer } from '../../core/orchestrator.js';
import {
  BASE_TS,
  POSTGRES_TEST_URL,
  countRows,
  raceAll,
  setupPgConcurrency,
  type PgConcurrencyEnv,
} from './concurrency-harness.js';

const describeConcurrency = POSTGRES_TEST_URL ? describe : describe.skip;
if (!POSTGRES_TEST_URL) {
  // eslint-disable-next-line no-console
  console.info(
    '[concurrency] POSTGRES_TEST_URL not set — skipping parallel-compaction concurrency test.',
  );
}

const N = 4;
const TURN_COUNT = 6;
const SESSION_ID = 'session-compact';

function scope(schemaName: string): MemoryScope {
  return { tenant_id: 'conc', system_id: 'sys', workspace_id: schemaName, scope_id: 'compaction' };
}

// Deterministic summarizer: no model call, byte-identical output every run.
const summarizer: Summarizer = async () => ({
  summary: 'seeded deterministic summary',
  key_entities: ['entity-a'],
  topic_tags: ['tag-a'],
});

describeConcurrency('Concurrency — parallel compaction on one scope', () => {
  let env: PgConcurrencyEnv;

  beforeEach(async () => {
    env = await setupPgConcurrency();
  });

  afterEach(async () => {
    await env?.teardown();
  });

  it('N concurrent compactions leave no lost turns and stay internally consistent', async () => {
    const s = scope(env.schemaName);
    for (let i = 0; i < TURN_COUNT; i++) {
      await env.control.insertTurn({
        ...s,
        session_id: SESSION_ID,
        actor: i % 2 === 0 ? 'user' : 'assistant',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i} content`,
        token_estimate: 10,
        created_at: BASE_TS + i,
      });
    }

    const activeTurns: Turn[] = await env.control.getActiveTurns(s, SESSION_ID);
    expect(activeTurns).toHaveLength(TURN_COUNT);

    const racers = await env.spawnRacers(N);
    const results = await raceAll(racers, (adapter: AsyncStorageAdapter) =>
      compactTurns(adapter, s, SESSION_ID, activeTurns, summarizer, 'manual', 0),
    );

    // Invariant: every call succeeds — no deadlock, no crash. (The watermark
    // row lock serializes execution; the consistent ascending turn-lock order
    // rules out a deadlock cycle.)
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    // Invariant: NO lost turns — every seeded turn ends up archived, none left
    // active.
    const activeAfter = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM turns WHERE session_id = $1 AND status = 'active'`,
      [SESSION_ID],
    );
    expect(activeAfter).toBe(0);
    const archivedAfter = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM turns WHERE session_id = $1 AND status = 'archived'`,
      [SESSION_ID],
    );
    expect(archivedAfter).toBe(TURN_COUNT);
    // Every archived turn points at a real compaction_log row.
    const danglingCompactionRefs = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM turns t
       WHERE t.session_id = $1
         AND (t.compaction_log_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM compaction_log c WHERE c.id = t.compaction_log_id))`,
      [SESSION_ID],
    );
    expect(danglingCompactionRefs).toBe(0);

    // Honest invariant: the system does NOT dedup — one logical compaction
    // became N. Each committed compaction produced exactly one working_memory
    // and one compaction_log row, and every compaction_log covers the full
    // seeded range.
    const workingMemoryRows = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM working_memory WHERE session_id = $1`,
      [SESSION_ID],
    );
    expect(workingMemoryRows).toBe(N);
    const compactionLogRows = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM compaction_log WHERE session_id = $1`,
      [SESSION_ID],
    );
    expect(compactionLogRows).toBe(N);
    const fullCoverageLogs = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM compaction_log WHERE session_id = $1 AND turns_compacted = $2`,
      [SESSION_ID, TURN_COUNT],
    );
    expect(fullCoverageLogs).toBe(N);

    // Event log is internally consistent: one working_memory.created per
    // compaction, and one turn.archived per (turn × compaction) — the honest
    // over-archival that follows from no dedup.
    const wmEvents = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE session_id = $1 AND event_type = 'working_memory.created'`,
      [SESSION_ID],
    );
    expect(wmEvents).toBe(N);
    const archivedEvents = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE session_id = $1 AND event_type = 'turn.archived'`,
      [SESSION_ID],
    );
    expect(archivedEvents).toBe(N * TURN_COUNT);
  });
});
