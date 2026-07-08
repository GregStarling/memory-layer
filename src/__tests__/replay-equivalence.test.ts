/**
 * Release-gating replay-equivalence PROPERTY test (plan 5.3, scoped to 4.3.0).
 *
 * A seeded, deterministic sequence of ~80 mixed mutations is applied to each
 * adapter [in-memory, SQLite, Postgres-gated]. At several checkpoints T_i the
 * live read-API state is snapshotted; mutation then continues. At the end, for
 * every checkpoint, the event log is folded up to that checkpoint's event_id
 * watermark and normalized to T_i's `asOf`, and the folded (replayed) state is
 * asserted equal to the live snapshot for every replayable entity kind.
 *
 * Determinism (AC): all randomness comes from the seeded `makeRng`; all time
 * comes from a counter driven into a faked `Date` (`vi.useFakeTimers`). No
 * `Date.now()` / `Math.random()` is read un-seeded, so two consecutive runs are
 * byte-identical. Every adapter (including pg) derives timestamps and lease
 * expiry from the JS `nowSeconds()` helper, which reads the faked `Date`, so a
 * single faked clock aligns live effective-status with replay normalization on
 * all three adapters.
 *
 * The pg case runs only when POSTGRES_TEST_URL is set; otherwise it is omitted
 * from `describe.each` and collects as skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActorRef } from '../contracts/coordination.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { MemoryEventRecord } from '../contracts/temporal.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { NewKnowledgeMemory } from '../contracts/types.js';
import { compareTemporalIds } from '../contracts/temporal.js';
import { foldTemporalState, normalizeReplayedTemporalState } from '../core/temporal.js';
import { createMemoryManager } from '../core/manager.js';
import { harnessCases, isSkipped, makeRng, verifyScope, type HarnessAdapter } from './helpers/verification-harness.js';

const START = 1_700_000_000;
const OP_COUNT = 80;
const CHECKPOINTS = [20, 38, 55, 70] as const;

function actor(idx: number): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: `agent-${idx}`,
    system_id: 'verify-system',
    display_name: `agent-${idx}`,
    metadata: null,
  };
}

function newKnowledge(fact: string, s: MemoryScope): NewKnowledgeMemory {
  return { ...s, fact, fact_type: 'preference', source: 'manual', confidence: 'high' };
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
  turns: number[];
  knowledge: Array<{ id: number; fact: string; trust_score: number; knowledge_state: string }>;
  workItems: Array<{ id: number; title: string; status: string }>;
  claims: Array<{ id: number; work_item_id: number; status: string }>;
  associations: number[];
  // Playbooks carry revision_count so D1 (playbook-revision replay divergence)
  // is covered: a revision must bump the replayed count via a playbook.updated
  // after-snapshot, not only the audit-only playbook.revised event.
  playbooks: Array<{ id: number; title: string; status: string; revision_count: number }>;
  handoffs: Array<{ id: number; work_item_id: number; status: string }>;
  workingMemory: number[];
  sessionState: { currentObjective: string | null } | null;
}

const byId = <T extends { id: number }>(a: T, b: T): number => a.id - b.id;

/** Live projection via the adapter's read API at the current clock. */
async function liveProjection(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  sessionId: string,
): Promise<Projections> {
  const turns = (await adapter.getActiveTurns(scope)).map((t) => t.id).sort((a, b) => a - b);
  const knowledge = (await adapter.getActiveKnowledgeMemory(scope))
    .map((k) => ({
      id: k.id,
      fact: k.fact,
      trust_score: k.trust_score,
      knowledge_state: k.knowledge_state,
    }))
    .sort(byId);
  const workItems = (await adapter.getActiveWorkItems(scope))
    .map((w) => ({ id: w.id, title: w.title, status: w.status }))
    .sort(byId);
  const claims = (await adapter.listWorkClaims(scope, { includeExpired: true, includeReleased: true }))
    .map((c) => ({ id: c.id, work_item_id: c.work_item_id, status: c.status }))
    .sort(byId);
  const associations = (await adapter.listAssociations(scope)).map((a) => a.id).sort((a, b) => a - b);
  const playbooks = (await adapter.getActivePlaybooks(scope))
    .map((p) => ({ id: p.id, title: p.title, status: p.status, revision_count: p.revision_count }))
    .sort(byId);
  const handoffs = (await adapter.listHandoffs(scope))
    .map((h) => ({ id: h.id, work_item_id: h.work_item_id, status: h.status }))
    .sort(byId);
  const workingMemory = (await adapter.getActiveWorkingMemory(scope))
    .map((w) => w.id)
    .sort((a, b) => a - b);
  const sessionRow = await adapter.getSessionState(scope, sessionId);
  const sessionState = sessionRow ? { currentObjective: sessionRow.currentObjective } : null;
  return { turns, knowledge, workItems, claims, associations, playbooks, handoffs, workingMemory, sessionState };
}

/**
 * Replayed projection: fold the events up to `watermark`, normalize to `asOf`,
 * then apply the SAME active-status filters the live read API applies.
 */
function replayProjection(
  events: MemoryEventRecord[],
  watermark: string,
  asOf: number,
  sessionId: string,
): Projections {
  const upTo = events.filter((e) => compareTemporalIds(e.event_id, watermark) <= 0);
  const folded = normalizeReplayedTemporalState(foldTemporalState(upTo), asOf);
  const turns = folded.turns
    .filter((t) => t.archived_at === null)
    .map((t) => t.id)
    .sort((a, b) => a - b);
  const knowledge = folded.knowledge
    .filter((k) => k.superseded_by_id === null && k.retired_at === null)
    .map((k) => ({
      id: k.id,
      fact: k.fact,
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
  const associations = folded.associations.map((a) => a.id).sort((a, b) => a - b);
  const playbooks = folded.playbooks
    .filter((p) => p.status === 'draft' || p.status === 'active')
    .map((p) => ({ id: p.id, title: p.title, status: p.status, revision_count: p.revision_count }))
    .sort(byId);
  const handoffs = folded.handoffs
    .map((h) => ({ id: h.id, work_item_id: h.work_item_id, status: h.status }))
    .sort(byId);
  const workingMemory = folded.workingMemory
    .filter((w) => w.expires_at == null || w.expires_at > asOf)
    .map((w) => w.id)
    .sort((a, b) => a - b);
  const sessionRow = folded.sessionStates.find((sess) => sess.session_id === sessionId);
  const sessionState = sessionRow ? { currentObjective: sessionRow.currentObjective } : null;
  return { turns, knowledge, workItems, claims, associations, playbooks, handoffs, workingMemory, sessionState };
}

interface Snapshot {
  index: number;
  asOf: number;
  watermark: string;
  live: Projections;
}

describe.each(harnessCases())('replay equivalence [%s]', (name, factory) => {
  const skipped = isSkipped(name);
  const maybeIt = skipped ? it.skip : it;
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

  maybeIt('folded state at each checkpoint equals the live snapshot taken there', async () => {
    const rng = makeRng(0x5eed_1234);
    const scope = verifyScope();
    const sessionId = 'sess-1';
    const supportsGovernance = typeof adapter.upsertContextInvariant === 'function';

    // Local registries of live entity ids the generator picks targets from.
    const knowledgeIds: number[] = [];
    const workItemIds: number[] = [];
    const playbookIds: number[] = [];
    const associationIds: number[] = [];
    const sourceDocIds: number[] = [];
    const handoffIds: number[] = [];
    const wmIds: number[] = [];
    // Active claims we believe are live: item -> {claimId, actorIdx, expiresAt}.
    const activeClaims = new Map<
      number,
      { claimId: number; actorIdx: number; expiresAt: number }
    >();

    // A real working-memory row so compaction-log / candidate FKs resolve on
    // relational adapters.
    const wm = await adapter.insertWorkingMemory({
      ...scope,
      session_id: sessionId,
      summary: 'seed',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 0,
      turn_id_end: 0,
      turn_count: 0,
      compaction_trigger: 'manual',
    });

    let clock = START;
    let compactionCounter = 0;
    const snapshots: Snapshot[] = [];

    const advance = (): number => {
      clock += 1 + rng.int(3); // 1..3s
      vi.setSystemTime(clock * 1000);
      return clock;
    };

    const takeCheckpoint = async (index: number): Promise<void> => {
      vi.setSystemTime(clock * 1000);
      const events = await drainAllEvents(adapter, scope);
      const watermark = events.length > 0 ? events[events.length - 1].event_id : '0';
      const live = await liveProjection(adapter, scope, sessionId);
      snapshots.push({ index, asOf: clock, watermark, live });
    };

    for (let step = 0; step < OP_COUNT; step++) {
      advance();
      // Weighted menu keyed off a roll; each branch is a no-op when it has no
      // valid target so the sequence stays deterministic and valid.
      const roll = rng.int(100);

      if (roll < 12) {
        // insert knowledge
        const k = await adapter.insertKnowledgeMemory(newKnowledge(`fact-${step}`, scope));
        knowledgeIds.push(k.id);
      } else if (roll < 20) {
        // update knowledge trust
        if (knowledgeIds.length > 0) {
          const id = rng.pick(knowledgeIds);
          await adapter.updateKnowledgeMemory(id, {
            trust_score: Number((rng.next()).toFixed(4)),
          });
        }
      } else if (roll < 25) {
        // touch knowledge
        if (knowledgeIds.length > 0) await adapter.touchKnowledgeMemory(rng.pick(knowledgeIds));
      } else if (roll < 30) {
        // retire knowledge
        if (knowledgeIds.length > 0) {
          const idx = rng.int(knowledgeIds.length);
          const id = knowledgeIds[idx];
          await adapter.retireKnowledgeMemory(id);
          knowledgeIds.splice(idx, 1);
        }
      } else if (roll < 35) {
        // supersede: insert new, supersede old by new
        if (knowledgeIds.length > 0) {
          const idx = rng.int(knowledgeIds.length);
          const oldId = knowledgeIds[idx];
          const fresh = await adapter.insertKnowledgeMemory(newKnowledge(`super-${step}`, scope));
          await adapter.supersedeKnowledgeMemory(oldId, fresh.id);
          knowledgeIds.splice(idx, 1);
          knowledgeIds.push(fresh.id);
        }
      } else if (roll < 43) {
        // candidate -> promote
        const candidate = await adapter.insertKnowledgeCandidate({
          ...scope,
          working_memory_id: wm.id,
          fact: `cand-${step}`,
          fact_type: 'preference',
          knowledge_class: 'preference',
          normalized_fact: `cand-${step}`,
          confidence: 'high',
        });
        const promoted = await adapter.promoteKnowledgeCandidate(
          candidate.id,
          newKnowledge(`cand-${step}`, scope),
        );
        knowledgeIds.push(promoted.id);
      } else if (roll < 53) {
        // insert work item
        const item = await adapter.insertWorkItem({
          ...scope,
          kind: 'objective',
          title: `item-${step}`,
        });
        workItemIds.push(item.id);
      } else if (roll < 58) {
        // change work item status (never 'done' so it stays active/claimable)
        if (workItemIds.length > 0) {
          const id = rng.pick(workItemIds);
          await adapter.updateWorkItemStatus(id, rng.pick(['open', 'in_progress', 'blocked']));
        }
      } else if (roll < 68) {
        // claim a work item that has no live claim
        const claimable = workItemIds.filter((id) => {
          const c = activeClaims.get(id);
          return !c || clock > c.expiresAt;
        });
        if (claimable.length > 0) {
          const itemId = rng.pick(claimable);
          const actorIdx = rng.int(2);
          const lease = 2 + rng.int(5); // 2..6s
          const claim = await adapter.claimWorkItem({
            ...scope,
            work_item_id: itemId,
            actor: actor(actorIdx),
            lease_seconds: lease,
            visibility_class: 'private',
          });
          activeClaims.set(itemId, { claimId: claim.id, actorIdx, expiresAt: clock + lease });
        }
      } else if (roll < 73) {
        // renew a live claim with its owning actor
        const live = [...activeClaims.entries()].filter(([, c]) => clock <= c.expiresAt);
        if (live.length > 0) {
          const [itemId, c] = live[rng.int(live.length)];
          const lease = 2 + rng.int(5);
          const renewed = await adapter.renewWorkClaim(c.claimId, actor(c.actorIdx), lease);
          if (renewed) activeClaims.set(itemId, { ...c, expiresAt: clock + lease });
          else activeClaims.delete(itemId);
        }
      } else if (roll < 78) {
        // release a live claim with its owning actor
        const live = [...activeClaims.entries()].filter(([, c]) => clock <= c.expiresAt);
        if (live.length > 0) {
          const [itemId, c] = live[rng.int(live.length)];
          await adapter.releaseWorkClaim(c.claimId, actor(c.actorIdx), 'done');
          activeClaims.delete(itemId);
        }
      } else if (roll < 82) {
        // reaper: durably expire stale claims
        await adapter.expireStaleClaims(scope, clock);
        for (const [itemId, c] of [...activeClaims.entries()]) {
          if (clock >= c.expiresAt) activeClaims.delete(itemId);
        }
      } else if (roll < 88) {
        // insert playbook
        const pb = await adapter.insertPlaybook({
          ...scope,
          title: `pb-${step}`,
          description: 'd',
          instructions: 'do things',
        });
        playbookIds.push(pb.id);
      } else if (roll < 91) {
        // update / use / revise playbook
        if (playbookIds.length > 0) {
          const id = rng.pick(playbookIds);
          const which = rng.int(3);
          if (which === 0) await adapter.updatePlaybook(id, { title: `pb-${step}-upd` });
          else if (which === 1) await adapter.recordPlaybookUse(id);
          else
            await adapter.insertPlaybookRevision({
              ...scope,
              playbook_id: id,
              instructions: `rev-${step}`,
              revision_reason: 'refine',
            });
        }
      } else if (roll < 95) {
        // association create/delete between two knowledge rows
        if (roll % 2 === 0 && knowledgeIds.length >= 2) {
          const a = rng.pick(knowledgeIds);
          let b = rng.pick(knowledgeIds);
          if (b === a) b = knowledgeIds[(knowledgeIds.indexOf(a) + 1) % knowledgeIds.length];
          const assoc = await adapter.insertAssociation({
            ...scope,
            source_kind: 'knowledge',
            source_id: a,
            target_kind: 'knowledge',
            target_id: b,
            association_type: 'related_to',
          });
          associationIds.push(assoc.id);
        } else if (associationIds.length > 0) {
          const idx = rng.int(associationIds.length);
          await adapter.deleteAssociation(associationIds[idx]);
          associationIds.splice(idx, 1);
        }
      } else if (roll < 98) {
        // source document create/update (audit-only, not replayable)
        if (sourceDocIds.length === 0 || rng.int(2) === 0) {
          const doc = await adapter.insertSourceDocument({
            ...scope,
            title: `doc-${step}`,
            content_hash: `hash-${step}`,
          });
          sourceDocIds.push(doc.id);
        } else {
          await adapter.updateSourceDocument(rng.pick(sourceDocIds), {
            status: 'processed',
            fact_count: rng.int(5),
          });
        }
      } else {
        // governance (audit-only; skip gracefully on adapters that lack it)
        if (supportsGovernance) {
          await adapter.upsertContextInvariant!(scope, {
            id: `inv-${step}`,
            title: 'T',
            instruction: 'always cite',
          });
        } else {
          // keep the step meaningful on pg: a turn insert
          await adapter.insertTurn({
            ...scope,
            session_id: sessionId,
            actor: 'user',
            role: 'user',
            content: `t-${step}`,
          });
        }
      }

      // A couple of turns woven in so turn insert/archive is always exercised.
      if (step % 7 === 0) {
        const turn = await adapter.insertTurn({
          ...scope,
          session_id: sessionId,
          actor: 'user',
          role: 'user',
          content: `turn-${step}`,
        });
        if (step % 14 === 0) {
          const log = await adapter.insertCompactionLog({
            ...scope,
            session_id: sessionId,
            trigger_type: 'manual',
            turn_id_start: turn.id,
            turn_id_end: turn.id,
            turns_compacted: 1,
            tokens_compacted_estimate: 10,
            working_memory_id: wm.id,
            active_turn_count_before: 1,
            active_turn_count_after: 0,
            duration_ms: 1,
          });
          compactionCounter++;
          await adapter.archiveTurn(turn.id, clock, log.id);
        }
      }

      // Handoff lifecycle woven in (D5) so the handoffs projection is genuinely
      // exercised in replay rather than being a vacuous []===[]. Only
      // create/reject/cancel/expire are used: accept re-claims the work item,
      // which would perturb the claim subsystem this test also asserts on.
      if (step % 5 === 0 && workItemIds.length > 0) {
        const h = await adapter.createHandoff({
          ...scope,
          work_item_id: rng.pick(workItemIds),
          from_actor: actor(0),
          to_actor: actor(1),
          summary: `handoff-${step}`,
          expires_at: clock + 2 + rng.int(4), // 2..5s: some expire before checkpoints
          visibility_class: 'private',
        });
        handoffIds.push(h.id);
      } else if (step % 5 === 2 && handoffIds.length > 0) {
        const id = rng.pick(handoffIds);
        try {
          if (rng.int(2) === 0) await adapter.rejectHandoff(id, actor(1), 'no');
          else await adapter.cancelHandoff(id, actor(0), 'nvm');
        } catch {
          // Already resolved/expired — a ConflictError here is expected and the
          // stored state is unchanged; effective status still folds correctly.
        }
      } else if (step % 5 === 4) {
        // Reaper: durably expire stale (pending, past-expiry) handoffs.
        await adapter.expireStaleHandoffs(scope, clock);
      }

      const cp = CHECKPOINTS.indexOf(step as (typeof CHECKPOINTS)[number]);
      if (cp !== -1) await takeCheckpoint(cp);
    }

    // Sanity: handoffs really were created (the handoffs assertion is not vacuous).
    expect(handoffIds.length).toBeGreaterThan(0);

    // Sanity: we actually exercised the surface and took every checkpoint.
    expect(snapshots).toHaveLength(CHECKPOINTS.length);
    expect(compactionCounter).toBeGreaterThan(0);

    const allEvents = await drainAllEvents(adapter, scope);
    // Event log is strictly ascending, contiguous causal order (2.3).
    for (let i = 1; i < allEvents.length; i++) {
      expect(compareTemporalIds(allEvents[i].event_id, allEvents[i - 1].event_id)).toBe(1);
    }

    for (const snap of snapshots) {
      const replay = replayProjection(allEvents, snap.watermark, snap.asOf, sessionId);
      expect(replay.turns, `turns @cp${snap.index}`).toEqual(snap.live.turns);
      expect(replay.knowledge, `knowledge @cp${snap.index}`).toEqual(snap.live.knowledge);
      expect(replay.workItems, `workItems @cp${snap.index}`).toEqual(snap.live.workItems);
      expect(replay.claims, `claims @cp${snap.index}`).toEqual(snap.live.claims);
      expect(replay.associations, `associations @cp${snap.index}`).toEqual(snap.live.associations);
      expect(replay.playbooks, `playbooks @cp${snap.index}`).toEqual(snap.live.playbooks);
      expect(replay.handoffs, `handoffs @cp${snap.index}`).toEqual(snap.live.handoffs);
      expect(replay.workingMemory, `workingMemory @cp${snap.index}`).toEqual(snap.live.workingMemory);
      expect(replay.sessionState, `sessionState @cp${snap.index}`).toEqual(snap.live.sessionState);
    }

    // Audit-only kinds MUST NOT leak into replayable folded state (2.2 contract).
    const folded = foldTemporalState(allEvents);
    const foldedRecord = folded as unknown as Record<string, unknown>;
    expect(foldedRecord.sourceDocuments).toBeUndefined();
    expect(foldedRecord.invariants).toBeUndefined();
    expect(foldedRecord.governance).toBeUndefined();
  });

  // Finding 8: exercise manager.getStateAt (not just a raw watermark fold). This
  // covers the created_at selection window (getStateAt fetches events with
  // endAt: asOf, then folds by event_id) and the asOf-normalization of lease
  // status — neither of which a direct fold-to-a-watermark exercises.
  maybeIt('manager.getStateAt reconstructs historical state at distinct asOf points', async () => {
    const scope = verifyScope();
    const sessionId = 'sess-1';
    let clock = START;
    const tick = (secs: number): number => {
      clock += secs;
      vi.setSystemTime(clock * 1000);
      return clock;
    };

    // A cutover at START puts every asOf on the EXACT replay path.
    await adapter.upsertTemporalWatermark({
      projection_name: 'temporal',
      last_event_id: '0',
      cutover_at: START,
    });
    const manager = createMemoryManager({
      asyncAdapter: adapter,
      scope,
      sessionId,
      summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    });

    // State as of asOf1: k1 active, a work item claimed with a 5s lease.
    tick(1);
    const k1 = await adapter.insertKnowledgeMemory(newKnowledge('fact-1', scope));
    const w1 = await adapter.insertWorkItem({ ...scope, kind: 'objective', title: 'w1' });
    const claim = await adapter.claimWorkItem({
      ...scope,
      work_item_id: w1.id,
      actor: actor(0),
      lease_seconds: 5,
      visibility_class: 'private',
    });
    const asOf1 = clock;

    // Mutate past asOf1: retire k1, add k2, then advance well past the lease.
    tick(2);
    await adapter.retireKnowledgeMemory(k1.id);
    const k2 = await adapter.insertKnowledgeMemory(newKnowledge('fact-2', scope));
    tick(10);
    const asOf2 = clock;

    const activeKnowledgeIds = (st: {
      knowledge: Array<{ id: number; retired_at: number | null; superseded_by_id: number | null }>;
    }): number[] =>
      st.knowledge
        .filter((k) => k.retired_at === null && k.superseded_by_id === null)
        .map((k) => k.id)
        .sort((a, b) => a - b);

    const s1 = await manager.getStateAt(asOf1);
    expect(s1.exact).toBe(true);
    // Selection window: only events with created_at <= asOf1 are folded.
    expect(activeKnowledgeIds(s1)).toEqual([k1.id]);
    expect(s1.workClaims.find((c) => c.id === claim.id)?.status).toBe('active');

    const s2 = await manager.getStateAt(asOf2);
    expect(s2.exact).toBe(true);
    expect(activeKnowledgeIds(s2)).toEqual([k2.id]);
    // Lease normalization at asOf: the never-released claim reads expired at asOf2.
    expect(s2.workClaims.find((c) => c.id === claim.id)?.status).toBe('expired');

    await manager.close();
  });
});
