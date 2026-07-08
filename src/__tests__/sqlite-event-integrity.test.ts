import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { foldTemporalState, normalizeReplayedTemporalState } from '../core/temporal.js';
import type { ActorRef } from '../contracts/coordination.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { NewKnowledgeMemory } from '../contracts/types.js';
import { makeScope } from './test-helpers.js';

type Adapter = ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

function actor(actorId: string): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: actorId,
    system_id: 'assistant',
    display_name: actorId,
    metadata: null,
  };
}

function newKnowledge(fact: string, s: MemoryScope): NewKnowledgeMemory {
  return { ...s, fact, fact_type: 'preference', source: 'manual', confidence: 'high' };
}

/**
 * Fault-inject a throw the next time the memory_event_log INSERT is prepared,
 * on the shared better-sqlite3 prototype. All event emission funnels through
 * `INSERT INTO memory_event_log`, so this simulates an event-insert failure
 * mid-primitive. Returns a restore function.
 */
function injectEventInsertFailure(): () => void {
  const proto = Database.prototype as unknown as {
    prepare: (this: Database.Database, sql: string) => Database.Statement;
  };
  const originalPrepare = proto.prepare;
  let fired = false;
  proto.prepare = function patchedPrepare(this: Database.Database, sql: string) {
    if (!fired && /INSERT INTO memory_event_log/.test(sql)) {
      fired = true;
      throw new Error('injected event-insert failure');
    }
    return originalPrepare.call(this, sql);
  };
  return () => {
    proto.prepare = originalPrepare;
  };
}

describe('SQLite Phase 2 event integrity', () => {
  let adapter: Adapter;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  // ---- 2.3 cursor: ORDER BY event_id alone ----
  describe('2.3 event pagination cursor', () => {
    it('pages by event_id even when created_at is backdated (no skips/repeats)', () => {
      const s = makeScope();
      // D4: seed the EVENT LOG DIRECTLY via insertMemoryEvent with explicit
      // backdated created_at. Domain inserts (insertKnowledgeMemory) DROP the
      // caller-supplied created_at on their emitted event (createdAt =
      // nowSeconds() at sqlite/index.ts:924) — so seeding through them stamps all
      // events with the same real clock and makes a created_at-ordering bug
      // invisible. insertMemoryEvent honors created_at, so we can make timestamp
      // order the strict REVERSE of event_id (insertion) order.
      const seed = (fact: string, createdAt: number) =>
        adapter.insertMemoryEvent({
          ...s,
          entity_kind: 'knowledge_memory',
          entity_id: fact,
          event_type: 'knowledge.created',
          payload: { after: { fact } },
          created_at: createdAt,
        });
      // DECREASING created_at: event_id 1 is the newest, event_id 3 the oldest.
      seed('a', 1_700_000_300);
      seed('b', 1_700_000_200);
      seed('c', 1_700_000_100);

      // The setup is only meaningful if created_at is genuinely non-monotonic
      // w.r.t. event_id — assert it before relying on it.
      const all = adapter.listMemoryEvents(s, { limit: 100 }).events;
      expect(all.map((e) => e.event_id)).toEqual(['1', '2', '3']);
      expect(all.map((e) => e.created_at)).toEqual([1_700_000_300, 1_700_000_200, 1_700_000_100]);

      // event_id ordering: page 1 = [1,2], page 2 = [3]. If the query reverted to
      // `ORDER BY created_at, event_id` (with an `event_id > cursor` filter), page
      // 1 would be the two OLDEST timestamps = event_ids [3,2], and page 2
      // (event_id > 2) would REPEAT event 3 and SKIP event 1. The exact-equality
      // assertions below fail under that reversion.
      const first = adapter.listMemoryEvents(s, { limit: 2 });
      expect(first.events.map((e) => e.event_id)).toEqual(['1', '2']);
      expect(first.nextCursor).toBe('2');

      const second = adapter.listMemoryEvents(s, { limit: 2, cursor: first.nextCursor! });
      expect(second.events.map((e) => e.event_id)).toEqual(['3']);
      expect(second.nextCursor).toBeNull();
    });

    it('folds temporal state in event_id order regardless of created_at', () => {
      const s = makeScope();
      const k = adapter.insertKnowledgeMemory({
        ...newKnowledge('v0', s),
        created_at: 1_700_000_500,
      });
      // A later update carrying an EARLIER created_at must still win the fold
      // because it has the higher event_id.
      adapter.updateKnowledgeMemory(k.id, { trust_score: 0.9 });
      const events = adapter.listMemoryEvents(s, { limit: 100 }).events;
      const folded = foldTemporalState(events);
      expect(folded.knowledge.find((item) => item.id === k.id)?.trust_score).toBe(0.9);
    });
  });

  // ---- 2.1 atomic mutation+event: fault injection rolls back the row ----
  describe('2.1 atomic mutation + event', () => {
    it('rolls back insertKnowledgeMemory when the event insert throws', () => {
      const s = makeScope();
      const before = adapter.getActiveKnowledgeMemory(s).length;
      const restore = injectEventInsertFailure();
      try {
        expect(() => adapter.insertKnowledgeMemory(newKnowledge('orphan?', s))).toThrow(
          /injected event-insert failure/,
        );
      } finally {
        restore();
      }
      // No orphaned row, no orphaned event.
      expect(adapter.getActiveKnowledgeMemory(s).length).toBe(before);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(0);
    });

    it('rolls back insertWorkItem when the event insert throws', () => {
      const s = makeScope();
      const before = adapter.getActiveWorkItems(s).length;
      const restore = injectEventInsertFailure();
      try {
        expect(() =>
          adapter.insertWorkItem({ ...s, kind: 'objective', title: 'orphan?' }),
        ).toThrow(/injected event-insert failure/);
      } finally {
        restore();
      }
      expect(adapter.getActiveWorkItems(s).length).toBe(before);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(0);
    });

    it('rolls back insertTurn when the event insert throws', () => {
      const s = makeScope();
      const restore = injectEventInsertFailure();
      try {
        expect(() =>
          adapter.insertTurn({
            ...s,
            session_id: 'sess-1',
            actor: 'user-1',
            role: 'user',
            content: 'orphan?',
            token_estimate: 10,
          }),
        ).toThrow(/injected event-insert failure/);
      } finally {
        restore();
      }
      expect(adapter.getActiveTurns(s, 'sess-1').length).toBe(0);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(0);
    });

    it('rolls back updateKnowledgeMemory when the event insert throws', () => {
      const s = makeScope();
      const k = adapter.insertKnowledgeMemory(newKnowledge('stable', s));
      const eventsBefore = adapter.listMemoryEvents(s, { limit: 1000 }).events.length;
      const restore = injectEventInsertFailure();
      try {
        expect(() => adapter.updateKnowledgeMemory(k.id, { trust_score: 0.99 })).toThrow(
          /injected event-insert failure/,
        );
      } finally {
        restore();
      }
      // The row update rolled back with its failed event: trust_score unchanged,
      // no new event.
      expect(adapter.getKnowledgeMemoryById(k.id)?.trust_score).toBe(k.trust_score);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(eventsBefore);
    });

    // ---- item 7: atomic() nests via SAVEPOINT (native better-sqlite3) ----
    it('nests via savepoint so a CAUGHT inner primitive failure rolls back only that primitive', () => {
      const s = makeScope();
      let caught = false;
      // A composition where one inner primitive fails and the caller SWALLOWS the
      // error. With the prior "reuse the ambient frame, no savepoint" form the
      // failed primitive's partial writes would be stranded in the ambient
      // transaction. With native nested savepoints only that primitive rolls back
      // while the surrounding writes commit.
      adapter.transaction(() => {
        adapter.insertKnowledgeMemory(newKnowledge('keep-1', s));
        const restore = injectEventInsertFailure();
        try {
          adapter.insertKnowledgeMemory(newKnowledge('rolled-back', s));
        } catch {
          caught = true;
        } finally {
          restore();
        }
        adapter.insertKnowledgeMemory(newKnowledge('keep-2', s));
      });
      expect(caught).toBe(true);
      // Only the failed primitive was undone; its siblings committed.
      const facts = adapter.getActiveKnowledgeMemory(s).map((k) => k.fact).sort();
      expect(facts).toEqual(['keep-1', 'keep-2']);
      // No stranded event for the rolled-back primitive.
      const created = adapter
        .listMemoryEvents(s, { entityKind: 'knowledge_memory', limit: 1000 })
        .events.filter((e) => e.event_type === 'knowledge.created');
      expect(created).toHaveLength(2);
    });
  });

  // ---- 2.2 promotion atomicity + candidate/source/governance events ----
  describe('2.2 promotion atomicity and event coverage', () => {
    function insertCandidate(s: MemoryScope, fact: string) {
      const wm = adapter.insertWorkingMemory({
        ...s,
        session_id: 'sess-1',
        summary: 'wm',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 1,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      return adapter.insertKnowledgeCandidate({
        ...s,
        working_memory_id: wm.id,
        fact,
        fact_type: 'preference',
        knowledge_class: 'preference',
        normalized_fact: fact,
        confidence: 'high',
      });
    }

    it('promoteKnowledgeCandidate flips candidate + inserts knowledge + emits both events', () => {
      const s = makeScope();
      const candidate = insertCandidate(s, 'user likes dark mode');
      const knowledge = adapter.promoteKnowledgeCandidate(
        candidate.id,
        newKnowledge('user likes dark mode', s),
      );
      const after = adapter.getKnowledgeCandidateById(candidate.id);
      expect(after?.state).toBe('provisional');
      expect(after?.promoted_knowledge_id).toBe(knowledge.id);

      const types = adapter.listMemoryEvents(s, { limit: 100 }).events.map((e) => e.event_type);
      expect(types).toContain('knowledge_candidate.created');
      expect(types).toContain('knowledge.created');
      expect(types).toContain('knowledge_candidate.promoted');
    });

    it('crash-between (event insert throws) leaves no partial promotion state', () => {
      const s = makeScope();
      const candidate = insertCandidate(s, 'x');
      const knowledgeBefore = adapter.getActiveKnowledgeMemory(s).length;
      const eventsBefore = adapter.listMemoryEvents(s, { limit: 1000 }).events.length;

      // Fail the knowledge.created event insert mid-promotion. The whole
      // transaction (knowledge row + candidate flip + events) must roll back.
      const restore = injectEventInsertFailure();
      try {
        expect(() =>
          adapter.promoteKnowledgeCandidate(candidate.id, newKnowledge('x', s)),
        ).toThrow(/injected event-insert failure/);
      } finally {
        restore();
      }

      const candidateAfter = adapter.getKnowledgeCandidateById(candidate.id);
      expect(candidateAfter?.state).toBe('candidate');
      expect(candidateAfter?.promoted_knowledge_id).toBeNull();
      expect(adapter.getActiveKnowledgeMemory(s).length).toBe(knowledgeBefore);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(eventsBefore);
    });

    it('validation failure on promotion leaves no partial state', () => {
      const s = makeScope();
      const candidate = insertCandidate(s, 'y');
      const knowledgeBefore = adapter.getActiveKnowledgeMemory(s).length;
      const eventsBefore = adapter.listMemoryEvents(s, { limit: 1000 }).events.length;
      // Empty fact fails validateNewKnowledgeMemory after the candidate would flip.
      expect(() =>
        adapter.promoteKnowledgeCandidate(candidate.id, newKnowledge('', s)),
      ).toThrow();
      const candidateAfter = adapter.getKnowledgeCandidateById(candidate.id);
      expect(candidateAfter?.state).toBe('candidate');
      expect(candidateAfter?.promoted_knowledge_id).toBeNull();
      expect(adapter.getActiveKnowledgeMemory(s).length).toBe(knowledgeBefore);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(eventsBefore);
    });

    it('emits knowledge_candidate.expired on deleteExpiredKnowledgeCandidates', () => {
      const s = makeScope();
      const candidate = insertCandidate(s, 'stale');
      const expired = adapter.deleteExpiredKnowledgeCandidates(s, candidate.created_at + 1);
      expect(expired).toEqual([candidate.id]);
      const types = adapter.listMemoryEvents(s, { limit: 100 }).events.map((e) => e.event_type);
      expect(types).toContain('knowledge_candidate.expired');
    });

    it('emits governance events and round-trips governance state', () => {
      const s = makeScope();
      adapter.upsertDefaultContextContract!(s, { tokenBudget: 1000 });
      adapter.upsertNamedContextContract!(s, 'strict', { minimumTrustScore: 0.9 });
      adapter.deleteNamedContextContract!(s, 'strict');
      adapter.upsertContextInvariant!(s, { id: 'inv1', title: 'T', instruction: 'do X' });
      adapter.deleteContextInvariant!(s, 'inv1');
      adapter.upsertContextEscalationPolicy!(s, { defaultDecision: 'review' });

      const types = adapter.listMemoryEvents(s, { limit: 100 }).events.map((e) => e.event_type);
      expect(types).toEqual(
        expect.arrayContaining([
          'context_contract.set',
          'context_contract.deleted',
          'context_invariant.set',
          'context_invariant.deleted',
          'context_escalation_policy.set',
        ]),
      );
      const gov = adapter.getGovernanceState!(s);
      expect(gov?.escalationPolicy).toEqual({ defaultDecision: 'review' });
      expect(gov?.deletedContractNames).toContain('strict');
      expect(gov?.deletedInvariantIds).toContain('inv1');
    });

    it('emits source-document create/update events', () => {
      const s = makeScope();
      const doc = adapter.insertSourceDocument({ ...s, title: 'Doc', content_hash: 'h1' });
      adapter.updateSourceDocument(doc.id, { status: 'processed', fact_count: 3 });
      const types = adapter.listMemoryEvents(s, { limit: 100 }).events.map((e) => e.event_type);
      expect(types).toContain('source_document.created');
      expect(types).toContain('source_document.updated');
    });
  });

  // ---- AC: replay-equivalence mini-check against the SQLite adapter ----
  describe('replay equivalence', () => {
    it('folded state at cutoff equals a live snapshot at that time', () => {
      const s = makeScope();
      const asOf = 1_700_000_000;
      // Pin wall-clock time to asOf so the live effective-status read and the
      // replay normalization both evaluate lease expiry at the same instant.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(asOf * 1000));
      try {

      const wi = adapter.insertWorkItem({ ...s, kind: 'objective', title: 'ship feature' });
      adapter.claimWorkItem({
        ...s,
        work_item_id: wi.id,
        actor: actor('agent-1'),
        lease_seconds: 10_000,
        visibility_class: 'private',
        claimed_at: asOf,
      });
      const wm = adapter.insertWorkingMemory({
        ...s,
        session_id: 'sess-1',
        summary: 'wm',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 1,
        turn_id_end: 1,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      const candidate = adapter.insertKnowledgeCandidate({
        ...s,
        working_memory_id: wm.id,
        fact: 'prefers TS',
        fact_type: 'preference',
        knowledge_class: 'preference',
        normalized_fact: 'prefers ts',
        confidence: 'high',
      });
      adapter.promoteKnowledgeCandidate(candidate.id, newKnowledge('prefers TS', s));
      adapter.upsertContextInvariant!(s, { id: 'inv1', title: 'T', instruction: 'always cite' });
      const k2 = adapter.insertKnowledgeMemory(newKnowledge('uses vitest', s));
      adapter.updateKnowledgeMemory(k2.id, { trust_score: 0.75 });

      const cutoffEvents = adapter.listMemoryEvents(s, { limit: 1000 }).events;

      const liveKnowledge = adapter
        .getActiveKnowledgeMemory(s)
        .map((k) => ({ id: k.id, fact: k.fact, trust_score: k.trust_score }))
        .sort((a, b) => a.id - b.id);
      const liveWorkItems = adapter
        .getActiveWorkItems(s)
        .map((w) => ({ id: w.id, title: w.title, status: w.status }))
        .sort((a, b) => a.id - b.id);
      const liveClaims = adapter
        .listWorkClaims(s, { includeExpired: true })
        .map((c) => ({ id: c.id, status: c.status }))
        .sort((a, b) => a.id - b.id);

      const folded = normalizeReplayedTemporalState(foldTemporalState(cutoffEvents), asOf);
      const replayKnowledge = folded.knowledge
        .filter((k) => k.superseded_by_id === null && k.retired_at === null)
        .map((k) => ({ id: k.id, fact: k.fact, trust_score: k.trust_score }))
        .sort((a, b) => a.id - b.id);
      const replayWorkItems = folded.workItems
        .filter((w) => w.status !== 'done')
        .map((w) => ({ id: w.id, title: w.title, status: w.status }))
        .sort((a, b) => a.id - b.id);
      const replayClaims = folded.workClaims
        .map((c) => ({ id: c.id, status: c.status }))
        .sort((a, b) => a.id - b.id);

      expect(replayKnowledge).toEqual(liveKnowledge);
      expect(replayWorkItems).toEqual(liveWorkItems);
      expect(replayClaims).toEqual(liveClaims);

      // Governance is explicitly outside temporal replay (audit-only).
      expect((folded as Record<string, unknown>).invariants).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('fold tolerates audit-only event kinds (forward compatibility)', () => {
      const s = makeScope();
      adapter.insertSourceDocument({ ...s, title: 'Doc', content_hash: 'h1' });
      adapter.upsertContextEscalationPolicy!(s, { defaultDecision: 'allow' });
      const events = adapter.listMemoryEvents(s, { limit: 100 }).events;
      const folded = foldTemporalState(events);
      expect(folded.knowledge).toHaveLength(0);
      expect(folded.workItems).toHaveLength(0);
    });
  });
});
