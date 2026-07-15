/**
 * Phase 5 (5.3 / decision D6) — temporal replay-equivalence PROPERTY test,
 * parameterized over SQLite (always runs) and Postgres (gated on
 * POSTGRES_TEST_URL). The pg leg uses the ensurePgVectorExtension +
 * ephemeral-schema harness from verification-harness.ts; without the env var it
 * collects as SKIPPED with zero collection errors (standing lesson).
 *
 * What it proves: for a seeded, deterministic sequence of mixed mutations, the
 * event log folded up to a checkpoint's watermark and normalized to that
 * checkpoint's `asOf` reconstructs BYTE-IDENTICAL state to the live read-API
 * snapshot taken at that instant — at a mid-sequence checkpoint AND at the end.
 * Equivalence is asserted on knowledge / work-items / claims / playbooks.
 *
 * Op sequence covers (decision D6): knowledge inserts across MIXED visibility
 * classes, supersede, retire, work-item insert / status-update / claim /
 * release, and playbook insert / revise.
 *
 * Determinism: all randomness comes from the seeded `makeRng`; all time comes
 * from a counter driven into a faked `Date` (`vi.useFakeTimers({toFake:['Date']})`
 * so the pg driver's socket timers keep working). Every adapter derives
 * timestamps and lease expiry from `nowSeconds()`, which reads the faked clock,
 * so live read-time lease normalization and replay `asOf` normalization align on
 * both backends. Two fixed seeds; same seed ⇒ same sequence, byte-identical
 * across runs.
 *
 * This is intentionally distinct from `replay-equivalence.test.ts` (the Phase 2
 * 4.3.0 gate over [in-memory, sqlite, pg]): this file is the Phase 5 focused
 * knowledge/work/claim/playbook property test over the relational backends that
 * back production, with visibility-class mixing and two seeds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActorRef, MemoryVisibilityClass } from '../contracts/coordination.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryEventRecord } from '../contracts/temporal.js';
import type { NewKnowledgeMemory } from '../contracts/types.js';
import { compareTemporalIds } from '../contracts/temporal.js';
import { foldTemporalState, normalizeReplayedTemporalState } from '../core/temporal.js';
import {
  LOCAL_FACTORIES,
  isSkipped,
  makePostgresHarness,
  makeRng,
  verifyScope,
  type HarnessAdapter,
  type HarnessFactory,
} from './helpers/verification-harness.js';

const START = 1_700_000_000;
const OP_COUNT = 60;
// Two fixed literal seeds (D6: "two fixed seeds minimum"). Distinct seeds drive
// distinct-but-reproducible op sequences; each is byte-identical across runs.
const SEEDS = [0x5eed_a1ce, 0x5eed_b0b0] as const;
// Mixed visibility classes, cycled deterministically across knowledge inserts.
// 'private' | 'workspace' | 'tenant' are all valid against the base verifyScope
// (workspace_id defaults to 'default'); 'shared_collaboration' is intentionally
// omitted because it additionally requires a non-empty collaboration_id.
const VISIBILITY: readonly MemoryVisibilityClass[] = ['private', 'workspace', 'tenant'];

// Two checkpoints: one mid-sequence, one at the end (D6).
const MID_CHECKPOINT = 33;

function actor(idx: number): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: `agent-${idx}`,
    system_id: 'verify-system',
    display_name: `agent-${idx}`,
    metadata: null,
  };
}

function newKnowledge(
  fact: string,
  visibility: MemoryVisibilityClass,
  s: MemoryScope,
): NewKnowledgeMemory {
  return {
    ...s,
    fact,
    fact_type: 'preference',
    source: 'manual',
    confidence: 'high',
    visibility_class: visibility,
  };
}

/** Drain the full event log for `scope`, ascending by event_id. */
async function drainAllEvents(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
): Promise<MemoryEventRecord[]> {
  const all: MemoryEventRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await adapter.listMemoryEvents(scope, { limit: 500, cursor });
    all.push(...page.events);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

interface Projections {
  knowledge: Array<{
    id: number;
    fact: string;
    visibility_class: MemoryVisibilityClass;
    trust_score: number;
    knowledge_state: string;
  }>;
  workItems: Array<{ id: number; title: string; status: string }>;
  claims: Array<{ id: number; work_item_id: number; status: string }>;
  playbooks: Array<{ id: number; title: string; status: string; revision_count: number }>;
}

const byId = <T extends { id: number }>(a: T, b: T): number => a.id - b.id;

/** Live projection via the adapter's read API at the current (faked) clock. */
async function liveProjection(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
): Promise<Projections> {
  const knowledge = (await adapter.getActiveKnowledgeMemory(scope))
    .map((k) => ({
      id: k.id,
      fact: k.fact,
      visibility_class: k.visibility_class,
      trust_score: k.trust_score,
      knowledge_state: k.knowledge_state,
    }))
    .sort(byId);
  const workItems = (await adapter.getActiveWorkItems(scope))
    .map((w) => ({ id: w.id, title: w.title, status: w.status }))
    .sort(byId);
  const claims = (
    await adapter.listWorkClaims(scope, { includeExpired: true, includeReleased: true })
  )
    .map((c) => ({ id: c.id, work_item_id: c.work_item_id, status: c.status }))
    .sort(byId);
  const playbooks = (await adapter.getActivePlaybooks(scope))
    .map((p) => ({ id: p.id, title: p.title, status: p.status, revision_count: p.revision_count }))
    .sort(byId);
  return { knowledge, workItems, claims, playbooks };
}

/**
 * Replayed projection: fold events up to `watermark`, normalize lease/handoff
 * status to `asOf`, then apply the SAME active-status filters the live read API
 * applies. Canonical ordering per Phase 3: created_at ASC, id ASC — the fold
 * already sorts that way; we sort projections by id (monotonic with created_at
 * here) so live and replay compare deep-equal.
 */
function replayProjection(
  events: MemoryEventRecord[],
  watermark: string,
  asOf: number,
): Projections {
  const upTo = events.filter((e) => compareTemporalIds(e.event_id, watermark) <= 0);
  const folded = normalizeReplayedTemporalState(foldTemporalState(upTo), asOf);
  const knowledge = folded.knowledge
    .filter((k) => k.superseded_by_id === null && k.retired_at === null)
    .map((k) => ({
      id: k.id,
      fact: k.fact,
      visibility_class: k.visibility_class,
      trust_score: k.trust_score,
      knowledge_state: k.knowledge_state,
    }))
    .sort(byId);
  const workItems = folded.workItems
    .filter((w) => w.status !== 'done')
    .map((w) => ({ id: w.id, title: w.title, status: w.status }))
    .sort(byId);
  const claims = folded.workClaims
    .map((c) => ({ id: c.id, work_item_id: c.work_item_id, status: c.status }))
    .sort(byId);
  const playbooks = folded.playbooks
    .filter((p) => p.status === 'draft' || p.status === 'active')
    .map((p) => ({ id: p.id, title: p.title, status: p.status, revision_count: p.revision_count }))
    .sort(byId);
  return { knowledge, workItems, claims, playbooks };
}

interface Snapshot {
  label: string;
  asOf: number;
  watermark: string;
  live: Projections;
}

// Op counters, asserted > 0 so no branch is vacuous (the generator's no-op
// guards must not silently swallow an entire op kind for a given seed).
interface OpCounts {
  knowledgeInsert: number;
  retire: number;
  supersede: number;
  workItemInsert: number;
  statusUpdate: number;
  claim: number;
  release: number;
  playbookInsert: number;
  playbookRevise: number;
}

// SQLite always runs; Postgres is gated (skipped without POSTGRES_TEST_URL).
const EQUIVALENCE_CASES: Array<[string, HarnessFactory]> = [
  ['sqlite', LOCAL_FACTORIES[1]],
  ['postgres', makePostgresHarness],
];

describe.each(EQUIVALENCE_CASES)('temporal replay equivalence [%s]', (name, factory) => {
  const skipped = isSkipped(name);
  // When pg is gated (no POSTGRES_TEST_URL) the seeded cases register as SKIPPED
  // so the pg leg shows up in the report rather than silently vanishing.
  const maybeEach = skipped ? it.skip.each(SEEDS) : it.each(SEEDS);
  let harness: HarnessAdapter;
  let adapter: AsyncStorageAdapter;

  beforeEach(async () => {
    if (skipped) return;
    // Fake only Date so the pg driver's socket timers keep working, while every
    // adapter's nowSeconds()/lease math reads the controlled clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START * 1000);
    harness = await factory();
    adapter = harness.adapter;
  });

  afterEach(async () => {
    if (skipped) return;
    await harness.close();
    vi.useRealTimers();
  });

  maybeEach(
    'folded state equals the live snapshot at mid + end checkpoints (seed %#)',
    async (seed) => {
      const rng = makeRng(seed);
      const scope = verifyScope();

      // Live registries of ids the generator picks targets from.
      const knowledgeIds: number[] = [];
      const workItemIds: number[] = [];
      const playbookIds: number[] = [];
      // item_id -> live claim bookkeeping.
      const activeClaims = new Map<
        number,
        { claimId: number; actorIdx: number; expiresAt: number }
      >();

      const counts: OpCounts = {
        knowledgeInsert: 0,
        retire: 0,
        supersede: 0,
        workItemInsert: 0,
        statusUpdate: 0,
        claim: 0,
        release: 0,
        playbookInsert: 0,
        playbookRevise: 0,
      };

      let clock = START;
      let visibilityCursor = 0;
      const snapshots: Snapshot[] = [];

      const advance = (): number => {
        clock += 1 + rng.int(3); // 1..3s
        vi.setSystemTime(clock * 1000);
        return clock;
      };

      const takeCheckpoint = async (label: string): Promise<void> => {
        vi.setSystemTime(clock * 1000);
        const events = await drainAllEvents(adapter, scope);
        const watermark = events.length > 0 ? events[events.length - 1].event_id : '0';
        const live = await liveProjection(adapter, scope);
        snapshots.push({ label, asOf: clock, watermark, live });
      };

      for (let step = 0; step < OP_COUNT; step++) {
        advance();
        // Weighted menu; each branch is a valid no-op when it has no target so
        // the sequence stays deterministic and valid across both seeds.
        const roll = rng.int(100);

        if (roll < 20) {
          // insert knowledge with a cycled visibility class
          const visibility = VISIBILITY[visibilityCursor % VISIBILITY.length];
          visibilityCursor += 1;
          const k = await adapter.insertKnowledgeMemory(
            newKnowledge(`fact-${step}`, visibility, scope),
          );
          knowledgeIds.push(k.id);
          counts.knowledgeInsert += 1;
        } else if (roll < 30) {
          // retire a knowledge row
          if (knowledgeIds.length > 0) {
            const idx = rng.int(knowledgeIds.length);
            await adapter.retireKnowledgeMemory(knowledgeIds[idx]);
            knowledgeIds.splice(idx, 1);
            counts.retire += 1;
          }
        } else if (roll < 43) {
          // supersede: insert fresh (inherits a cycled visibility class), then
          // supersede an existing row by it
          if (knowledgeIds.length > 0) {
            const idx = rng.int(knowledgeIds.length);
            const oldId = knowledgeIds[idx];
            const visibility = VISIBILITY[visibilityCursor % VISIBILITY.length];
            visibilityCursor += 1;
            const fresh = await adapter.insertKnowledgeMemory(
              newKnowledge(`super-${step}`, visibility, scope),
            );
            await adapter.supersedeKnowledgeMemory(oldId, fresh.id);
            knowledgeIds.splice(idx, 1, fresh.id);
            counts.supersede += 1;
          }
        } else if (roll < 58) {
          // insert work item
          const item = await adapter.insertWorkItem({
            ...scope,
            kind: 'objective',
            title: `item-${step}`,
          });
          workItemIds.push(item.id);
          counts.workItemInsert += 1;
        } else if (roll < 65) {
          // change work item status (never 'done' so it stays active/claimable)
          if (workItemIds.length > 0) {
            const id = rng.pick(workItemIds);
            await adapter.updateWorkItemStatus(id, rng.pick(['open', 'in_progress', 'blocked']));
            counts.statusUpdate += 1;
          }
        } else if (roll < 78) {
          // claim a work item with no live claim
          const claimable = workItemIds.filter((id) => {
            const c = activeClaims.get(id);
            return !c || clock > c.expiresAt;
          });
          if (claimable.length > 0) {
            const itemId = rng.pick(claimable);
            const actorIdx = rng.int(2);
            // 10..24s: long enough that release ops reliably find a live claim,
            // short enough that some leases still lapse before a checkpoint so
            // the expired-status normalization path is exercised too.
            const lease = 10 + rng.int(15);
            const claim = await adapter.claimWorkItem({
              ...scope,
              work_item_id: itemId,
              actor: actor(actorIdx),
              lease_seconds: lease,
              visibility_class: 'private',
            });
            activeClaims.set(itemId, { claimId: claim.id, actorIdx, expiresAt: clock + lease });
            counts.claim += 1;
          }
        } else if (roll < 85) {
          // release a live claim with its owning actor
          const live = [...activeClaims.entries()].filter(([, c]) => clock <= c.expiresAt);
          if (live.length > 0) {
            const [itemId, c] = live[rng.int(live.length)];
            await adapter.releaseWorkClaim(c.claimId, actor(c.actorIdx), 'done');
            activeClaims.delete(itemId);
            counts.release += 1;
          }
        } else if (roll < 95) {
          // insert playbook
          const pb = await adapter.insertPlaybook({
            ...scope,
            title: `pb-${step}`,
            description: 'd',
            instructions: 'do things',
          });
          playbookIds.push(pb.id);
          counts.playbookInsert += 1;
        } else {
          // revise playbook (bumps revision_count via playbook.updated snapshot)
          if (playbookIds.length > 0) {
            const id = rng.pick(playbookIds);
            if (rng.int(2) === 0) {
              await adapter.updatePlaybook(id, { title: `pb-${step}-upd` });
            } else {
              await adapter.insertPlaybookRevision({
                ...scope,
                playbook_id: id,
                instructions: `rev-${step}`,
                revision_reason: 'refine',
              });
            }
            counts.playbookRevise += 1;
          }
        }

        if (step === MID_CHECKPOINT) await takeCheckpoint('mid');
      }

      await takeCheckpoint('end');

      // Every op kind actually fired for BOTH seeds — no vacuous branch.
      expect(counts.knowledgeInsert, 'knowledgeInsert').toBeGreaterThan(0);
      expect(counts.retire, 'retire').toBeGreaterThan(0);
      expect(counts.supersede, 'supersede').toBeGreaterThan(0);
      expect(counts.workItemInsert, 'workItemInsert').toBeGreaterThan(0);
      expect(counts.statusUpdate, 'statusUpdate').toBeGreaterThan(0);
      expect(counts.claim, 'claim').toBeGreaterThan(0);
      expect(counts.release, 'release').toBeGreaterThan(0);
      expect(counts.playbookInsert, 'playbookInsert').toBeGreaterThan(0);
      expect(counts.playbookRevise, 'playbookRevise').toBeGreaterThan(0);
      expect(snapshots.map((s) => s.label)).toEqual(['mid', 'end']);

      const allEvents = await drainAllEvents(adapter, scope);
      // Event log is strictly ascending causal order (2.3).
      for (let i = 1; i < allEvents.length; i++) {
        expect(compareTemporalIds(allEvents[i].event_id, allEvents[i - 1].event_id)).toBe(1);
      }

      for (const snap of snapshots) {
        const replay = replayProjection(allEvents, snap.watermark, snap.asOf);
        expect(replay.knowledge, `knowledge @${snap.label}`).toEqual(snap.live.knowledge);
        expect(replay.workItems, `workItems @${snap.label}`).toEqual(snap.live.workItems);
        expect(replay.claims, `claims @${snap.label}`).toEqual(snap.live.claims);
        expect(replay.playbooks, `playbooks @${snap.label}`).toEqual(snap.live.playbooks);
      }

      // Mixed visibility classes really were exercised (assertion is not vacuous).
      const endLive = snapshots[snapshots.length - 1].live;
      const distinctVisibilities = new Set(endLive.knowledge.map((k) => k.visibility_class));
      expect(distinctVisibilities.size).toBeGreaterThan(1);
    },
  );
});
