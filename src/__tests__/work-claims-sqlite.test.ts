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

    // The interleaved bump landed but the guarded write did not, so title is
    // unchanged and version reflects only the concurrent bump.
    const current = adapter.getWorkItemById(item.id);
    expect(current?.title).toBe('raced item');
    expect(current?.version).toBe(2);
  });
});
