/**
 * Concurrency 5.4 — test 1: work-claim race (audit item 0.2).
 *
 * N=8 agents concurrently `claimWorkItem` the SAME open work item, each through
 * its own pool/connection, released together by a barrier. The claim contention
 * is decided by the `work_claims_current` UNIQUE(work_item_id) row and the
 * self-guarding `INSERT ... ON CONFLICT DO UPDATE ... WHERE status<>'active' OR
 * expires_at<=claimed_at` (Phase 0.2), BEFORE any event/watermark write — so
 * exactly one transaction wins and the other seven get a domain ConflictError.
 *
 * Distinct actors per racer are REQUIRED for the clean 1-win/7-conflict split:
 * a same-actor racer whose pre-SELECT observed the committed active row would
 * take the renew path (a success), not a conflict.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { ActorRef, NewWorkClaimInput } from '../../contracts/coordination.js';
import { ConflictError } from '../../contracts/errors.js';
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
  console.info('[concurrency] POSTGRES_TEST_URL not set — skipping claim-race concurrency test.');
}

const N = 8;

function scope(schemaName: string): MemoryScope {
  return { tenant_id: 'conc', system_id: 'sys', workspace_id: schemaName, scope_id: 'claim-race' };
}

function actor(i: number): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: `agent-${i}`,
    system_id: 'sys',
    display_name: null,
    metadata: null,
  };
}

function claimInput(s: MemoryScope, workItemId: number, i: number): NewWorkClaimInput {
  return {
    tenant_id: s.tenant_id,
    system_id: s.system_id,
    workspace_id: s.workspace_id ?? 'default',
    collaboration_id: s.collaboration_id ?? '',
    scope_id: s.scope_id,
    work_item_id: workItemId,
    actor: actor(i),
    visibility_class: 'private',
    claimed_at: BASE_TS,
    lease_seconds: 300,
  };
}

describeConcurrency('Concurrency — claim race (0.2)', () => {
  let env: PgConcurrencyEnv;

  beforeEach(async () => {
    env = await setupPgConcurrency();
  });

  afterEach(async () => {
    await env?.teardown();
  });

  it('exactly one of N concurrent claims wins; the rest get ConflictError', async () => {
    const s = scope(env.schemaName);
    const workItem = await env.control.insertWorkItem({
      ...s,
      kind: 'objective',
      title: 'contended work item',
    });

    const racers = await env.spawnRacers(N);
    const results = await raceAll(racers, (adapter: AsyncStorageAdapter, i) =>
      adapter.claimWorkItem(claimInput(s, workItem.id, i)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Invariant: exactly one winner.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    // Invariant: every loser fails with the DOMAIN conflict error, not a raw
    // Postgres unique-violation or a connection error.
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(ConflictError);
      expect(String((reason as Error).message)).toContain('already claimed');
    }

    // Invariant: the winner's claim row is the single active row for the item.
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<AsyncStorageAdapter['claimWorkItem']>>>)
      .value;
    expect(winner.status).toBe('active');

    const activeCount = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM work_claims_current WHERE work_item_id = $1 AND status = 'active'`,
      [workItem.id],
    );
    expect(activeCount).toBe(1);

    // The current-state projection holds exactly one row per work item (UNIQUE).
    const totalRows = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM work_claims_current WHERE work_item_id = $1`,
      [workItem.id],
    );
    expect(totalRows).toBe(1);

    // Exactly one claim-created event was emitted (losers rolled back).
    const claimedEvents = await countRows(
      env.controlPool,
      `SELECT COUNT(*)::int AS n FROM memory_event_log WHERE event_type = 'work_claim.claimed' AND entity_id = $1`,
      [String(winner.id)],
    );
    expect(claimedEvents).toBe(1);

    // The active claim belongs to exactly one of the racing actors.
    const { rows } = await env.controlPool.query(
      `SELECT actor_id FROM work_claims_current WHERE work_item_id = $1 AND status = 'active'`,
      [workItem.id],
    );
    expect(rows[0].actor_id).toBe(winner.actor.actor_id);
  });
});
