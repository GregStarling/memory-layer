import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createInMemoryAdapter,
  createInMemoryAdapterWithEmbeddings,
} from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { createMemoryManager } from '../core/manager.js';
import { runMaintenance } from '../core/maintenance.js';
import { foldTemporalState, normalizeReplayedTemporalState } from '../core/temporal.js';
import type { ActorRef } from '../contracts/coordination.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { NewKnowledgeMemory } from '../contracts/types.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return { tenant_id: 'acme', system_id: 'assistant', scope_id: 'thread-1', ...overrides };
}

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

const NOW = 1_700_000_000;

describe('Phase 2 foundations: in-memory adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    adapter = createInMemoryAdapter();
  });

  afterEach(() => {
    adapter.close();
    vi.useRealTimers();
  });

  // ---- 2.3 event ordering by event_id alone ----
  describe('2.3 event ordering', () => {
    it('paginates by event_id even when created_at is backdated', () => {
      const s = scope();
      // Insert three knowledge rows with DECREASING created_at (backdated),
      // so created_at order is the reverse of insertion (event_id) order.
      adapter.insertKnowledgeMemory({ ...newKnowledge('a', s), created_at: NOW + 300 });
      adapter.insertKnowledgeMemory({ ...newKnowledge('b', s), created_at: NOW + 200 });
      adapter.insertKnowledgeMemory({ ...newKnowledge('c', s), created_at: NOW + 100 });

      const first = adapter.listMemoryEvents(s, { limit: 2 });
      expect(first.events.map((e) => e.event_id)).toEqual(['1', '2']);
      expect(first.nextCursor).toBe('2');
      const second = adapter.listMemoryEvents(s, { limit: 2, cursor: first.nextCursor! });
      // No skips, no repeats: event 3 follows exactly, despite lowest created_at.
      expect(second.events.map((e) => e.event_id)).toEqual(['3']);
      expect(second.nextCursor).toBeNull();
    });

    it('folds temporal state in event_id order regardless of created_at', () => {
      const s = scope();
      const k = adapter.insertKnowledgeMemory({ ...newKnowledge('v0', s), created_at: NOW + 500 });
      // A later update with an EARLIER created_at must still be the winning
      // fold value because it has the higher event_id.
      adapter.updateKnowledgeMemory(k.id, { trust_score: 0.9 });
      const events = adapter.listMemoryEvents(s, { limit: 100 }).events;
      const folded = foldTemporalState(events);
      const foldedKnowledge = folded.knowledge.find((item) => item.id === k.id);
      expect(foldedKnowledge?.trust_score).toBe(0.9);
    });
  });

  // ---- 2.1/2.2 atomic mutation + event; promotion all-or-nothing ----
  describe('2.1/2.2 atomicity', () => {
    it('promoteKnowledgeCandidate flips candidate + inserts knowledge + emits both events atomically', () => {
      const s = scope();
      const candidate = adapter.insertKnowledgeCandidate({
        ...s,
        working_memory_id: 1,
        fact: 'user likes dark mode',
        fact_type: 'preference',
        knowledge_class: 'preference',
        normalized_fact: 'user likes dark mode',
        confidence: 'high',
      });
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

    it('fault-injection on promotion leaves NO partial state', () => {
      const s = scope();
      const candidate = adapter.insertKnowledgeCandidate({
        ...s,
        working_memory_id: 1,
        fact: 'x',
        fact_type: 'preference',
        knowledge_class: 'preference',
        normalized_fact: 'x',
        confidence: 'high',
      });
      const knowledgeCountBefore = adapter.getActiveKnowledgeMemory(s).length;
      const eventCountBefore = adapter.listMemoryEvents(s, { limit: 1000 }).events.length;

      // Invalid input (empty fact) forces validateNewKnowledgeMemory to throw
      // AFTER the candidate would otherwise flip.
      const bad = { ...newKnowledge('', s) } as NewKnowledgeMemory;
      expect(() => adapter.promoteKnowledgeCandidate(candidate.id, bad)).toThrow();

      // Candidate unchanged, no knowledge row, no leaked events.
      const candidateAfter = adapter.getKnowledgeCandidateById(candidate.id);
      expect(candidateAfter?.state).toBe('candidate');
      expect(candidateAfter?.promoted_knowledge_id).toBeNull();
      expect(adapter.getActiveKnowledgeMemory(s).length).toBe(knowledgeCountBefore);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(eventCountBefore);
    });

    it('transaction() rolls back multi-step mutations on throw', () => {
      const s = scope();
      const before = adapter.getActiveKnowledgeMemory(s).length;
      expect(() =>
        adapter.transaction(() => {
          adapter.insertKnowledgeMemory(newKnowledge('one', s));
          adapter.insertKnowledgeMemory(newKnowledge('two', s));
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(adapter.getActiveKnowledgeMemory(s).length).toBe(before);
      // No events leaked either.
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events.length).toBe(0);
    });

    it('emits governance events for contract/invariant/escalation upserts and deletes', () => {
      const s = scope();
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
      // Governance state round-trips.
      const state = adapter.getGovernanceState!(s);
      expect(state?.escalationPolicy).toEqual({ defaultDecision: 'review' });
      expect(state?.deletedContractNames).toContain('strict');
      expect(state?.deletedInvariantIds).toContain('inv1');
    });

    it('emits source-document create/update events', () => {
      const s = scope();
      const doc = adapter.insertSourceDocument({ ...s, title: 'Doc', content_hash: 'h1' });
      adapter.updateSourceDocument(doc.id, { status: 'processed', fact_count: 3 });
      const types = adapter.listMemoryEvents(s, { limit: 100 }).events.map((e) => e.event_type);
      expect(types).toContain('source_document.created');
      expect(types).toContain('source_document.updated');
    });

    // Finding 6: batch primitives must be all-or-nothing (a bare .map would leave
    // rows + events from the items before the throw, diverging from the
    // relational adapters' transactional batches).
    it('insertKnowledgeMemories mid-batch throw persists ZERO rows/events', () => {
      const s = scope();
      const bad = { ...newKnowledge('', s) } as NewKnowledgeMemory; // empty fact throws
      expect(() =>
        adapter.insertKnowledgeMemories([newKnowledge('valid-first', s), bad]),
      ).toThrow();
      expect(adapter.getActiveKnowledgeMemory(s)).toHaveLength(0);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events).toHaveLength(0);
    });

    it('insertTurns mid-batch throw persists ZERO rows/events', () => {
      const s = scope();
      const good = { ...s, session_id: 'sess-1', actor: 'user', role: 'user' as const, content: 'hi' };
      const bad = { ...good, content: '' }; // empty content throws
      expect(() => adapter.insertTurns([good, bad])).toThrow();
      expect(adapter.getActiveTurns(s)).toHaveLength(0);
      expect(adapter.listMemoryEvents(s, { limit: 1000 }).events).toHaveLength(0);
    });

    // Finding 1 (D1): a playbook revision must emit BOTH the audit event
    // (playbook.revised) AND a playbook after-snapshot (playbook.updated) so
    // temporal replay reconstructs the bumped revision_count. Old behavior
    // emitted only playbook.revised, so the replayed revision_count stayed 0.
    it('insertPlaybookRevision emits playbook.updated and replay revision_count == live', () => {
      const s = scope();
      const pb = adapter.insertPlaybook({ ...s, title: 'pb', description: 'd', instructions: 'i0' });
      adapter.insertPlaybookRevision({
        ...s,
        playbook_id: pb.id,
        instructions: 'i1',
        revision_reason: 'refine',
      });

      const events = adapter.listMemoryEvents(s, { limit: 100 }).events;
      const types = events.map((e) => e.event_type);
      expect(types).toContain('playbook.revised');
      expect(types).toContain('playbook.updated');

      const live = adapter.getPlaybookById(pb.id)!;
      expect(live.revision_count).toBe(1);

      const folded = foldTemporalState(events);
      const replayed = folded.playbooks.find((p) => p.id === pb.id)!;
      expect(replayed.revision_count).toBe(live.revision_count);
      expect(replayed.updated_at).toBe(live.updated_at);
    });
  });

  // ---- 2.5 lazy lease expiry: reads never write; reaper exactly-once ----
  describe('2.5 lazy lease expiry', () => {
    function claimExpiringSoon(s: MemoryScope) {
      const item = adapter.insertWorkItem({ ...s, kind: 'objective', title: 'task' });
      return adapter.claimWorkItem({
        ...s,
        work_item_id: item.id,
        actor: actor('agent-1'),
        lease_seconds: 10,
        visibility_class: 'private',
      });
    }

    it('reads of an expired claim write nothing (store untouched)', () => {
      const s = scope();
      const claim = claimExpiringSoon(s);
      const eventsBefore = adapter.listMemoryEvents(s, { limit: 1000 }).events.length;

      // Advance past lease so the claim is effectively expired.
      vi.setSystemTime(new Date((NOW + 100) * 1000));

      // Reads compute effective status without writing.
      expect(adapter.getActiveWorkClaim(claim.work_item_id)).toBeNull();
      const listed = adapter.listWorkClaims(s, { includeExpired: true });
      expect(listed.find((c) => c.id === claim.id)?.status).toBe('expired');
      adapter.listWorkClaimsCrossScope(s, 'workspace', { includeExpired: true });

      // No expiry events emitted by reads; stored claim still 'active'.
      const eventsAfter = adapter.listMemoryEvents(s, { limit: 1000 }).events;
      expect(eventsAfter.length).toBe(eventsBefore);
      expect(eventsAfter.some((e) => e.event_type === 'work_claim.expired')).toBe(false);
    });

    it('expireStaleClaims writes expiry + exactly one event per claim', () => {
      const s = scope();
      const claim = claimExpiringSoon(s);
      vi.setSystemTime(new Date((NOW + 100) * 1000));

      const expired = adapter.expireStaleClaims(s, NOW + 100);
      expect(expired).toEqual([claim.id]);

      // Second call is a no-op (already expired) — no duplicate event.
      const expiredAgain = adapter.expireStaleClaims(s, NOW + 200);
      expect(expiredAgain).toEqual([]);

      const expiryEvents = adapter
        .listMemoryEvents(s, { limit: 1000 })
        .events.filter((e) => e.event_type === 'work_claim.expired' && e.entity_id === String(claim.id));
      expect(expiryEvents).toHaveLength(1);
    });

    it('maintenance pipeline runs expireStaleClaims and reports expired claims', async () => {
      const s = scope();
      const claim = claimExpiringSoon(s);
      vi.setSystemTime(new Date((NOW + 100) * 1000));
      const asyncAdapter = wrapSyncAdapter(adapter);
      const report = await runMaintenance(asyncAdapter, s);
      expect(report.expiredWorkClaimIds).toContain(claim.id);
      const expiryEvents = adapter
        .listMemoryEvents(s, { limit: 1000 })
        .events.filter((e) => e.event_type === 'work_claim.expired');
      expect(expiryEvents).toHaveLength(1);
    });

    // Finding 5 (D6): by-id reads must apply the SAME effective-status
    // computation as the list paths, so an expired-lease claim reads 'expired'
    // consistently across read paths (old getWorkClaimById returned the raw
    // stored 'active').
    it('getWorkClaimById effective status matches the list path for an expired lease', () => {
      const s = scope();
      const claim = claimExpiringSoon(s);
      vi.setSystemTime(new Date((NOW + 100) * 1000));

      const byId = adapter.getWorkClaimById(claim.id);
      const fromList = adapter
        .listWorkClaims(s, { includeExpired: true })
        .find((c) => c.id === claim.id);
      expect(byId?.status).toBe('expired');
      expect(byId?.status).toBe(fromList?.status);
      // Still a non-mutating read: no expiry event persisted.
      expect(
        adapter
          .listMemoryEvents(s, { limit: 1000 })
          .events.some((e) => e.event_type === 'work_claim.expired'),
      ).toBe(false);
    });
  });

  // ---- 2.5 lazy HANDOFF expiry (D5): reads never write; reaper exactly-once ----
  describe('2.5 lazy handoff expiry (D5)', () => {
    function handoffExpiringSoon(s: MemoryScope) {
      const item = adapter.insertWorkItem({ ...s, kind: 'objective', title: 'task' });
      return adapter.createHandoff({
        ...s,
        work_item_id: item.id,
        from_actor: actor('agent-1'),
        to_actor: actor('agent-2'),
        summary: 'take this over',
        expires_at: NOW + 10,
        visibility_class: 'private',
      });
    }

    it('reads of an expired handoff write nothing (store untouched)', () => {
      const s = scope();
      const handoff = handoffExpiringSoon(s);
      const eventsBefore = adapter.listMemoryEvents(s, { limit: 1000 }).events.length;

      vi.setSystemTime(new Date((NOW + 100) * 1000));

      // Two list calls (the double-emission bug class): both compute effective
      // 'expired' without writing.
      const first = adapter.listHandoffs(s).find((h) => h.id === handoff.id);
      const second = adapter.listHandoffs(s).find((h) => h.id === handoff.id);
      expect(first?.status).toBe('expired');
      expect(second?.status).toBe('expired');
      adapter.listHandoffsCrossScope(s, 'workspace');
      expect(adapter.getHandoffById(handoff.id)?.status).toBe('expired');

      const eventsAfter = adapter.listMemoryEvents(s, { limit: 1000 }).events;
      expect(eventsAfter.length).toBe(eventsBefore);
      expect(eventsAfter.some((e) => e.event_type === 'handoff.expired')).toBe(false);
    });

    it('expireStaleHandoffs writes expiry + exactly one event per handoff', () => {
      const s = scope();
      const handoff = handoffExpiringSoon(s);
      vi.setSystemTime(new Date((NOW + 100) * 1000));

      const expired = adapter.expireStaleHandoffs(s, NOW + 100);
      expect(expired).toEqual([handoff.id]);
      // Idempotent: a second reaper pass emits no duplicate event.
      expect(adapter.expireStaleHandoffs(s, NOW + 200)).toEqual([]);

      const expiryEvents = adapter
        .listMemoryEvents(s, { limit: 1000 })
        .events.filter((e) => e.event_type === 'handoff.expired' && e.entity_id === String(handoff.id));
      expect(expiryEvents).toHaveLength(1);
    });

    it('maintenance pipeline runs expireStaleHandoffs and reports expired handoffs', async () => {
      const s = scope();
      const handoff = handoffExpiringSoon(s);
      vi.setSystemTime(new Date((NOW + 100) * 1000));
      const asyncAdapter = wrapSyncAdapter(adapter);
      const report = await runMaintenance(asyncAdapter, s);
      expect(report.expiredHandoffIds).toContain(handoff.id);
      const expiryEvents = adapter
        .listMemoryEvents(s, { limit: 1000 })
        .events.filter((e) => e.event_type === 'handoff.expired');
      expect(expiryEvents).toHaveLength(1);
    });
  });

  // ---- 2.4 embedding dimension/model versioning ----
  describe('2.4 embedding versioning', () => {
    it('excludes vectors whose dimensions mismatch the active provider filter', () => {
      const emb = createInMemoryAdapterWithEmbeddings();
      const s = scope();
      const a = emb.insertKnowledgeMemory(newKnowledge('a', s));
      const b = emb.insertKnowledgeMemory(newKnowledge('b', s));
      // Old 2-dim vectors from a previous provider.
      emb.embeddings.storeEmbedding(a.id, new Float32Array([1, 0]), {
        model: 'old-model',
        dimensions: 2,
      });
      emb.embeddings.storeEmbedding(b.id, new Float32Array([0, 1]), {
        model: 'old-model',
        dimensions: 2,
      });

      // Active provider now emits 3-dim vectors: all stored vectors mismatch and
      // must be excluded in-store (never distance-compared).
      const query = new Float32Array([1, 0, 0]);
      const filter = { model: 'new-model', dimensions: 3 };
      expect(emb.embeddings.findSimilar(s, query, { filter })).toEqual([]);
      const coverage = emb.embeddings.getEmbeddingCoverage!(s, filter);
      expect(coverage).toEqual({ total: 2, matching: 0, mismatched: 2 });
      emb.close();
    });

    it('restores coverage once vectors are re-embedded at the active dimensions', () => {
      const emb = createInMemoryAdapterWithEmbeddings();
      const s = scope();
      const a = emb.insertKnowledgeMemory(newKnowledge('a', s));
      emb.embeddings.storeEmbedding(a.id, new Float32Array([1, 0]), {
        model: 'old-model',
        dimensions: 2,
      });
      const filter = { model: 'new-model', dimensions: 3 };
      expect(emb.embeddings.getEmbeddingCoverage!(s, filter).matching).toBe(0);

      // Re-embed with the active provider's model + dimensions.
      emb.embeddings.storeEmbedding(a.id, new Float32Array([1, 0, 0]), {
        model: 'new-model',
        dimensions: 3,
      });
      expect(emb.embeddings.getEmbeddingCoverage!(s, filter)).toEqual({
        total: 1,
        matching: 1,
        mismatched: 0,
      });
      const results = emb.embeddings.findSimilar(s, new Float32Array([1, 0, 0]), { filter });
      expect(results.map((r) => r.knowledgeMemoryId)).toEqual([a.id]);
      emb.close();
    });

    // Finding 2 (D2): when the manager has no configured model it must NOT pass
    // model='unknown' as a strict filter. A same-dimension vector stored under a
    // REAL model must still be returned. Old memory matchesFilter compared
    // stored.model !== 'unknown' and wrongly excluded it, killing search.
    it('returns a real-model vector when the active-model filter is unknown/omitted', () => {
      const emb = createInMemoryAdapterWithEmbeddings();
      const s = scope();
      const a = emb.insertKnowledgeMemory(newKnowledge('a', s));
      emb.embeddings.storeEmbedding(a.id, new Float32Array([1, 0, 0]), {
        model: 'text-embedding-3',
        dimensions: 3,
      });
      const query = new Float32Array([1, 0, 0]);

      // Manager with no embeddingModel builds a dimensions-only filter.
      const dimsOnly = emb.embeddings.findSimilar(s, query, { filter: { dimensions: 3 } });
      expect(dimsOnly.map((r) => r.knowledgeMemoryId)).toEqual([a.id]);
      // An explicit model:'unknown' filter must be treated as "model unknown",
      // NOT strict-equality — the real-model vector still surfaces.
      const unknownModel = emb.embeddings.findSimilar(s, query, {
        filter: { model: 'unknown', dimensions: 3 },
      });
      expect(unknownModel.map((r) => r.knowledgeMemoryId)).toEqual([a.id]);
      // A KNOWN, different model still excludes the stale vector.
      const wrongModel = emb.embeddings.findSimilar(s, query, {
        filter: { model: 'other-model', dimensions: 3 },
      });
      expect(wrongModel).toEqual([]);
      emb.close();
    });

    // Finding 3 (D3): staleness is metadata-aware. A model swap at the SAME
    // dimensionality is stale even though a length-only check would miss it;
    // reembedKnowledge must re-embed all such rows and restore coverage.
    it('reembedKnowledge repairs a same-dimension model swap', async () => {
      const emb = createInMemoryAdapterWithEmbeddings();
      const s = scope();
      const k = emb.insertKnowledgeMemory(newKnowledge('prefers ts', s));
      // Stale vector: right dimensions (3), wrong (old) model.
      emb.embeddings.storeEmbedding(k.id, new Float32Array([1, 0, 0]), {
        model: 'v1',
        dimensions: 3,
      });

      const manager = createMemoryManager({
        adapter: emb,
        scope: s,
        sessionId: 'sess-1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
        embeddingAdapter: emb.embeddings,
        embeddingGenerator: async (texts) => texts.map(() => new Float32Array([0, 1, 0])),
        embeddingModel: 'v2',
      });

      const activeFilter = { model: 'v2', dimensions: 3 };
      expect(emb.embeddings.getEmbeddingCoverage!(s, activeFilter)).toEqual({
        total: 1,
        matching: 0,
        mismatched: 1,
      });

      const { reembeddedIds } = await manager.reembedKnowledge();
      expect(reembeddedIds).toEqual([k.id]);
      expect(emb.embeddings.getEmbeddingCoverage!(s, activeFilter)).toEqual({
        total: 1,
        matching: 1,
        mismatched: 0,
      });
      await manager.close();
      emb.close();
    });
  });

  // ---- AC: replay-equivalence mini check ----
  describe('replay equivalence', () => {
    it('folded state at cutoff equals a live snapshot taken at that time', async () => {
      const s = scope();

      // A random-ish op sequence including promotions, governance, claims.
      const wm = adapter.insertWorkItem({ ...s, kind: 'objective', title: 'ship feature' });
      adapter.claimWorkItem({
        ...s,
        work_item_id: wm.id,
        actor: actor('agent-1'),
        lease_seconds: 10,
        visibility_class: 'private',
      });
      const candidate = adapter.insertKnowledgeCandidate({
        ...s,
        working_memory_id: 1,
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

      // Capture the cutoff (last event id) and a LIVE snapshot at this instant.
      const cutoffEvents = adapter.listMemoryEvents(s, { limit: 1000 }).events;
      const asOf = NOW; // all ops happened at NOW under fake timers
      const liveKnowledge = adapter
        .getActiveKnowledgeMemory(s)
        .map((k) => ({ id: k.id, fact: k.fact, trust_score: k.trust_score }))
        .sort((a, b) => a.id - b.id);
      const liveWorkItems = adapter
        .getActiveWorkItems(s)
        .map((w) => ({ id: w.id, title: w.title, status: w.status }))
        .sort((a, b) => a.id - b.id);
      // Claim is expired-in-effect at asOf+100; test equivalence at asOf (active).
      const liveClaims = adapter
        .listWorkClaims(s, { includeExpired: true })
        .map((c) => ({ id: c.id, status: c.status }))
        .sort((a, b) => a.id - b.id);

      // Replay: fold the log and normalize claims/handoffs at asOf.
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

      // Governance is explicitly outside temporal replay: fold must NOT surface
      // the invariant as a replayable entity kind (audit-only).
      expect((folded as Record<string, unknown>).invariants).toBeUndefined();
    });

    it('fold tolerates unknown/audit-only event kinds (forward compatibility)', () => {
      const s = scope();
      // A log containing only audit-only kinds folds to empty replay state.
      adapter.insertSourceDocument({ ...s, title: 'Doc', content_hash: 'h1' });
      adapter.upsertContextEscalationPolicy!(s, { defaultDecision: 'allow' });
      const events = adapter.listMemoryEvents(s, { limit: 100 }).events;
      const folded = foldTemporalState(events);
      expect(folded.knowledge).toHaveLength(0);
      expect(folded.workItems).toHaveLength(0);
    });
  });
});
