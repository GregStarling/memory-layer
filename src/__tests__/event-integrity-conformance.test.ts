/**
 * Release-gating event-integrity conformance suite (plan 2.1/2.2, 5.3 scope).
 *
 * Part A — coverage: for every mutation primitive covered by 2.1/2.2, perform
 * the mutation in isolation and assert EXACTLY the expected event(s) were
 * appended (entity_kind, entity_id, event_type), in event_id order. Runs
 * against [in-memory, SQLite, Postgres-gated]. Governance primitives run only
 * on adapters that implement the optional governance surface (in-memory,
 * SQLite); they are excluded from the pg matrix.
 *
 * Part B — fault injection (SQLite): monkeypatch the memory_event_log INSERT to
 * throw, then drive promotion, a turn insert, and a claim; assert each rolls
 * back fully (no orphaned row, no orphaned event).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { ActorRef } from '../contracts/coordination.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { MemoryEventRecord } from '../contracts/temporal.js';
import type { NewKnowledgeMemory } from '../contracts/types.js';
import { harnessCases, isSkipped, verifyScope, type HarnessAdapter } from './helpers/verification-harness.js';

const CLAIM_AT = 1_700_000_000;

function actor(id = 'agent-1'): ActorRef {
  return { actor_kind: 'agent', actor_id: id, system_id: 'verify-system', display_name: id, metadata: null };
}

function newKnowledge(fact: string, s: MemoryScope): NewKnowledgeMemory {
  return { ...s, fact, fact_type: 'preference', source: 'manual', confidence: 'high' };
}

interface EventShape {
  entity_kind: string;
  event_type: string;
  entity_id: string;
}

const project = (e: MemoryEventRecord): EventShape => ({
  entity_kind: e.entity_kind,
  event_type: e.event_type,
  entity_id: e.entity_id,
});

async function drainEvents(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  cursor?: string,
): Promise<MemoryEventRecord[]> {
  const all: MemoryEventRecord[] = [];
  let c = cursor;
  for (;;) {
    const page = await adapter.listMemoryEvents(scope, { limit: 500, cursor: c });
    all.push(...page.events);
    if (!page.nextCursor) break;
    c = page.nextCursor;
  }
  return all;
}

/** Run `mutate` and return exactly the events it appended, in event_id order. */
async function capture(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  mutate: () => Promise<void>,
): Promise<EventShape[]> {
  const before = await drainEvents(adapter, scope);
  const cursor = before.length > 0 ? before[before.length - 1].event_id : undefined;
  await mutate();
  const after = await drainEvents(adapter, scope, cursor);
  return after.map(project);
}

async function seedWorkingMemory(adapter: AsyncStorageAdapter, scope: MemoryScope): Promise<number> {
  const wm = await adapter.insertWorkingMemory({
    ...scope,
    session_id: 'sess-1',
    summary: 'seed',
    key_entities: [],
    topic_tags: [],
    turn_id_start: 0,
    turn_id_end: 0,
    turn_count: 0,
    compaction_trigger: 'manual',
  });
  return wm.id;
}

interface PrimitiveCase {
  name: string;
  needsGovernance?: boolean;
  run(adapter: AsyncStorageAdapter, scope: MemoryScope): Promise<{ expected: EventShape[]; actual: EventShape[] }>;
}

const CASES: PrimitiveCase[] = [
  {
    name: 'insertTurn -> turn.created',
    async run(a, s) {
      let id = '';
      const actual = await capture(a, s, async () => {
        const t = await a.insertTurn({ ...s, session_id: 'sess-1', actor: 'user', role: 'user', content: 'hi' });
        id = String(t.id);
      });
      return { expected: [{ entity_kind: 'turn', event_type: 'turn.created', entity_id: id }], actual };
    },
  },
  {
    name: 'archiveTurn -> turn.archived',
    async run(a, s) {
      const wmId = await seedWorkingMemory(a, s);
      const t = await a.insertTurn({ ...s, session_id: 'sess-1', actor: 'user', role: 'user', content: 'hi' });
      const log = await a.insertCompactionLog({
        ...s,
        session_id: 'sess-1',
        trigger_type: 'manual',
        turn_id_start: t.id,
        turn_id_end: t.id,
        turns_compacted: 1,
        tokens_compacted_estimate: 10,
        working_memory_id: wmId,
        active_turn_count_before: 1,
        active_turn_count_after: 0,
        duration_ms: 1,
      });
      const actual = await capture(a, s, async () => {
        await a.archiveTurn(t.id, CLAIM_AT, log.id);
      });
      return { expected: [{ entity_kind: 'turn', event_type: 'turn.archived', entity_id: String(t.id) }], actual };
    },
  },
  {
    name: 'insertKnowledgeMemory -> knowledge.created',
    async run(a, s) {
      let id = '';
      const actual = await capture(a, s, async () => {
        id = String((await a.insertKnowledgeMemory(newKnowledge('k', s))).id);
      });
      return { expected: [{ entity_kind: 'knowledge_memory', event_type: 'knowledge.created', entity_id: id }], actual };
    },
  },
  {
    name: 'updateKnowledgeMemory -> knowledge.updated',
    async run(a, s) {
      const k = await a.insertKnowledgeMemory(newKnowledge('k', s));
      const actual = await capture(a, s, async () => {
        await a.updateKnowledgeMemory(k.id, { trust_score: 0.5 });
      });
      return { expected: [{ entity_kind: 'knowledge_memory', event_type: 'knowledge.updated', entity_id: String(k.id) }], actual };
    },
  },
  {
    name: 'touchKnowledgeMemory -> knowledge.touched',
    async run(a, s) {
      const k = await a.insertKnowledgeMemory(newKnowledge('k', s));
      const actual = await capture(a, s, async () => {
        await a.touchKnowledgeMemory(k.id);
      });
      return { expected: [{ entity_kind: 'knowledge_memory', event_type: 'knowledge.touched', entity_id: String(k.id) }], actual };
    },
  },
  {
    name: 'retireKnowledgeMemory -> knowledge.retired',
    async run(a, s) {
      const k = await a.insertKnowledgeMemory(newKnowledge('k', s));
      const actual = await capture(a, s, async () => {
        await a.retireKnowledgeMemory(k.id);
      });
      return { expected: [{ entity_kind: 'knowledge_memory', event_type: 'knowledge.retired', entity_id: String(k.id) }], actual };
    },
  },
  {
    name: 'supersedeKnowledgeMemory -> knowledge.superseded',
    async run(a, s) {
      const oldK = await a.insertKnowledgeMemory(newKnowledge('old', s));
      const newK = await a.insertKnowledgeMemory(newKnowledge('new', s));
      const actual = await capture(a, s, async () => {
        await a.supersedeKnowledgeMemory(oldK.id, newK.id);
      });
      return {
        expected: [{ entity_kind: 'knowledge_memory', event_type: 'knowledge.superseded', entity_id: String(oldK.id) }],
        actual,
      };
    },
  },
  {
    name: 'insertKnowledgeCandidate -> knowledge_candidate.created',
    async run(a, s) {
      const wmId = await seedWorkingMemory(a, s);
      let id = '';
      const actual = await capture(a, s, async () => {
        const c = await a.insertKnowledgeCandidate({
          ...s,
          working_memory_id: wmId,
          fact: 'c',
          fact_type: 'preference',
          knowledge_class: 'preference',
          normalized_fact: 'c',
          confidence: 'high',
        });
        id = String(c.id);
      });
      return { expected: [{ entity_kind: 'knowledge_candidate', event_type: 'knowledge_candidate.created', entity_id: id }], actual };
    },
  },
  {
    name: 'promoteKnowledgeCandidate -> knowledge.created + knowledge_candidate.promoted',
    async run(a, s) {
      const wmId = await seedWorkingMemory(a, s);
      const c = await a.insertKnowledgeCandidate({
        ...s,
        working_memory_id: wmId,
        fact: 'c',
        fact_type: 'preference',
        knowledge_class: 'preference',
        normalized_fact: 'c',
        confidence: 'high',
      });
      let kid = '';
      const actual = await capture(a, s, async () => {
        kid = String((await a.promoteKnowledgeCandidate(c.id, newKnowledge('c', s))).id);
      });
      return {
        expected: [
          { entity_kind: 'knowledge_memory', event_type: 'knowledge.created', entity_id: kid },
          { entity_kind: 'knowledge_candidate', event_type: 'knowledge_candidate.promoted', entity_id: String(c.id) },
        ],
        actual,
      };
    },
  },
  {
    name: 'insertWorkItem -> work_item.created',
    async run(a, s) {
      let id = '';
      const actual = await capture(a, s, async () => {
        id = String((await a.insertWorkItem({ ...s, kind: 'objective', title: 't' })).id);
      });
      return { expected: [{ entity_kind: 'work_item', event_type: 'work_item.created', entity_id: id }], actual };
    },
  },
  {
    name: 'updateWorkItemStatus -> work_item.status_changed',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      const actual = await capture(a, s, async () => {
        await a.updateWorkItemStatus(w.id, 'in_progress');
      });
      return { expected: [{ entity_kind: 'work_item', event_type: 'work_item.status_changed', entity_id: String(w.id) }], actual };
    },
  },
  {
    name: 'updateWorkItem -> work_item.updated',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      const actual = await capture(a, s, async () => {
        await a.updateWorkItem(w.id, { title: 't2' });
      });
      return { expected: [{ entity_kind: 'work_item', event_type: 'work_item.updated', entity_id: String(w.id) }], actual };
    },
  },
  {
    name: 'deleteWorkItem -> work_item.deleted',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      const actual = await capture(a, s, async () => {
        await a.deleteWorkItem(w.id);
      });
      return { expected: [{ entity_kind: 'work_item', event_type: 'work_item.deleted', entity_id: String(w.id) }], actual };
    },
  },
  {
    name: 'claimWorkItem -> work_claim.claimed',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      let id = '';
      const actual = await capture(a, s, async () => {
        const c = await a.claimWorkItem({
          ...s,
          work_item_id: w.id,
          actor: actor(),
          lease_seconds: 300,
          visibility_class: 'private',
          claimed_at: CLAIM_AT,
        });
        id = String(c.id);
      });
      return { expected: [{ entity_kind: 'work_claim', event_type: 'work_claim.claimed', entity_id: id }], actual };
    },
  },
  {
    name: 'renewWorkClaim -> work_claim.renewed',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      // Real-now claim (no pinned claimed_at) so the lease is live at renew time.
      const c = await a.claimWorkItem({
        ...s,
        work_item_id: w.id,
        actor: actor(),
        lease_seconds: 300,
        visibility_class: 'private',
      });
      const actual = await capture(a, s, async () => {
        await a.renewWorkClaim(c.id, actor(), 300);
      });
      return { expected: [{ entity_kind: 'work_claim', event_type: 'work_claim.renewed', entity_id: String(c.id) }], actual };
    },
  },
  {
    name: 'releaseWorkClaim -> work_claim.released',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      // Real-now claim so the lease is live (release rejects an expired claim).
      const c = await a.claimWorkItem({
        ...s,
        work_item_id: w.id,
        actor: actor(),
        lease_seconds: 300,
        visibility_class: 'private',
      });
      const actual = await capture(a, s, async () => {
        await a.releaseWorkClaim(c.id, actor(), 'done');
      });
      return { expected: [{ entity_kind: 'work_claim', event_type: 'work_claim.released', entity_id: String(c.id) }], actual };
    },
  },
  {
    name: 'expireStaleClaims -> work_claim.expired',
    async run(a, s) {
      const w = await a.insertWorkItem({ ...s, kind: 'objective', title: 't' });
      const c = await a.claimWorkItem({
        ...s,
        work_item_id: w.id,
        actor: actor(),
        lease_seconds: 1,
        visibility_class: 'private',
        claimed_at: CLAIM_AT,
      });
      const actual = await capture(a, s, async () => {
        await a.expireStaleClaims(s, CLAIM_AT + 100);
      });
      return { expected: [{ entity_kind: 'work_claim', event_type: 'work_claim.expired', entity_id: String(c.id) }], actual };
    },
  },
  {
    name: 'insertPlaybook -> playbook.created',
    async run(a, s) {
      let id = '';
      const actual = await capture(a, s, async () => {
        id = String((await a.insertPlaybook({ ...s, title: 'p', description: 'd', instructions: 'i' })).id);
      });
      return { expected: [{ entity_kind: 'playbook', event_type: 'playbook.created', entity_id: id }], actual };
    },
  },
  {
    name: 'updatePlaybook -> playbook.updated',
    async run(a, s) {
      const p = await a.insertPlaybook({ ...s, title: 'p', description: 'd', instructions: 'i' });
      const actual = await capture(a, s, async () => {
        await a.updatePlaybook(p.id, { title: 'p2' });
      });
      return { expected: [{ entity_kind: 'playbook', event_type: 'playbook.updated', entity_id: String(p.id) }], actual };
    },
  },
  {
    name: 'recordPlaybookUse -> playbook.used',
    async run(a, s) {
      const p = await a.insertPlaybook({ ...s, title: 'p', description: 'd', instructions: 'i' });
      const actual = await capture(a, s, async () => {
        await a.recordPlaybookUse(p.id);
      });
      return { expected: [{ entity_kind: 'playbook', event_type: 'playbook.used', entity_id: String(p.id) }], actual };
    },
  },
  {
    // D1: a revision emits the revision audit event (playbook.revised) AND a
    // playbook after-snapshot (playbook.updated) so temporal replay reconstructs
    // the bumped revision_count/updated_at. Both events, in event_id order
    // (revised first, then the parent snapshot), on every adapter.
    name: 'insertPlaybookRevision -> playbook.revised + playbook.updated',
    async run(a, s) {
      const p = await a.insertPlaybook({ ...s, title: 'p', description: 'd', instructions: 'i' });
      let rid = '';
      const actual = await capture(a, s, async () => {
        const r = await a.insertPlaybookRevision({ ...s, playbook_id: p.id, instructions: 'i2', revision_reason: 'refine' });
        rid = String(r.id);
      });
      return {
        expected: [
          { entity_kind: 'playbook_revision', event_type: 'playbook.revised', entity_id: rid },
          { entity_kind: 'playbook', event_type: 'playbook.updated', entity_id: String(p.id) },
        ],
        actual,
      };
    },
  },
  {
    name: 'insertAssociation -> association.created',
    async run(a, s) {
      const k1 = await a.insertKnowledgeMemory(newKnowledge('a', s));
      const k2 = await a.insertKnowledgeMemory(newKnowledge('b', s));
      let id = '';
      const actual = await capture(a, s, async () => {
        const assoc = await a.insertAssociation({
          ...s,
          source_kind: 'knowledge',
          source_id: k1.id,
          target_kind: 'knowledge',
          target_id: k2.id,
          association_type: 'related_to',
        });
        id = String(assoc.id);
      });
      return { expected: [{ entity_kind: 'association', event_type: 'association.created', entity_id: id }], actual };
    },
  },
  {
    name: 'deleteAssociation -> association.deleted',
    async run(a, s) {
      const k1 = await a.insertKnowledgeMemory(newKnowledge('a', s));
      const k2 = await a.insertKnowledgeMemory(newKnowledge('b', s));
      const assoc = await a.insertAssociation({
        ...s,
        source_kind: 'knowledge',
        source_id: k1.id,
        target_kind: 'knowledge',
        target_id: k2.id,
        association_type: 'related_to',
      });
      const actual = await capture(a, s, async () => {
        await a.deleteAssociation(assoc.id);
      });
      return { expected: [{ entity_kind: 'association', event_type: 'association.deleted', entity_id: String(assoc.id) }], actual };
    },
  },
  {
    name: 'insertSourceDocument -> source_document.created',
    async run(a, s) {
      let id = '';
      const actual = await capture(a, s, async () => {
        const d = await a.insertSourceDocument({ ...s, title: 'doc', content_hash: 'h1' });
        id = String(d.id);
      });
      return { expected: [{ entity_kind: 'source_document', event_type: 'source_document.created', entity_id: id }], actual };
    },
  },
  {
    name: 'updateSourceDocument -> source_document.updated',
    async run(a, s) {
      const d = await a.insertSourceDocument({ ...s, title: 'doc', content_hash: 'h1' });
      const actual = await capture(a, s, async () => {
        await a.updateSourceDocument(d.id, { status: 'processed', fact_count: 2 });
      });
      return { expected: [{ entity_kind: 'source_document', event_type: 'source_document.updated', entity_id: String(d.id) }], actual };
    },
  },
  {
    name: 'upsertSessionState -> session_state.updated',
    async run(a, s) {
      const actual = await capture(a, s, async () => {
        await a.upsertSessionState({
          ...s,
          session_id: 'sess-42',
          currentObjective: 'ship',
          blockers: [],
          assumptions: [],
          pendingDecisions: [],
          activeTools: [],
          recentOutputs: [],
          updatedAt: CLAIM_AT,
        });
      });
      return { expected: [{ entity_kind: 'session_state', event_type: 'session_state.updated', entity_id: 'sess-42' }], actual };
    },
  },
  {
    name: 'upsertContextInvariant -> context_invariant.set',
    needsGovernance: true,
    async run(a, s) {
      const actual = await capture(a, s, async () => {
        await a.upsertContextInvariant!(s, { id: 'inv-1', title: 'T', instruction: 'always cite' });
      });
      return { expected: [{ entity_kind: 'context_invariant', event_type: 'context_invariant.set', entity_id: 'inv-1' }], actual };
    },
  },
  {
    name: 'deleteContextInvariant -> context_invariant.deleted',
    needsGovernance: true,
    async run(a, s) {
      await a.upsertContextInvariant!(s, { id: 'inv-1', title: 'T', instruction: 'always cite' });
      const actual = await capture(a, s, async () => {
        await a.deleteContextInvariant!(s, 'inv-1');
      });
      return { expected: [{ entity_kind: 'context_invariant', event_type: 'context_invariant.deleted', entity_id: 'inv-1' }], actual };
    },
  },
  {
    name: 'upsertDefaultContextContract -> context_contract.set',
    needsGovernance: true,
    async run(a, s) {
      const actual = await capture(a, s, async () => {
        await a.upsertDefaultContextContract!(s, { tokenBudget: 1000 });
      });
      return { expected: [{ entity_kind: 'context_contract', event_type: 'context_contract.set', entity_id: '__default__' }], actual };
    },
  },
  {
    name: 'upsertContextEscalationPolicy -> context_escalation_policy.set',
    needsGovernance: true,
    async run(a, s) {
      const actual = await capture(a, s, async () => {
        await a.upsertContextEscalationPolicy!(s, { defaultDecision: 'review' });
      });
      return {
        expected: [{ entity_kind: 'context_escalation_policy', event_type: 'context_escalation_policy.set', entity_id: '__policy__' }],
        actual,
      };
    },
  },
];

describe.each(harnessCases())('event-integrity coverage [%s]', (name, factory) => {
  const skipped = isSkipped(name);
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

  // Governance primitives are optional; pg does not implement them (plan 3.8).
  const applicable = name === 'postgres' ? CASES.filter((c) => !c.needsGovernance) : CASES;
  const maybeEach = skipped ? it.skip.each(applicable) : it.each(applicable);

  maybeEach('$name', async (testCase) => {
    const scope = verifyScope({ scope_id: `case-${testCase.name.replace(/\W+/g, '-')}` });
    const { expected, actual } = await testCase.run(adapter, scope);
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Part B — SQLite fault injection: event insert throws -> full rollback.
// ---------------------------------------------------------------------------

/**
 * Throw the next time the memory_event_log INSERT is prepared on the shared
 * better-sqlite3 prototype (all event emission funnels through this INSERT).
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

describe('event-integrity fault injection [sqlite]', () => {
  let adapter: ReturnType<typeof createSQLiteAdapter>;

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function eventCount(scope: MemoryScope): number {
    return adapter.listMemoryEvents(scope, { limit: 1000 }).events.length;
  }

  it('turn insert rolls back its row and event when the event insert throws', () => {
    const s = verifyScope({ scope_id: 'fault-turn' });
    const before = eventCount(s);
    const restore = injectEventInsertFailure();
    try {
      expect(() =>
        adapter.insertTurn({ ...s, session_id: 'sess-1', actor: 'user', role: 'user', content: 'hi' }),
      ).toThrow();
    } finally {
      restore();
    }
    expect(adapter.getActiveTurns(s)).toHaveLength(0);
    expect(eventCount(s)).toBe(before);
  });

  it('claim rolls back its row and event when the event insert throws', () => {
    const s = verifyScope({ scope_id: 'fault-claim' });
    const w = adapter.insertWorkItem({ ...s, kind: 'objective', title: 't' });
    const before = eventCount(s);
    const restore = injectEventInsertFailure();
    try {
      expect(() =>
        adapter.claimWorkItem({
          ...s,
          work_item_id: w.id,
          actor: actor(),
          lease_seconds: 300,
          visibility_class: 'private',
        }),
      ).toThrow();
    } finally {
      restore();
    }
    expect(adapter.getActiveWorkClaim(w.id)).toBeNull();
    expect(eventCount(s)).toBe(before);
  });

  it('promotion rolls back candidate flip + knowledge insert + events on throw', () => {
    const s = verifyScope({ scope_id: 'fault-promote' });
    const wm = adapter.insertWorkingMemory({
      ...s,
      session_id: 'sess-1',
      summary: 'seed',
      key_entities: [],
      topic_tags: [],
      turn_id_start: 0,
      turn_id_end: 0,
      turn_count: 0,
      compaction_trigger: 'manual',
    });
    const candidate = adapter.insertKnowledgeCandidate({
      ...s,
      working_memory_id: wm.id,
      fact: 'c',
      fact_type: 'preference',
      knowledge_class: 'preference',
      normalized_fact: 'c',
      confidence: 'high',
    });
    const knowledgeBefore = adapter.getActiveKnowledgeMemory(s).length;
    const eventsBefore = eventCount(s);

    const restore = injectEventInsertFailure();
    try {
      expect(() => adapter.promoteKnowledgeCandidate(candidate.id, newKnowledge('c', s))).toThrow();
    } finally {
      restore();
    }

    const after = adapter.getKnowledgeCandidateById(candidate.id);
    expect(after?.state).toBe('candidate');
    expect(after?.promoted_knowledge_id ?? null).toBeNull();
    expect(adapter.getActiveKnowledgeMemory(s)).toHaveLength(knowledgeBefore);
    expect(eventCount(s)).toBe(eventsBefore);
  });
});
