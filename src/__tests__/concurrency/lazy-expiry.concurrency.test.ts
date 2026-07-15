/**
 * Concurrency 5.4 — test 3: lazy-expiry double-emission (audit item 2.5).
 *
 * A claim's lease is expired (wall-clock is irrelevant: the reaper takes an
 * explicit `currentNow`). N reapers then run `expireStaleClaims` concurrently,
 * each on its own connection, released together. Two independent guards make
 * expiry exactly-once:
 *   1. the candidate SELECT is `FOR UPDATE SKIP LOCKED`, so exactly one reaper
 *      locks the stale row and the rest see an empty candidate set;
 *   2. `expireClaimRecord`'s UPDATE is self-guarding
 *      (`WHERE status='active' AND expires_at<=now`, rowCount authority), so a
 *      racing reaper that somehow reached it emits NO event on 0 rows.
 *
 * Invariant: exactly ONE `work_claim.expired` event exists afterward and the
 * claim transitions active→expired exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { ActorRef, NewWorkClaimInput } from '../../contracts/coordination.js';
import type { MemoryScope } from '../../contracts/identity.js';
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
  console.info('[concurrency] POSTGRES_TEST_URL not set — skipping lazy-expiry concurrency test.');
}

const N = 8;
const LEASE_SECONDS = 300;
// Reaper clock is well past the lease end but still int4-safe.
const REAP_NOW = BASE_TS + 10_000;

function scope(schemaName: string): MemoryScope {
  return { tenant_id: 'conc', system_id: 'sys', workspace_id: schemaName, scope_id: 'lazy-expiry' };
}

function actor(): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: 'agent-owner',
    system_id: 'sys',
    display_name: null,
    metadata: null,
  };
}

function claimInput(s: MemoryScope, workItemId: number): NewWorkClaimInput {
  return {
    tenant_id: s.tenant_id,
    system_id: s.system_id,
    workspace_id: s.workspace_id ?? 'default',
    collaboration_id: s.collaboration_id ?? '',
    scope_id: s.scope_id,
    work_item_id: workItemId,
    actor: actor(),
    visibility_class: 'private',
    claimed_at: BASE_TS,
    lease_seconds: LEASE_SECONDS,
  };
}

describeConcurrency('Concurrency — lazy-expiry double-emission (2.5)', () => {
  let env: PgConcurrencyEnv;

  beforeEach(async () => {
    env = await setupPgConcurrency();
  });

  afterEach(async () => {
    await env?.teardown();
  });

  it('N concurrent reapers expire a stale claim exactly once', async () => {
    const s = scope(env.schemaName);
    const workItem = await env.control.insertWorkItem({
      ...s,
      kind: 'objective',
      title: 'leased work item',
    });
    const claim = await env.control.claimWorkItem(claimInput(s, workItem.id));
    expect(claim.status).toBe('active');
    // Sanity: the lease is in the past relative to the reaper clock.
    expect(claim.expires_at).toBeLessThanOrEqual(REAP_NOW);

    const racers = await env.spawnRacers(N);
    const results = await raceAll(racers, (adapter: AsyncStorageAdapter) =>
      adapter.expireStaleClaims(s, REAP_NOW),
    );

    // No reaper should error.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    // Invariant: exactly one reaper reports the claim as expired; the rest
    // return an empty batch (SKIP LOCKED partitioned the single stale row).
    const expiredIds = results.flatMap((r) =>
      r.status === 'fulfilled' ? (r.value as number[]) : [],
    );
    expect(expiredIds).toEqual([claim.id]);

    const reapersThatExpired = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as number[]).length > 0,
    );
    expect(reapersThatExpired).toHaveLength(1);

    // Invariant: exactly ONE work_claim.expired event in the log.
    const expiredEvents = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE event_type = 'work_claim.expired' AND entity_id = $1`,
      [String(claim.id)],
    );
    expect(expiredEvents).toBe(1);

    // Invariant: the claim transitioned exactly once (active→expired). Version
    // advanced by exactly one from the claimed row.
    const { rows } = await env.controlPool.query(
      `SELECT status, version FROM work_claims_current WHERE id = $1`,
      [claim.id],
    );
    expect(rows[0].status).toBe('expired');
    expect(Number(rows[0].version)).toBe(claim.version + 1);
  });
});
