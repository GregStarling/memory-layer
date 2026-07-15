/**
 * Concurrency 5.4 — test 2: optimistic-lock race (audit item 0.7).
 *
 * N agents concurrently `updateWorkItem` the SAME item with the SAME
 * `expectedVersion` (the seeded version, 1). The guard lives in the UPDATE's
 * WHERE (`... AND COALESCE(version,1) = $expected`) and `rowCount` is the
 * authority (Phase 0.7): under READ COMMITTED, losers block on the winner's row
 * lock, re-evaluate the WHERE against the now-bumped version, match zero rows,
 * and throw a version-mismatch ConflictError. Exactly one wins and the final
 * version is start+1 — never start+N.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import { ConflictError } from '../../contracts/errors.js';
import type { MemoryScope } from '../../contracts/identity.js';
import {
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
    '[concurrency] POSTGRES_TEST_URL not set — skipping optimistic-lock concurrency test.',
  );
}

const N = 8;

function scope(schemaName: string): MemoryScope {
  return { tenant_id: 'conc', system_id: 'sys', workspace_id: schemaName, scope_id: 'optlock' };
}

describeConcurrency('Concurrency — optimistic-lock race (0.7)', () => {
  let env: PgConcurrencyEnv;

  beforeEach(async () => {
    env = await setupPgConcurrency();
  });

  afterEach(async () => {
    await env?.teardown();
  });

  it('exactly one of N concurrent version-guarded updates wins; version = start+1', async () => {
    const s = scope(env.schemaName);
    const workItem = await env.control.insertWorkItem({
      ...s,
      kind: 'objective',
      title: 'original title',
    });
    const startVersion = workItem.version;
    expect(startVersion).toBe(1);

    const racers = await env.spawnRacers(N);
    const results = await raceAll(racers, (adapter: AsyncStorageAdapter, i) =>
      adapter.updateWorkItem(
        workItem.id,
        { title: `updated-by-${i}` },
        { expectedVersion: startVersion },
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Invariant: exactly one writer wins.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    // Invariant: losers get the DOMAIN version-mismatch conflict.
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(ConflictError);
      expect(String((reason as Error).message)).toContain('version mismatch');
    }

    const winner = (
      fulfilled[0] as PromiseFulfilledResult<
        Awaited<ReturnType<AsyncStorageAdapter['updateWorkItem']>>
      >
    ).value;
    expect(winner).not.toBeNull();
    expect(winner!.version).toBe(startVersion + 1);

    // Invariant: the persisted row advanced by exactly one version, and its
    // title is the winner's (not a lost writer's).
    const finalItem = await env.control.getWorkItemById(workItem.id);
    expect(finalItem?.version).toBe(startVersion + 1);
    expect(finalItem?.title).toBe(winner!.title);

    // Exactly one update event was written (losers rolled back before emitting).
    const updateEvents = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'work_item' AND entity_id = $1 AND event_type = 'work_item.updated'`,
      [String(workItem.id)],
    );
    expect(updateEvents).toBe(1);
  });
});
