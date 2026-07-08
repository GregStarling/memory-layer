/**
 * Release-gating cursor conformance suite (plan 2.3, 5.3 scope).
 *
 * Event pagination MUST order by event_id ASC alone and page via an
 * `event_id > cursor` cursor. With `created_at` backdated out of insertion
 * order, a `(created_at, event_id)` ordering with an `event_id` cursor would
 * skip or repeat rows. This suite seeds the EVENT LOG DIRECTLY via
 * `insertMemoryEvent` with explicit, deliberately non-monotonic backdated
 * `created_at` (D4). insertMemoryEvent honors caller `created_at` on EVERY
 * adapter — unlike domain inserts (turns/knowledge), which drop caller
 * `created_at` on Postgres until Phase 3.5 and would make the backdating (and
 * thus this whole assertion) vacuous on pg. It then pages through the log at a
 * small limit on every adapter [in-memory, SQLite, Postgres-gated], and asserts:
 *   - the paged sequence exactly equals a single-shot ascending read
 *     (no skips, no repeats),
 *   - event_ids are strictly ascending and contiguous with no duplicates,
 *   - the terminal page reports nextCursor === null,
 *   - `created_at` really was non-monotonic (the test exercises backdating).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { MemoryEventRecord } from '../contracts/temporal.js';
import { compareTemporalIds } from '../contracts/temporal.js';
import { harnessCases, isSkipped, makeRng, verifyScope, type HarnessAdapter } from './helpers/verification-harness.js';

const START = 1_700_000_000;
const EVENT_COUNT = 24;

describe.each(harnessCases())('cursor conformance [%s]', (name, factory) => {
  const skipped = isSkipped(name);
  const maybeIt = skipped ? it.skip : it;
  let harness: HarnessAdapter;
  let adapter: AsyncStorageAdapter;

  beforeEach(async () => {
    if (skipped) return;
    harness = await factory();
    adapter = harness.adapter;
  });

  afterEach(async () => {
    if (skipped) return;
    await harness.close();
  });

  async function seedBackdatedEvents(scope: MemoryScope): Promise<number[]> {
    // A deterministic, deliberately non-monotonic created_at sequence.
    const rng = makeRng(0xc0ffee);
    const offsets = Array.from({ length: EVENT_COUNT }, (_, i) => i);
    for (let i = offsets.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
    }
    // D4: seed the EVENT LOG DIRECTLY. insertMemoryEvent honors caller
    // created_at on every adapter, so the backdating survives on Postgres too
    // (domain inserts drop it until Phase 3.5). Event ids remain the strictly
    // ascending append order (1..EVENT_COUNT) while created_at is shuffled, so
    // the pagination assertions genuinely fail if ORDER BY reverts to created_at.
    const kinds = [
      { entity_kind: 'knowledge_memory', event_type: 'knowledge.created' },
      { entity_kind: 'turn', event_type: 'turn.created' },
      { entity_kind: 'work_item', event_type: 'work_item.created' },
    ] as const;
    const createdAts: number[] = [];
    for (let i = 0; i < EVENT_COUNT; i++) {
      const createdAt = START + offsets[i] * 10;
      createdAts.push(createdAt);
      const kind = kinds[i % 3];
      await adapter.insertMemoryEvent({
        ...scope,
        entity_kind: kind.entity_kind,
        entity_id: String(i + 1),
        event_type: kind.event_type,
        payload: { after: { id: i + 1, seq: i } },
        created_at: createdAt,
      });
    }
    return createdAts;
  }

  maybeIt('pages by event_id with no skips or repeats despite backdated created_at', async () => {
    const scope = verifyScope();
    await seedBackdatedEvents(scope);

    // Ground truth: one big ascending read.
    const full = await adapter.listMemoryEvents(scope, { limit: 1000 });
    expect(full.nextCursor).toBeNull();
    const fullIds = full.events.map((e) => e.event_id);
    expect(fullIds).toHaveLength(EVENT_COUNT);

    // created_at must be genuinely out of event_id order (test is meaningful).
    const createdAtSeq = full.events.map((e) => e.created_at);
    const isMonotonic = createdAtSeq.every((v, i) => i === 0 || v >= createdAtSeq[i - 1]);
    expect(isMonotonic).toBe(false);

    // Paged read at a small limit.
    const pagedIds: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page: { events: MemoryEventRecord[]; nextCursor: string | null } =
        await adapter.listMemoryEvents(scope, { limit: 5, cursor });
      pages++;
      for (const e of page.events) {
        expect(seen.has(e.event_id), `repeat ${e.event_id}`).toBe(false);
        seen.add(e.event_id);
        if (pagedIds.length > 0) {
          // strictly ascending across the whole paged stream
          expect(compareTemporalIds(e.event_id, pagedIds[pagedIds.length - 1])).toBe(1);
        }
        pagedIds.push(e.event_id);
      }
      if (!page.nextCursor) break;
      // nextCursor must be the last event_id of the page (event_id > cursor).
      expect(page.nextCursor).toBe(page.events[page.events.length - 1].event_id);
      cursor = page.nextCursor;
    }

    // No skips, no repeats: paged stream === single-shot stream.
    expect(pagedIds).toEqual(fullIds);
    expect(seen.size).toBe(EVENT_COUNT);
    expect(pages).toBe(Math.ceil(EVENT_COUNT / 5));
  });

  maybeIt('resuming from an arbitrary cursor yields exactly the strictly-greater tail', async () => {
    const scope = verifyScope();
    await seedBackdatedEvents(scope);
    const full = (await adapter.listMemoryEvents(scope, { limit: 1000 })).events.map((e) => e.event_id);

    // Pick a mid cursor; the resumed read must be exactly the ids after it.
    const midIndex = 9;
    const midCursor = full[midIndex];
    const tail: string[] = [];
    let cursor: string | undefined = midCursor;
    for (;;) {
      const page = await adapter.listMemoryEvents(scope, { limit: 4, cursor });
      tail.push(...page.events.map((e) => e.event_id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(tail).toEqual(full.slice(midIndex + 1));
    // Cursor is exclusive: the cursor id itself never reappears.
    expect(tail.includes(midCursor)).toBe(false);
  });
});
