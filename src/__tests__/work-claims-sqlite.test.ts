import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { ConflictError } from '../contracts/errors.js';
import type { ActorRef } from '../contracts/coordination.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function actor(id: string): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: id,
    system_id: null,
    display_name: null,
    metadata: null,
  };
}

describe('SQLite work claims (plan 0.1: reclaimable after expiry/release)', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function newWorkItem() {
    return adapter.insertWorkItem({
      ...scope(),
      kind: 'unresolved_work',
      title: 'reclaimable work',
      visibility_class: 'private',
    });
  }

  it('claim -> expire -> reclaim succeeds for the same actor', () => {
    const item = newWorkItem();
    // Base timestamps on real now so the reclaimed (active) lease genuinely lies
    // in the future — getActiveWorkClaim / listWorkClaims compare against the
    // real clock.
    const now = Math.floor(Date.now() / 1000);
    const first = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: now - 3600, // claimed an hour ago with a 60s lease => expired
    });
    expect(first.status).toBe('active');

    // Reclaim after the lease has lapsed. This is the audit's empirical repro:
    // previously the expired row kept occupying the UNIQUE(work_item_id) slot
    // and this threw ConflictError forever.
    const reclaim = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
      claimed_at: now,
    });
    expect(reclaim.status).toBe('active');
    expect(reclaim.id).not.toBe(first.id);

    const active = adapter.getActiveWorkClaim(item.id);
    expect(active?.id).toBe(reclaim.id);
  });

  it('claim -> expire -> reclaim succeeds for a different actor', () => {
    const item = newWorkItem();
    const now = Math.floor(Date.now() / 1000);
    const first = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: now - 3600,
    });

    const reclaim = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-b'),
      visibility_class: 'private',
      lease_seconds: 300,
      claimed_at: now,
    });
    expect(reclaim.status).toBe('active');
    expect(reclaim.actor.actor_id).toBe('agent-b');
    expect(reclaim.id).not.toBe(first.id);
  });

  it('claim -> release -> reclaim succeeds (same and different actor)', () => {
    const item = newWorkItem();
    const first = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
    });
    const released = adapter.releaseWorkClaim(first.id, actor('agent-a'), 'done for now');
    expect(released?.status).toBe('released');

    const reclaimSame = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
    });
    expect(reclaimSame.status).toBe('active');
    expect(reclaimSame.id).not.toBe(first.id);

    const releasedAgain = adapter.releaseWorkClaim(reclaimSame.id, actor('agent-a'), 'again');
    expect(releasedAgain?.status).toBe('released');

    const reclaimDifferent = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-b'),
      visibility_class: 'private',
      lease_seconds: 300,
    });
    expect(reclaimDifferent.status).toBe('active');
    expect(reclaimDifferent.actor.actor_id).toBe('agent-b');
  });

  it('an active foreign claim still throws ConflictError', () => {
    const item = newWorkItem();
    adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
    });

    expect(() =>
      adapter.claimWorkItem({
        ...scope(),
        work_item_id: item.id,
        actor: actor('agent-b'),
        visibility_class: 'private',
        lease_seconds: 300,
      }),
    ).toThrow(ConflictError);
  });

  it('the same actor re-claiming an active claim renews it (no new row)', () => {
    const item = newWorkItem();
    const first = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
    });
    const renewed = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
    });
    // Renewal keeps the same claim row (id unchanged), does not create history.
    expect(renewed.id).toBe(first.id);
    expect(renewed.expires_at).toBeGreaterThanOrEqual(first.expires_at);
  });

  it('displaced historical claims remain retrievable by id and via listings', () => {
    const item = newWorkItem();
    const now = Math.floor(Date.now() / 1000);
    const first = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: now - 3600,
    });
    const second = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
      claimed_at: now,
    });

    // The displaced first claim is now in history but still resolvable by id.
    const historical = adapter.getWorkClaimById(first.id);
    expect(historical?.id).toBe(first.id);
    expect(historical?.status).toBe('expired');

    // The current claim is resolvable too.
    expect(adapter.getWorkClaimById(second.id)?.id).toBe(second.id);

    // Listings with includeExpired surface the historical claim.
    const withExpired = adapter.listWorkClaims(scope(), { includeExpired: true });
    const ids = withExpired.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);

    // Default listing returns only the active current claim.
    const activeOnly = adapter.listWorkClaims(scope());
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]?.id).toBe(second.id);
  });

  it('cross-scope default listing excludes history but includeExpired surfaces it (0.7 history-skip)', () => {
    // Guards the optimization that skips the work_claims_history UNION for default
    // listings: displaced (expired) claims must stay hidden by default yet remain
    // visible with includeExpired, unchanged from the always-UNION behavior.
    const item = newWorkItem();
    const now = Math.floor(Date.now() / 1000);
    const first = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: now - 3600,
    });
    const second = adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
      claimed_at: now,
    });

    // Default cross-scope listing (at tenant level) returns only the active claim.
    const activeOnly = adapter.listWorkClaimsCrossScope(scope(), 'tenant');
    expect(activeOnly.map((c) => c.id)).toEqual([second.id]);

    // includeExpired still surfaces the displaced historical claim.
    const withExpired = adapter.listWorkClaimsCrossScope(scope(), 'tenant', {
      includeExpired: true,
    });
    const ids = withExpired.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('claim events are still emitted for the reclaim path', () => {
    const item = newWorkItem();
    const now = Math.floor(Date.now() / 1000);
    adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: now - 3600,
    });
    adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 300,
      claimed_at: now,
    });

    const events = adapter
      .listMemoryEvents(scope(), { entityKind: 'work_claim', limit: 100 })
      .events.map((e) => e.event_type);
    expect(events).toContain('work_claim.claimed');
    expect(events).toContain('work_claim.expired');
  });
});

describe('SQLite lazy lease expiry: reads never write (plan 2.5)', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function claimExpiringInThePast() {
    const item = adapter.insertWorkItem({
      ...scope(),
      kind: 'unresolved_work',
      title: 'leased work',
      visibility_class: 'private',
    });
    const now = Math.floor(Date.now() / 1000);
    // Claimed an hour ago with a 60s lease => already lapsed against the clock.
    return adapter.claimWorkItem({
      ...scope(),
      work_item_id: item.id,
      actor: actor('agent-a'),
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: now - 3600,
    });
  }

  function expiredEventCount(claimId: number): number {
    return adapter
      .listMemoryEvents(scope(), { entityKind: 'work_claim', limit: 1000 })
      .events.filter((e) => e.event_type === 'work_claim.expired' && e.entity_id === String(claimId))
      .length;
  }

  it('two concurrent list/get reads of a lapsed claim emit zero expiry events and write nothing', () => {
    const claim = claimExpiringInThePast();
    const eventsBefore = adapter.listMemoryEvents(scope(), { limit: 1000 }).events.length;

    // Simulate two concurrent readers hitting every read path.
    expect(adapter.getActiveWorkClaim(claim.work_item_id)).toBeNull();
    expect(adapter.getActiveWorkClaim(claim.work_item_id)).toBeNull();
    const listedA = adapter.listWorkClaims(scope(), { includeExpired: true });
    const listedB = adapter.listWorkClaims(scope(), { includeExpired: true });
    adapter.listWorkClaimsCrossScope(scope(), 'tenant', { includeExpired: true });
    adapter.listWorkClaimsCrossScope(scope(), 'tenant', { includeExpired: true });

    // Reads report the EFFECTIVE status (expired) without mutating the store.
    expect(listedA.find((c) => c.id === claim.id)?.status).toBe('expired');
    expect(listedB.find((c) => c.id === claim.id)?.status).toBe('expired');

    // No expiry events emitted by reads.
    expect(expiredEventCount(claim.id)).toBe(0);
    expect(adapter.listMemoryEvents(scope(), { limit: 1000 }).events.length).toBe(eventsBefore);
    // getWorkClaimById reports the EFFECTIVE status (D6): consistent with the
    // list paths above.
    expect(adapter.getWorkClaimById(claim.id)?.status).toBe('expired');
    // Prove the reads did NOT durably write the expiry: the reaper can still
    // find and transition the row, which is only possible if it is stored as
    // 'active'. A read-write would have already expired it, so the reaper would
    // return [] and emit zero events.
    const now = Math.floor(Date.now() / 1000);
    expect(adapter.expireStaleClaims(scope(), now)).toEqual([claim.id]);
    expect(expiredEventCount(claim.id)).toBe(1);
  });

  it('expireStaleClaims durably expires the claim and emits exactly one event', () => {
    const claim = claimExpiringInThePast();
    const now = Math.floor(Date.now() / 1000);

    // Reads first (must not have expired anything).
    adapter.listWorkClaims(scope(), { includeExpired: true });
    expect(expiredEventCount(claim.id)).toBe(0);

    const expired = adapter.expireStaleClaims(scope(), now);
    expect(expired).toEqual([claim.id]);
    expect(expiredEventCount(claim.id)).toBe(1);
    expect(adapter.getWorkClaimById(claim.id)?.status).toBe('expired');

    // A second reaper pass is a no-op — the already-expired claim is not
    // re-selected, so no duplicate event.
    const again = adapter.expireStaleClaims(scope(), now + 1000);
    expect(again).toEqual([]);
    expect(expiredEventCount(claim.id)).toBe(1);
  });
});

describe('SQLite lazy handoff expiry (plan 2.5, D5/D6)', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  // A pending handoff whose lease already lapsed against the real clock
  // (expires_at 60s in the past). effectiveHandoff must read it as 'expired'
  // without writing.
  function handoffExpiringInThePast() {
    const item = adapter.insertWorkItem({
      ...scope(),
      kind: 'unresolved_work',
      title: 'handoff work',
      visibility_class: 'private',
    });
    const now = Math.floor(Date.now() / 1000);
    return adapter.createHandoff({
      ...scope(),
      work_item_id: item.id,
      from_actor: actor('agent-a'),
      to_actor: actor('agent-b'),
      summary: 'take this over',
      expires_at: now - 60,
      visibility_class: 'private',
    });
  }

  function handoffExpiredEventCount(handoffId: number): number {
    return adapter
      .listMemoryEvents(scope(), { entityKind: 'handoff', limit: 1000 })
      .events.filter((e) => e.event_type === 'handoff.expired' && e.entity_id === String(handoffId))
      .length;
  }

  it('two list/get reads of a lapsed handoff emit zero events and write nothing (D5/D6)', () => {
    const handoff = handoffExpiringInThePast();
    const eventsBefore = adapter.listMemoryEvents(scope(), { limit: 1000 }).events.length;

    // Two list calls (the double-emission bug class): both compute effective
    // 'expired' without writing.
    const listedA = adapter.listHandoffs(scope());
    const listedB = adapter.listHandoffs(scope());
    adapter.listHandoffsCrossScope(scope(), 'tenant');
    adapter.listHandoffsCrossScope(scope(), 'tenant');
    expect(listedA.find((h) => h.id === handoff.id)?.status).toBe('expired');
    expect(listedB.find((h) => h.id === handoff.id)?.status).toBe('expired');
    // D6: by-id read applies the same effective status as the list paths.
    expect(adapter.getHandoffById(handoff.id)?.status).toBe('expired');

    // No expiry events emitted by reads.
    expect(handoffExpiredEventCount(handoff.id)).toBe(0);
    expect(adapter.listMemoryEvents(scope(), { limit: 1000 }).events.length).toBe(eventsBefore);
    // Prove the reads did NOT durably write the expiry: the reaper can still
    // find and transition the pending row (only possible if it is stored as
    // 'pending'). A read-write would have already expired it, so the reaper
    // would return [] and emit zero events.
    const now = Math.floor(Date.now() / 1000);
    expect(adapter.expireStaleHandoffs(scope(), now)).toEqual([handoff.id]);
    expect(handoffExpiredEventCount(handoff.id)).toBe(1);
  });

  it('expireStaleHandoffs durably expires the handoff and emits exactly one event (D5)', () => {
    const handoff = handoffExpiringInThePast();
    const now = Math.floor(Date.now() / 1000);

    // Reads first (must not have expired anything).
    adapter.listHandoffs(scope());
    expect(handoffExpiredEventCount(handoff.id)).toBe(0);

    const expired = adapter.expireStaleHandoffs(scope(), now);
    expect(expired).toEqual([handoff.id]);
    expect(handoffExpiredEventCount(handoff.id)).toBe(1);
    expect(adapter.getHandoffById(handoff.id)?.status).toBe('expired');

    // A second reaper pass is a no-op — the already-expired handoff is not
    // re-selected (guarded UPDATE ... WHERE status='pending'), so no duplicate.
    const again = adapter.expireStaleHandoffs(scope(), now + 1000);
    expect(again).toEqual([]);
    expect(handoffExpiredEventCount(handoff.id)).toBe(1);
  });
});

describe('SQLite work item optimistic locking (plan 0.7)', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('rejects an update whose expectedVersion is stale (interleaved writer wins once)', () => {
    const item = adapter.insertWorkItem({
      ...scope(),
      kind: 'unresolved_work',
      title: 'contended item',
      visibility_class: 'private',
    });
    expect(item.version).toBe(1);

    // Simulate a concurrent writer bumping the version between another actor's
    // read (which saw version 1) and its write. The interleaved update wins.
    const winner = adapter.updateWorkItem(item.id, { title: 'winner' }, { expectedVersion: 1 });
    expect(winner?.title).toBe('winner');
    expect(winner?.version).toBe(2);

    // The stale writer still believes version is 1 and must lose.
    expect(() =>
      adapter.updateWorkItem(item.id, { title: 'loser' }, { expectedVersion: 1 }),
    ).toThrow(ConflictError);

    const current = adapter.getWorkItemById(item.id);
    expect(current?.title).toBe('winner');
    expect(current?.version).toBe(2);
  });

  it('allows an update with the correct current version', () => {
    const item = adapter.insertWorkItem({
      ...scope(),
      kind: 'unresolved_work',
      title: 'ok item',
      visibility_class: 'private',
    });
    const updated = adapter.updateWorkItem(item.id, { status: 'in_progress' }, { expectedVersion: 1 });
    expect(updated?.status).toBe('in_progress');
    expect(updated?.version).toBe(2);
  });

  // Regression guard for the reviewer's finding: the previous test only performed
  // two SEQUENTIAL updateWorkItem calls, so the loser's own pre-SELECT already saw
  // the bumped version — that would pass even against an implementation that relied
  // on the pre-SELECT rather than the `WHERE ... AND version = ?` SQL guard. This
  // test genuinely interleaves a version bump that lands AFTER updateWorkItem reads
  // the row but BEFORE its guarded UPDATE runs, so the ONLY way the conflict can be
  // detected is the SQL guard producing changes === 0. Verified to FAIL when the
  // `AND version = ?` clause is removed from updateWorkItem.
  it('detects a concurrent bump interleaved between the SELECT and UPDATE via the SQL guard', () => {
    // Monkeypatch prepare on the shared better-sqlite3 prototype so that when the
    // adapter prepares its version-guarded UPDATE, the returned statement bumps the
    // row's version on the very same connection just before its own UPDATE executes.
    // updateWorkItem always runs `SELECT * FROM work_items WHERE id = ?` first, so
    // this injection is strictly after the read and strictly before the guarded
    // write — exactly the race the guard must catch.
    const proto = Database.prototype as unknown as {
      prepare: (this: Database.Database, sql: string) => Database.Statement;
    };
    const originalPrepare = proto.prepare;
    let injected = false;

    proto.prepare = function patchedPrepare(this: Database.Database, sql: string) {
      const stmt = originalPrepare.call(this, sql);
      if (!injected && /UPDATE work_items[\s\S]*WHERE id = \? AND version = \?/.test(sql)) {
        const conn = this;
        const originalRun = stmt.run.bind(stmt);
        (stmt as unknown as { run: (...args: unknown[]) => Database.RunResult }).run = (
          ...args: unknown[]
        ) => {
          injected = true;
          // The interleaved concurrent writer commits its bump on the same handle
          // AFTER updateWorkItem's SELECT (already done) and BEFORE this UPDATE.
          originalPrepare
            .call(conn, 'UPDATE work_items SET version = version + 1 WHERE id = ?')
            .run(item.id);
          return originalRun(...args);
        };
      }
      return stmt;
    };

    let item: { id: number };
    try {
      item = adapter.insertWorkItem({
        ...scope(),
        kind: 'unresolved_work',
        title: 'raced item',
        visibility_class: 'private',
      });

      // The caller read version 1 and passes expectedVersion 1. The injected bump
      // makes the stored version 2 before the guarded UPDATE runs, so the UPDATE
      // matches zero rows and the changes === 0 path must throw ConflictError.
      expect(() =>
        adapter.updateWorkItem(item.id, { title: 'should conflict' }, { expectedVersion: 1 }),
      ).toThrow(ConflictError);
    } finally {
      proto.prepare = originalPrepare;
    }

    // The guarded write matched zero rows and threw ConflictError. Because
    // updateWorkItem is now wrapped in a transaction (Phase 2.1 atomic
    // mutation+event), the ConflictError rolls the whole transaction back —
    // including the interleaved bump, which the test injects on the SAME
    // connection and is therefore subsumed by that transaction. So the row is
    // left exactly as it was: title unchanged and version 1. The SQL guard is
    // still what detected the conflict (verified to FAIL when the
    // `AND version = ?` clause is removed). A genuine concurrent writer on a
    // separate connection/transaction would of course still land its own bump.
    const current = adapter.getWorkItemById(item.id);
    expect(current?.title).toBe('raced item');
    expect(current?.version).toBe(1);
  });
});
