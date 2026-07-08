/**
 * Cross-adapter conformance suite (plan item 3.10) — the release gate for 4.4.0
 * and the permanent guard against re-divergence of the storage adapters.
 *
 * ONE spec, parameterized over [in-memory, SQLite, Postgres] via
 * {@link harnessCases}. Postgres is gated on POSTGRES_TEST_URL: absent locally
 * the pg variants collect as `it.skip`, but the file is written so the SAME
 * assertions RUN against a real Postgres in the postgres-integration CI job (the
 * only place pg-only bind/type bugs — e.g. the Phase 2 ±Infinity/INTEGER-column
 * class — are visible). Every adapter is exercised through the async interface
 * (sync adapters wrapped by `wrapSyncAdapter`), so the test body is verbatim
 * across all three.
 *
 * What it pins, per the manager P-decisions and the upstream Kernel/SQLite/pg
 * reports:
 *
 *  1. Search contract (P1/P2/P4): single-token exact-match queries return the
 *     same result SET on every adapter; activeOnly defaults true (superseded /
 *     retired / archived excluded) and activeOnly:false includes them;
 *     trust/state/class/tag filters yield identical sets; a high-trust match
 *     beyond the first LIMIT rows is not starved; rank ∈ (0,1] higher=better and
 *     is non-increasing (and strictly orders distinct-relevance hits on the FTS
 *     engines — catching the SQLite constant-1.0 bug); searchPlaybooks rank is a
 *     real score, never the array index.
 *  2. Options/pagination (P1): limit + cursor page boundaries have no
 *     skips/repeats and cover the full set; terminal nextCursor is null.
 *  3. Ordering (P3): every method with a declared canonical ordering
 *     (`getTurnsByTimeRange`, `getWorkingMemoryBySession`,
 *     `getWorkItemsByTimeRange`, `getActiveWorkItems`, `getKnowledgeByTimeRange`)
 *     returns rows in `created_at ASC, id ASC` on all adapters.
 *  4. Field parity (P5): insert with ALL contract fields incl. caller
 *     `created_at` → read back equal on every adapter (catches pg dropping
 *     created_at / visibility_class / source_working_memory_id / compaction error).
 *  5. Visibility (P6): a `private` fact in scope A is invisible to scope B at
 *     EVERY widening level; `workspace`/`shared_collaboration`/`tenant` surface
 *     per their access rule, on every adapter.
 *  6. Scope widening (3.9): the documented widening matrix holds; the
 *     shared_collaboration collaboration_id gate behaves per the decision.
 *
 * ACCEPTED DIVERGENCES (asserted-as-documented, NOT forced equal): multi-term
 * relevance RANKING and absolute rank magnitudes differ across engines; pg
 * 'english' stemming vs unstemmed sqlite/memory. The single-token exact-match
 * result-SET invariant holds regardless, which is what these tests query.
 *
 * Determinism: no `Date.now()` / `Math.random()` in the test body. All seeded
 * values are fixed literals (or a seeded PRNG from the harness). Two consecutive
 * runs are byte-identical; the orchestrator runs the suite twice to prove it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import type { NewKnowledgeMemory, NewWorkItem } from '../contracts/types.js';
import { harnessCases, isSkipped, type HarnessAdapter } from './helpers/verification-harness.js';

// A wide-open time range that admits every seeded row regardless of created_at.
// F2: end_at is capped at int4 max (2_147_483_647). created_at columns are
// INTEGER on Postgres, so binding a larger "all time" bound (the former
// 10_000_000_000) raises pg 22003 (integer out of range) in the CI job while
// passing silently on SQLite/memory. The Y2038 INTEGER-vs-BIGINT column
// question is OUT OF SCOPE for 4.4.0 — see the future-item note in the report.
const INT4_MAX = 2_147_483_647;
const ALL_TIME = { start_at: 0, end_at: INT4_MAX } as const;

/** Canonical conformance scope; overridable per test for the scope-model matrix. */
function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'conf-tenant',
    system_id: 'sys-a',
    workspace_id: 'ws-1',
    collaboration_id: '',
    scope_id: 'scope-1',
    ...overrides,
  };
}

/** A fully-specified knowledge insert with sensible active-trusted defaults. */
function kFact(
  s: MemoryScope,
  fact: string,
  overrides: Partial<NewKnowledgeMemory> = {},
): NewKnowledgeMemory {
  return {
    ...s,
    fact,
    fact_type: 'reference',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    source: 'manual',
    confidence: 'high',
    ...overrides,
  };
}

function workItem(s: MemoryScope, title: string, overrides: Partial<NewWorkItem> = {}): NewWorkItem {
  return {
    ...s,
    kind: 'objective',
    title,
    status: 'open',
    ...overrides,
  };
}

/** Assert every rank obeys the (0,1] higher=better contract and is non-increasing. */
function assertRankContract(results: Array<{ rank: number }>): void {
  for (const r of results) {
    expect(r.rank).toBeGreaterThan(0);
    expect(r.rank).toBeLessThanOrEqual(1);
  }
  for (let i = 1; i < results.length; i += 1) {
    expect(results[i].rank).toBeLessThanOrEqual(results[i - 1].rank);
  }
}

const idSet = (rows: Array<{ id: number }>): Set<number> => new Set(rows.map((r) => r.id));
const itemIdSet = (rows: Array<{ item: { id: number } }>): Set<number> =>
  new Set(rows.map((r) => r.item.id));

describe.each(harnessCases())('adapter conformance [%s]', (name, factory) => {
  const skipped = isSkipped(name);
  const maybeIt = skipped ? it.skip : it;
  const isMemory = name === 'in-memory';
  let harness: HarnessAdapter;
  let db: AsyncStorageAdapter;

  beforeEach(async () => {
    if (skipped) return;
    harness = await factory();
    db = harness.adapter;
  });

  afterEach(async () => {
    if (skipped) return;
    await harness.close();
  });

  // ── 1. Search contract (P1/P2/P4) ──────────────────────────────────────────
  describe('search contract', () => {
    maybeIt('single-token exact-match query returns the same result SET', async () => {
      const s = scope();
      const zebraA = await db.insertKnowledgeMemory(kFact(s, 'the zebra runbook covers rollout'));
      const zebraB = await db.insertKnowledgeMemory(kFact(s, 'zebra migration checklist reviewed'));
      const helmet = await db.insertKnowledgeMemory(kFact(s, 'helmet safety inspection notes'));

      const zebraHits = await db.searchKnowledge(s, 'zebra');
      // Same SET across adapters: exactly the two zebra facts, never the helmet.
      expect(itemIdSet(zebraHits)).toEqual(new Set([zebraA.id, zebraB.id]));
      assertRankContract(zebraHits);

      const helmetHits = await db.searchKnowledge(s, 'helmet');
      expect(itemIdSet(helmetHits)).toEqual(new Set([helmet.id]));
    });

    maybeIt('activeOnly defaults true (superseded/retired excluded); false includes them', async () => {
      const s = scope();
      const active = await db.insertKnowledgeMemory(kFact(s, 'quartz alpha fact'));
      const toSupersede = await db.insertKnowledgeMemory(kFact(s, 'quartz beta fact'));
      const toRetire = await db.insertKnowledgeMemory(kFact(s, 'quartz gamma fact'));
      const replacement = await db.insertKnowledgeMemory(kFact(s, 'quartz replacement fact'));
      await db.supersedeKnowledgeMemory(toSupersede.id, replacement.id);
      await db.retireKnowledgeMemory(toRetire.id);

      const defaultHits = itemIdSet(await db.searchKnowledge(s, 'quartz'));
      expect(defaultHits.has(active.id)).toBe(true);
      expect(defaultHits.has(replacement.id)).toBe(true);
      expect(defaultHits.has(toSupersede.id)).toBe(false);
      expect(defaultHits.has(toRetire.id)).toBe(false);

      const allHits = itemIdSet(await db.searchKnowledge(s, 'quartz', { activeOnly: false }));
      expect(allHits.has(toSupersede.id)).toBe(true);
      expect(allHits.has(toRetire.id)).toBe(true);
    });

    maybeIt('trust/class/tag filters return identical SETs across adapters', async () => {
      const s = scope();
      const lowTrust = await db.insertKnowledgeMemory(
        kFact(s, 'walnut low trust note', { trust_score: 0.2 }),
      );
      const highTrust = await db.insertKnowledgeMemory(
        kFact(s, 'walnut high trust note', { trust_score: 0.9 }),
      );
      const preferenceClass = await db.insertKnowledgeMemory(
        kFact(s, 'walnut preference item', { knowledge_class: 'preference', trust_score: 0.9 }),
      );
      const tagged = await db.insertKnowledgeMemory(
        kFact(s, 'walnut tagged item', { tags: ['release'], trust_score: 0.9 }),
      );

      // minimumTrustScore
      expect(itemIdSet(await db.searchKnowledge(s, 'walnut', { minimumTrustScore: 0.5 }))).toEqual(
        new Set([highTrust.id, preferenceClass.id, tagged.id]),
      );
      // knowledgeClasses
      expect(
        itemIdSet(await db.searchKnowledge(s, 'walnut', { knowledgeClasses: ['preference'] })),
      ).toEqual(new Set([preferenceClass.id]));
      // tags (ANY-of containment)
      expect(itemIdSet(await db.searchKnowledge(s, 'walnut', { tags: ['release'] }))).toEqual(
        new Set([tagged.id]),
      );
      // sanity: unfiltered set is all four
      expect(itemIdSet(await db.searchKnowledge(s, 'walnut'))).toEqual(
        new Set([lowTrust.id, highTrust.id, preferenceClass.id, tagged.id]),
      );
    });

    maybeIt('a high-trust match beyond the first LIMIT rows is not starved (P4)', async () => {
      const s = scope();
      // Four short, term-dense low-trust facts dominate lexical rank; one long,
      // term-sparse high-trust fact ranks last. Pre-P4 (filter after LIMIT) the
      // trust filter starved it on the SQL adapters.
      for (let i = 0; i < 4; i += 1) {
        await db.insertKnowledgeMemory(kFact(s, 'signal signal signal now', { trust_score: 0.2 }));
      }
      const high = await db.insertKnowledgeMemory(
        kFact(s, 'signal appears once inside this much longer lower-frequency sentence about process', {
          trust_score: 0.95,
        }),
      );

      const results = await db.searchKnowledge(s, 'signal', { limit: 2, minimumTrustScore: 0.5 });
      expect(results.map((r) => r.item.id)).toContain(high.id);
      expect(results.every((r) => r.item.trust_score >= 0.5)).toBe(true);
    });

    maybeIt('rank is (0,1] and strictly orders distinct-relevance hits on FTS engines', async () => {
      const s = scope();
      const dense = await db.insertKnowledgeMemory(kFact(s, 'signal signal signal signal alert'));
      await db.insertKnowledgeMemory(
        kFact(s, 'signal appears once within a much longer sentence of many other distinct words here'),
      );

      const results = await db.searchKnowledge(s, 'signal');
      expect(results).toHaveLength(2);
      assertRankContract(results);
      // The FTS engines (SQLite bm25, pg ts_rank) differentiate by frequency /
      // length; distinct ranks here is exactly what the constant-1.0 SQLite bug
      // violated. The in-memory scorer legitimately ties single-token hits at
      // 1.0 (documented simpler scorer), so distinctness is engine-gated.
      if (!isMemory) {
        expect(new Set(results.map((r) => r.rank)).size).toBeGreaterThan(1);
        expect(results[0].item.id).toBe(dense.id);
      }
    });

    maybeIt('searchPlaybooks rank is a real (0,1] score, not the array index', async () => {
      const s = scope();
      await db.insertPlaybook({
        ...s,
        title: 'Falcon deploy runbook',
        description: 'how to run the falcon falcon pipeline falcon',
        instructions: 'run falcon',
      });
      await db.insertPlaybook({
        ...s,
        title: 'Onboarding guide',
        description: 'falcon appears once among many other onboarding words here',
        instructions: 'welcome aboard',
      });

      const results = await db.searchPlaybooks(s, 'falcon');
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Index-as-rank would have made the top hit rank 0 (falsy) — this catches it.
      assertRankContract(results);
    });
  });

  // ── 2. Options / pagination (P1) ────────────────────────────────────────────
  describe('pagination', () => {
    maybeIt('limit + cursor page boundaries have no skips/repeats and cover the full set', async () => {
      const s = scope();
      const ids: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        ids.push((await db.insertKnowledgeMemory(kFact(s, `page fact number ${i}`))).id);
      }
      const expected = new Set(ids);

      const seen = new Set<number>();
      let cursor: number | undefined;
      let pages = 0;
      for (;;) {
        const page = await db.getActiveKnowledgeMemoryPaginated(s, { limit: 2, cursor });
        pages += 1;
        for (const row of page.items) {
          expect(seen.has(row.id), `repeat ${row.id}`).toBe(false);
          seen.add(row.id);
        }
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor as number;
        expect(pages).toBeLessThan(10); // guard against a non-advancing cursor
      }
      expect(seen).toEqual(expected);
      expect(pages).toBe(Math.ceil(ids.length / 2));
    });
  });

  // ── 3. Ordering parity (P3): created_at ASC, then id ASC ─────────────────────
  describe('ordering (P3): created_at ASC then id ASC', () => {
    /** Assert rows are sorted by (created_at ASC, id ASC). */
    function assertCanonicalOrder(rows: Array<{ id: number; created_at: number }>): void {
      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const ok =
          prev.created_at < cur.created_at ||
          (prev.created_at === cur.created_at && prev.id < cur.id);
        expect(ok, `row ${i} out of canonical order`).toBe(true);
      }
    }

    maybeIt('getWorkItemsByTimeRange / getActiveWorkItems honor created_at ASC, id ASC', async () => {
      const s = scope();
      // Insert with caller created_at OUT of insertion order, including a tie so
      // the id tie-break is exercised (pg previously ordered updated_at DESC).
      const c = await db.insertWorkItem(workItem(s, 'C', { created_at: 300 }));
      const a1 = await db.insertWorkItem(workItem(s, 'A1', { created_at: 100 }));
      const a2 = await db.insertWorkItem(workItem(s, 'A2', { created_at: 100 }));
      const b = await db.insertWorkItem(workItem(s, 'B', { created_at: 200 }));
      const expectedOrder = [a1.id, a2.id, b.id, c.id];

      const byRange = await db.getWorkItemsByTimeRange(s, ALL_TIME);
      assertCanonicalOrder(byRange);
      expect(byRange.map((w) => w.id)).toEqual(expectedOrder);

      const active = await db.getActiveWorkItems(s);
      assertCanonicalOrder(active);
      expect(active.map((w) => w.id)).toEqual(expectedOrder);
    });

    maybeIt('getTurnsByTimeRange honors created_at ASC, id ASC', async () => {
      const s = scope();
      const t3 = await db.insertTurn({ ...s, session_id: 'sess', actor: 'u', role: 'user', content: 'third', created_at: 300 });
      const t1 = await db.insertTurn({ ...s, session_id: 'sess', actor: 'u', role: 'user', content: 'first', created_at: 100 });
      const t2 = await db.insertTurn({ ...s, session_id: 'sess', actor: 'u', role: 'user', content: 'second', created_at: 200 });

      const rows = await db.getTurnsByTimeRange(s, ALL_TIME);
      assertCanonicalOrder(rows);
      expect(rows.map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
    });

    maybeIt('getWorkingMemoryBySession / getKnowledgeByTimeRange return ascending insertion order', async () => {
      const s = scope();
      // Working memory + knowledge don't accept caller created_at; created_at is
      // insertion-time so canonical order equals id ASC. This still catches the
      // pg getWorkingMemoryBySession id-DESC divergence.
      const wmIds: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        wmIds.push(
          (
            await db.insertWorkingMemory({
              ...s,
              session_id: 'wm-sess',
              summary: `summary ${i}`,
              key_entities: [],
              topic_tags: [],
              turn_id_start: 0,
              turn_id_end: 0,
              turn_count: 1,
              compaction_trigger: 'manual',
            })
          ).id,
        );
      }
      const wm = await db.getWorkingMemoryBySession('wm-sess', s);
      assertCanonicalOrder(wm);
      expect(wm.map((m) => m.id)).toEqual(wmIds);

      const kIds: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        kIds.push((await db.insertKnowledgeMemory(kFact(s, `ordered fact ${i}`))).id);
      }
      const kByRange = await db.getKnowledgeByTimeRange(s, ALL_TIME);
      assertCanonicalOrder(kByRange);
      expect(kByRange.map((k) => k.id)).toEqual(kIds);
    });
  });

  // ── 4. Field parity (P5): insert-all-fields → read-back-equal ────────────────
  describe('field parity (P5)', () => {
    maybeIt('Turn round-trips every contract field incl. caller created_at', async () => {
      const s = scope();
      const inserted = await db.insertTurn({
        ...s,
        session_id: 'sess-x',
        actor: 'agent-7',
        role: 'assistant',
        content: 'a fully specified turn',
        priority: 2,
        token_estimate: 42,
        created_at: 1_700_000_123,
      });
      const readBack = await db.getTurnById(inserted.id);
      expect(readBack).not.toBeNull();
      expect(readBack).toMatchObject({
        session_id: 'sess-x',
        actor: 'agent-7',
        role: 'assistant',
        content: 'a fully specified turn',
        priority: 2,
        token_estimate: 42,
        created_at: 1_700_000_123,
      });
    });

    maybeIt('WorkItem persists visibility_class, source_working_memory_id, and caller created_at', async () => {
      const s = scope();
      const wm = await db.insertWorkingMemory({
        ...s,
        session_id: 'wi-sess',
        summary: 'src wm',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 0,
        turn_id_end: 0,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      const inserted = await db.insertWorkItem({
        ...s,
        session_id: 'wi-sess',
        visibility_class: 'workspace',
        kind: 'unresolved_work',
        title: 'finish the migration',
        detail: 'blocked on review',
        status: 'in_progress',
        source_working_memory_id: wm.id,
        created_at: 1_700_000_456,
      });
      const readBack = await db.getWorkItemById(inserted.id);
      expect(readBack).not.toBeNull();
      expect(readBack).toMatchObject({
        session_id: 'wi-sess',
        visibility_class: 'workspace',
        kind: 'unresolved_work',
        title: 'finish the migration',
        detail: 'blocked on review',
        status: 'in_progress',
        source_working_memory_id: wm.id,
        created_at: 1_700_000_456,
      });
    });

    maybeIt('CompactionLog persists error and caller created_at', async () => {
      const s = scope();
      const wm = await db.insertWorkingMemory({
        ...s,
        session_id: 'cl-sess',
        summary: 'src wm',
        key_entities: [],
        topic_tags: [],
        turn_id_start: 0,
        turn_id_end: 0,
        turn_count: 1,
        compaction_trigger: 'manual',
      });
      const inserted = await db.insertCompactionLog({
        ...s,
        session_id: 'cl-sess',
        trigger_type: 'hard',
        turn_id_start: 1,
        turn_id_end: 9,
        turns_compacted: 8,
        tokens_compacted_estimate: 1234,
        working_memory_id: wm.id,
        active_turn_count_before: 10,
        active_turn_count_after: 2,
        duration_ms: 77,
        model_call_made: true,
        error: 'summarizer timed out',
        created_at: 1_700_000_789,
      });
      const readBack = await db.getCompactionLogById(inserted.id);
      expect(readBack).not.toBeNull();
      expect(readBack).toMatchObject({
        error: 'summarizer timed out',
        created_at: 1_700_000_789,
        duration_ms: 77,
        model_call_made: true,
      });
    });

    maybeIt('Playbook round-trips visibility_class (workspace/tenant, not defaulted to private) [F6(c)]', async () => {
      const s = scope();
      const wsPb = await db.insertPlaybook({
        ...s,
        visibility_class: 'workspace',
        title: 'ws playbook',
        description: 'workspace-scoped guide',
        instructions: 'do the thing',
      });
      const tenantPb = await db.insertPlaybook({
        ...s,
        visibility_class: 'tenant',
        title: 'tenant playbook',
        description: 'tenant-wide guide',
        instructions: 'do the other thing',
      });
      // An adapter that drops visibility_class on insert would read back 'private'.
      expect((await db.getPlaybookById(wsPb.id))?.visibility_class).toBe('workspace');
      expect((await db.getPlaybookById(tenantPb.id))?.visibility_class).toBe('tenant');
    });

    maybeIt('Knowledge round-trips caller-supplied created_at [F5]', async () => {
      const s = scope();
      const inserted = await db.insertKnowledgeMemory(
        kFact(s, 'backdated import fact', { created_at: 1_600_000_321 }),
      );
      const readBack = await db.getKnowledgeMemoryById(inserted.id);
      expect(readBack?.created_at).toBe(1_600_000_321);
    });
  });

  // ── 5. Cross-scope visibility (P6) ──────────────────────────────────────────
  describe('visibility (P6)', () => {
    const levels: ScopeLevel[] = ['scope', 'workspace', 'system', 'tenant'];
    const owner = scope({ scope_id: 'owner-scope', collaboration_id: 'collab-1' });
    // Reader: same tenant + workspace, different system_id + scope_id, different collab.
    const reader = scope({ system_id: 'sys-b', scope_id: 'reader-scope', collaboration_id: 'collab-2' });

    maybeIt('a private fact never surfaces to another scope at any widening level', async () => {
      const priv = await db.insertKnowledgeMemory(
        kFact(owner, 'private xylophone secret', { visibility_class: 'private' }),
      );
      for (const level of levels) {
        expect(idSet(await db.getActiveKnowledgeCrossScope(reader, level)).has(priv.id)).toBe(false);
        expect(
          itemIdSet(await db.searchKnowledgeCrossScope(reader, level, 'xylophone')).has(priv.id),
        ).toBe(false);
        expect(idSet(await db.getKnowledgeSince(reader, level, 0)).has(priv.id)).toBe(false);
      }
    });

    maybeIt('a workspace fact surfaces cross-scope within the same workspace', async () => {
      const ws = await db.insertKnowledgeMemory(
        kFact(owner, 'workspace xylophone note', { visibility_class: 'workspace' }),
      );
      expect(idSet(await db.getActiveKnowledgeCrossScope(reader, 'workspace')).has(ws.id)).toBe(true);
      expect(
        itemIdSet(await db.searchKnowledgeCrossScope(reader, 'workspace', 'xylophone')).has(ws.id),
      ).toBe(true);
    });

    maybeIt('a shared_collaboration fact surfaces only inside its collaboration_id', async () => {
      const shared = await db.insertKnowledgeMemory(
        kFact(owner, 'shared xylophone collaboration note', {
          visibility_class: 'shared_collaboration',
        }),
      );
      // Reader in a DIFFERENT collaboration → invisible even at workspace widening.
      expect(
        itemIdSet(await db.searchKnowledgeCrossScope(reader, 'workspace', 'xylophone')).has(shared.id),
      ).toBe(false);
      // Reader in the SAME collaboration (different scope_id/system) → visible.
      const sameCollab = scope({ system_id: 'sys-c', scope_id: 'sibling', collaboration_id: 'collab-1' });
      expect(
        itemIdSet(await db.searchKnowledgeCrossScope(sameCollab, 'workspace', 'xylophone')).has(
          shared.id,
        ),
      ).toBe(true);
    });

    maybeIt('a tenant fact surfaces across systems and workspaces in the same tenant', async () => {
      const t = await db.insertKnowledgeMemory(
        kFact(owner, 'tenant xylophone announcement', { visibility_class: 'tenant' }),
      );
      // Reader in a different workspace entirely still sees a tenant-visible fact.
      const otherWs = scope({ system_id: 'sys-z', workspace_id: 'ws-9', scope_id: 'far' });
      expect(idSet(await db.getActiveKnowledgeCrossScope(otherWs, 'tenant')).has(t.id)).toBe(true);
    });

    maybeIt('a private fact is invisible across tenants at every level', async () => {
      const t = await db.insertKnowledgeMemory(
        kFact(owner, 'crosstenant xylophone secret', { visibility_class: 'tenant' }),
      );
      const otherTenant = scope({ tenant_id: 'other-tenant' });
      for (const level of levels) {
        expect(idSet(await db.getActiveKnowledgeCrossScope(otherTenant, level)).has(t.id)).toBe(false);
      }
    });
  });

  // ── 5b. Cross-scope leak closure: semantic + event-log (F4) ─────────────────
  describe('cross-scope leaks: semantic + event-log (F4)', () => {
    const levels: ScopeLevel[] = ['scope', 'workspace', 'system', 'tenant'];
    const owner = scope({ scope_id: 'owner-scope', collaboration_id: 'collab-1' });
    const reader = scope({ system_id: 'sys-b', scope_id: 'reader-scope', collaboration_id: 'collab-2' });
    const EMB_META = { model: 'conf-model', dimensions: 4 } as const;
    const embVector = (): Float32Array => Float32Array.from([1, 0, 0, 0]);

    maybeIt('a private fact with an embedding is invisible to a semantic search from another scope', async () => {
      const priv = await db.insertKnowledgeMemory(
        kFact(owner, 'private semantic secret', { visibility_class: 'private' }),
      );
      await harness.embeddings.storeEmbedding(priv.id, embVector(), EMB_META);
      const ws = await db.insertKnowledgeMemory(
        kFact(owner, 'workspace semantic note', { visibility_class: 'workspace' }),
      );
      await harness.embeddings.storeEmbedding(ws.id, embVector(), EMB_META);

      // The private fact from another scope must NOT surface at any widening level.
      for (const level of levels) {
        const hits = await harness.embeddings.findSimilarCrossScope(reader, level, embVector(), {
          limit: 10,
          minSimilarity: 0,
          filter: EMB_META,
        });
        expect(new Set(hits.map((h) => h.knowledgeMemoryId)).has(priv.id)).toBe(false);
      }
      // Positive control: the workspace-class fact IS found at workspace widening,
      // so the exclusion above is meaningful (not a vacuously-empty result).
      const wsHits = await harness.embeddings.findSimilarCrossScope(reader, 'workspace', embVector(), {
        limit: 10,
        minSimilarity: 0,
        filter: EMB_META,
      });
      expect(new Set(wsHits.map((h) => h.knowledgeMemoryId)).has(ws.id)).toBe(true);
    });

    maybeIt('a private fact\'s knowledge.created event is not returned cross-scope', async () => {
      const priv = await db.insertKnowledgeMemory(
        kFact(owner, 'private event secret', { visibility_class: 'private' }),
      );
      const ws = await db.insertKnowledgeMemory(
        kFact(owner, 'workspace event note', { visibility_class: 'workspace' }),
      );
      const knowledgeEventEntityIds = async (level: ScopeLevel): Promise<Set<string>> => {
        const page = await db.listMemoryEventsCrossScope(reader, level, { limit: 200 });
        return new Set(
          page.events
            .filter((e) => e.entity_kind === 'knowledge_memory')
            .map((e) => e.entity_id),
        );
      };
      // Events embed the full fact snapshot in payload.after; the private fact's
      // event must never surface cross-scope at any level.
      for (const level of levels) {
        expect((await knowledgeEventEntityIds(level)).has(String(priv.id))).toBe(false);
      }
      // Positive control: the workspace fact's event surfaces at workspace widening.
      expect((await knowledgeEventEntityIds('workspace')).has(String(ws.id))).toBe(true);
    });
  });

  // ── 5c. Residual cross-scope orderings pinned (F6(d)) ───────────────────────
  describe('residual cross-scope orderings (F6(d))', () => {
    /** Assert rows are sorted by (created_at ASC, id ASC). */
    function assertCanonicalOrder(rows: Array<{ id: number; created_at: number }>): void {
      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const ok =
          prev.created_at < cur.created_at ||
          (prev.created_at === cur.created_at && prev.id < cur.id);
        expect(ok, `row ${i} out of canonical order`).toBe(true);
      }
    }

    maybeIt('getActiveKnowledgeCrossScope / getKnowledgeSince return created_at ASC, id ASC', async () => {
      const s = scope();
      const vis = { visibility_class: 'tenant' as const };
      // Insert with caller created_at OUT of insertion order, incl. a tie.
      const c = await db.insertKnowledgeMemory(kFact(s, 'residual c', { ...vis, created_at: 300 }));
      const a1 = await db.insertKnowledgeMemory(kFact(s, 'residual a1', { ...vis, created_at: 100 }));
      const a2 = await db.insertKnowledgeMemory(kFact(s, 'residual a2', { ...vis, created_at: 100 }));
      const b = await db.insertKnowledgeMemory(kFact(s, 'residual b', { ...vis, created_at: 200 }));
      const expectedOrder = [a1.id, a2.id, b.id, c.id];

      const cross = await db.getActiveKnowledgeCrossScope(s, 'tenant');
      assertCanonicalOrder(cross);
      expect(cross.map((k) => k.id)).toEqual(expectedOrder);

      const since = await db.getKnowledgeSince(s, 'tenant', 0);
      assertCanonicalOrder(since);
      expect(since.map((k) => k.id)).toEqual(expectedOrder);
    });

    maybeIt('getActivePlaybooksCrossScope returns created_at ASC, id ASC', async () => {
      const s = scope();
      const pbC = await db.insertPlaybook({
        ...s,
        visibility_class: 'tenant',
        title: 'pb C',
        description: 'd',
        instructions: 'i',
        created_at: 300,
      });
      const pbA = await db.insertPlaybook({
        ...s,
        visibility_class: 'tenant',
        title: 'pb A',
        description: 'd',
        instructions: 'i',
        created_at: 100,
      });
      const pbB = await db.insertPlaybook({
        ...s,
        visibility_class: 'tenant',
        title: 'pb B',
        description: 'd',
        instructions: 'i',
        created_at: 200,
      });
      const rows = await db.getActivePlaybooksCrossScope(s, 'tenant');
      assertCanonicalOrder(rows);
      expect(rows.map((p) => p.id)).toEqual([pbA.id, pbB.id, pbC.id]);
    });
  });

  // ── 6. Scope widening matrix (3.9) ──────────────────────────────────────────
  describe('scope widening matrix (3.9)', () => {
    // All facts are `tenant`-visible so the widening LEVEL (not visibility) is the
    // sole variable; getActiveKnowledgeCrossScope ANDs matchesScopeLevel with the
    // base-visibility gate. Reader = scope() (tenant conf-tenant, sys-a, ws-1, scope-1).
    maybeIt('getActiveKnowledgeCrossScope surfaces exactly the widening matrix per level', async () => {
      const reader = scope();
      const vis = { visibility_class: 'tenant' as const };
      const own = await db.insertKnowledgeMemory(kFact(scope(), 'matrix own', vis));
      const sameSysOtherScope = await db.insertKnowledgeMemory(
        kFact(scope({ scope_id: 'scope-2' }), 'matrix same-system', vis),
      );
      const sameWsOtherSys = await db.insertKnowledgeMemory(
        kFact(scope({ system_id: 'sys-b', scope_id: 'scope-3' }), 'matrix same-workspace', vis),
      );
      const otherWs = await db.insertKnowledgeMemory(
        kFact(scope({ workspace_id: 'ws-2', system_id: 'sys-b', scope_id: 'scope-4' }), 'matrix other-workspace', vis),
      );
      const otherTenant = await db.insertKnowledgeMemory(
        kFact(scope({ tenant_id: 'tenant-2' }), 'matrix other-tenant', vis),
      );

      // scope: exact match only.
      const atScope = idSet(await db.getActiveKnowledgeCrossScope(reader, 'scope'));
      expect(atScope.has(own.id)).toBe(true);
      expect(atScope.has(sameSysOtherScope.id)).toBe(false);
      expect(atScope.has(sameWsOtherSys.id)).toBe(false);

      // system: same tenant + system, any scope/workspace-under-system.
      const atSystem = idSet(await db.getActiveKnowledgeCrossScope(reader, 'system'));
      expect(atSystem.has(own.id)).toBe(true);
      expect(atSystem.has(sameSysOtherScope.id)).toBe(true);
      expect(atSystem.has(sameWsOtherSys.id)).toBe(false); // different system
      expect(atSystem.has(otherWs.id)).toBe(false);

      // workspace: same tenant + workspace, ANY system (documented: ignores system_id).
      const atWorkspace = idSet(await db.getActiveKnowledgeCrossScope(reader, 'workspace'));
      expect(atWorkspace.has(own.id)).toBe(true);
      expect(atWorkspace.has(sameWsOtherSys.id)).toBe(true);
      expect(atWorkspace.has(otherWs.id)).toBe(false); // different workspace
      expect(atWorkspace.has(otherTenant.id)).toBe(false);

      // tenant: everything in the tenant, nothing outside it.
      const atTenant = idSet(await db.getActiveKnowledgeCrossScope(reader, 'tenant'));
      expect(atTenant.has(own.id)).toBe(true);
      expect(atTenant.has(sameSysOtherScope.id)).toBe(true);
      expect(atTenant.has(sameWsOtherSys.id)).toBe(true);
      expect(atTenant.has(otherWs.id)).toBe(true);
      expect(atTenant.has(otherTenant.id)).toBe(false);
    });
  });
});
