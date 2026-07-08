/**
 * Postgres Phase 3 adapter-parity tests (gated on POSTGRES_TEST_URL).
 *
 * These assert the Postgres-specific half of the Phase 3 contract that is
 * INVISIBLE to the local SQLite/in-memory suite (the Phase 2 lesson: a float or
 * a dropped field is silently tolerated on SQLite but rejected / lost on
 * Postgres). They run only when POSTGRES_TEST_URL is set — the postgres-
 * integration CI job is the real gate — and otherwise collect as skipped with
 * no collection errors.
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@host:port/db npm run test:postgres
 *
 * Coverage:
 *   P5 (3.5) round-trip: insertTurn/insertWorkItem/insertCompactionLog honor
 *      caller created_at; work item persists visibility_class +
 *      source_working_memory_id; compaction log persists error.
 *   P6 (3.6) visibility: a private fact in scope A never surfaces to scope B via
 *      getActiveKnowledgeCrossScope / searchKnowledgeCrossScope; tenant-class
 *      does; shared_collaboration only within its collaboration_id.
 *   P4 (3.3) filters-before-LIMIT: a high-trust match ranked below the LIMIT
 *      window is still returned when a trust filter is applied.
 *   P1/P2 (3.2) search: single-token search returns the row with rank in (0,1].
 *   P3 (3.4) ordering: getWorkItemsByTimeRange returns created_at ASC, id ASC
 *      even with back-dated created_at.
 *   3.8 governance: put default + named contract + invariant + policy →
 *      getGovernanceState reconstructs them; delete soft-deletes.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresAdapter, createPostgresEmbeddingAdapter } from '../adapters/postgres/index.js';
import type { MemoryScope } from '../contracts/identity.js';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;
const describeIntegration = POSTGRES_TEST_URL ? describe : describe.skip;

if (!POSTGRES_TEST_URL) {
  // eslint-disable-next-line no-console
  console.info(
    '[postgres-phase3-parity] POSTGRES_TEST_URL not set — skipping. ' +
      'To enable: POSTGRES_TEST_URL=postgres://user:pass@host:port/db npm run test:postgres',
  );
}

function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      readFileSync(path.join(dir, 'openapi.yaml'), 'utf8');
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error('project root not found walking up from test file');
}

function loadSchemaSql(): string {
  return readFileSync(path.join(findProjectRoot(), 'src/adapters/postgres/schema.sql'), 'utf8');
}

/** A scope in workspace `ws`, collaboration `collab`, system `sys`. */
function scopeIn(
  ws: string,
  opts: { sys?: string; collab?: string; scopeId?: string } = {},
): MemoryScope {
  return {
    tenant_id: 'itest',
    system_id: opts.sys ?? 'sysA',
    workspace_id: ws,
    collaboration_id: opts.collab ?? '',
    scope_id: opts.scopeId ?? 'session-1',
  };
}

describeIntegration('Postgres Phase 3 adapter parity', () => {
  let pg: typeof import('pg');

  beforeAll(async () => {
    pg = await import('pg');
  });

  let poolRef: InstanceType<typeof import('pg').Pool> | null = null;
  let currentSchema: string | null = null;

  afterEach(async () => {
    if (poolRef && currentSchema) {
      try {
        await poolRef.query(`DROP SCHEMA IF EXISTS "${currentSchema}" CASCADE`);
      } catch {
        // best-effort cleanup
      }
    }
    if (poolRef) {
      await poolRef.end();
      poolRef = null;
    }
    currentSchema = null;
  });

  async function prepareAdapter(): Promise<{
    adapter: ReturnType<typeof createPostgresAdapter>;
    pool: InstanceType<typeof import('pg').Pool>;
  }> {
    const schemaName = `mlp3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const bootstrapPool = new pg.Pool({ connectionString: POSTGRES_TEST_URL });
    try {
      await bootstrapPool.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      await bootstrapPool.end();
    }
    const baseUrl = new URL(POSTGRES_TEST_URL!);
    baseUrl.searchParams.set('options', `-c search_path=${schemaName},public`);
    const pool = new pg.Pool({ connectionString: baseUrl.toString() });
    poolRef = pool;
    currentSchema = schemaName;
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(loadSchemaSql());
    return { adapter: createPostgresAdapter(pool), pool };
  }

  // ── P5: caller created_at + dropped-field parity ────────────────────────────

  it('P5: insertTurn honors caller created_at (integer round-trip)', async () => {
    const { adapter } = await prepareAdapter();
    const backdated = 1_600_000_000; // fixed past epoch-seconds
    const turn = await adapter.insertTurn({
      ...scopeIn('ws1'),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'historical turn',
      created_at: backdated,
    });
    expect(turn.created_at).toBe(backdated);
    const readBack = await adapter.getTurnById(turn.id);
    expect(readBack?.created_at).toBe(backdated);
  });

  it('P5: insertWorkItem persists created_at, visibility_class, source_working_memory_id', async () => {
    const { adapter } = await prepareAdapter();
    const backdated = 1_600_000_100;
    const item = await adapter.insertWorkItem({
      ...scopeIn('ws1'),
      session_id: 'session-1',
      kind: 'objective',
      title: 'ship it',
      visibility_class: 'workspace',
      source_working_memory_id: 42,
      created_at: backdated,
    });
    expect(item.created_at).toBe(backdated);
    expect(item.updated_at).toBe(backdated);
    expect(item.visibility_class).toBe('workspace');
    expect(item.source_working_memory_id).toBe(42);
    const readBack = await adapter.getWorkItemById(item.id);
    expect(readBack?.created_at).toBe(backdated);
    expect(readBack?.visibility_class).toBe('workspace');
    expect(readBack?.source_working_memory_id).toBe(42);
  });

  it('P5: insertCompactionLog persists error and honors created_at', async () => {
    const { adapter } = await prepareAdapter();
    const backdated = 1_600_000_200;
    const log = await adapter.insertCompactionLog({
      ...scopeIn('ws1'),
      session_id: 'session-1',
      trigger_type: 'soft',
      turn_id_start: 1,
      turn_id_end: 5,
      turns_compacted: 5,
      tokens_compacted_estimate: 100,
      working_memory_id: 1,
      active_turn_count_before: 5,
      active_turn_count_after: 1,
      duration_ms: 12,
      model_call_made: true,
      error: 'summarizer timeout',
      created_at: backdated,
    });
    expect(log.error).toBe('summarizer timeout');
    expect(log.created_at).toBe(backdated);
    const readBack = await adapter.getCompactionLogById(log.id);
    expect(readBack?.error).toBe('summarizer timeout');
    expect(readBack?.created_at).toBe(backdated);
  });

  it('P5: insertKnowledgeMemory persists visibility_class', async () => {
    const { adapter } = await prepareAdapter();
    const k = await adapter.insertKnowledgeMemory({
      ...scopeIn('ws1'),
      fact: 'private detail',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'private',
    });
    const readBack = await adapter.getKnowledgeMemoryById(k.id);
    expect(readBack?.visibility_class).toBe('private');
  });

  // ── P6: cross-scope visibility ──────────────────────────────────────────────

  it('P6: a private fact in scope A never surfaces to scope B cross-scope', async () => {
    const { adapter } = await prepareAdapter();
    const a = scopeIn('wsA', { sys: 'sysA' });
    const b = scopeIn('wsB', { sys: 'sysB' });
    await adapter.insertKnowledgeMemory({
      ...a,
      fact: 'alpha secret token',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'private',
    });
    // Reader in scope B, widening to tenant, must NOT see A's private fact.
    const active = await adapter.getActiveKnowledgeCrossScope(b, 'tenant');
    expect(active.some((k) => k.fact === 'alpha secret token')).toBe(false);
    const searched = await adapter.searchKnowledgeCrossScope(b, 'tenant', 'token');
    expect(searched.some((r) => r.item.fact === 'alpha secret token')).toBe(false);
  });

  it('P6: a tenant-visible fact surfaces cross-scope; workspace/shared do not leak', async () => {
    const { adapter } = await prepareAdapter();
    const a = scopeIn('wsA', { sys: 'sysA', collab: 'collab-1' });
    const b = scopeIn('wsB', { sys: 'sysB', collab: 'collab-2' });
    await adapter.insertKnowledgeMemory({
      ...a,
      fact: 'tenant wide announcement',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'tenant',
    });
    await adapter.insertKnowledgeMemory({
      ...a,
      fact: 'workspace only note',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'workspace',
    });
    await adapter.insertKnowledgeMemory({
      ...a,
      fact: 'collab one plan',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'shared_collaboration',
    });
    const active = await adapter.getActiveKnowledgeCrossScope(b, 'tenant');
    const facts = active.map((k) => k.fact);
    expect(facts).toContain('tenant wide announcement');
    expect(facts).not.toContain('workspace only note');
    expect(facts).not.toContain('collab one plan');
  });

  it('P6: shared_collaboration surfaces to a same-workspace reader in the same collaboration', async () => {
    const { adapter } = await prepareAdapter();
    const owner = scopeIn('wsShared', { sys: 'sysA', collab: 'collab-1', scopeId: 's1' });
    const peer = scopeIn('wsShared', { sys: 'sysB', collab: 'collab-1', scopeId: 's2' });
    await adapter.insertKnowledgeMemory({
      ...owner,
      fact: 'shared plan detail',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'shared_collaboration',
    });
    const active = await adapter.getActiveKnowledgeCrossScope(peer, 'workspace');
    expect(active.some((k) => k.fact === 'shared plan detail')).toBe(true);
  });

  it('P6: work items and playbooks respect cross-scope visibility', async () => {
    const { adapter } = await prepareAdapter();
    const a = scopeIn('wsA', { sys: 'sysA' });
    const b = scopeIn('wsB', { sys: 'sysB' });
    await adapter.insertWorkItem({
      ...a,
      session_id: 'session-1',
      kind: 'objective',
      title: 'private objective',
      visibility_class: 'private',
    });
    await adapter.insertPlaybook({
      ...a,
      title: 'private runbook',
      description: 'secret steps',
      instructions: 'do the secret thing',
      visibility_class: 'private',
    });
    const items = await adapter.getActiveWorkItemsCrossScope(b, 'tenant');
    expect(items.some((i) => i.title === 'private objective')).toBe(false);
    const playbooks = await adapter.getActivePlaybooksCrossScope(b, 'tenant');
    expect(playbooks.some((p) => p.title === 'private runbook')).toBe(false);
  });

  // ── P4: filters before LIMIT (no starvation) ────────────────────────────────

  it('P4: a high-trust match below the LIMIT window is still returned when filtered', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    // Insert many low-trust matches, then one high-trust match. All match the
    // single query token so the SQL WHERE (not a post-LIMIT JS filter) must be
    // what selects the high-trust row.
    for (let i = 0; i < 15; i++) {
      await adapter.insertKnowledgeMemory({
        ...s,
        fact: `widget note ${i}`,
        fact_type: 'reference',
        source: 'user_stated',
        confidence: 'low',
        trust_score: 0.1,
      });
    }
    const gold = await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'widget gold standard',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.95,
    });
    const results = await adapter.searchKnowledge(s, 'widget', {
      limit: 5,
      minimumTrustScore: 0.9,
    });
    // Only the gold row clears the trust filter, and it must survive despite the
    // 15 higher-frequency low-trust rows that would otherwise fill the LIMIT.
    expect(results.map((r) => r.item.id)).toContain(gold.id);
    expect(results.every((r) => r.item.trust_score >= 0.9)).toBe(true);
  });

  it('P4: tag filter uses ANY-of semantics (jsonb ?|)', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'tagged alpha item',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      tags: ['alpha'],
    });
    await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'tagged beta item',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      tags: ['beta'],
    });
    const results = await adapter.searchKnowledge(s, 'tagged', { tags: ['alpha', 'gamma'] });
    const facts = results.map((r) => r.item.fact);
    expect(facts).toContain('tagged alpha item');
    expect(facts).not.toContain('tagged beta item');
  });

  // ── P1/P2: search contract ──────────────────────────────────────────────────

  it('P1/P2: single-token search returns the row with rank in (0,1]', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'the banana is yellow',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const results = await adapter.searchKnowledge(s, 'banana');
    expect(results.length).toBe(1);
    expect(results[0].rank).toBeGreaterThan(0);
    expect(results[0].rank).toBeLessThanOrEqual(1);
  });

  it('P2: searchPlaybooks returns a normalized rank, not the array index', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    await adapter.insertPlaybook({
      ...s,
      title: 'deployment runbook',
      description: 'how to deploy',
      instructions: 'run the deploy script',
      status: 'active',
    });
    const results = await adapter.searchPlaybooks(s, 'deployment');
    expect(results.length).toBe(1);
    expect(results[0].rank).toBeGreaterThan(0);
    expect(results[0].rank).toBeLessThanOrEqual(1);
  });

  // ── P3: ordering parity ─────────────────────────────────────────────────────

  it('P3: getWorkItemsByTimeRange orders created_at ASC, id ASC with back-dated rows', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    // Insert in reverse chronological order so id order != created_at order.
    const later = await adapter.insertWorkItem({
      ...s,
      session_id: 'session-1',
      kind: 'objective',
      title: 'later',
      created_at: 2_000,
    });
    const earlier = await adapter.insertWorkItem({
      ...s,
      session_id: 'session-1',
      kind: 'objective',
      title: 'earlier',
      created_at: 1_000,
    });
    const items = await adapter.getWorkItemsByTimeRange(s, { start_at: 0, end_at: 10_000 });
    const ordered = items.map((i) => i.id);
    expect(ordered.indexOf(earlier.id)).toBeLessThan(ordered.indexOf(later.id));
  });

  // ── 3.8: governance persistence ─────────────────────────────────────────────

  it('3.8: default + named contracts, invariant, and policy round-trip via getGovernanceState', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    expect(adapter.getGovernanceState).toBeTypeOf('function');

    await adapter.upsertDefaultContextContract!(s, { tokenBudget: 4096, maxKnowledgeItems: 10 });
    await adapter.upsertNamedContextContract!(s, 'focused', { tokenBudget: 1024 });
    await adapter.upsertContextInvariant!(s, {
      id: 'inv-1',
      title: 'Always cite sources',
      instruction: 'Cite the source document id.',
      severity: 'critical',
      scopeLevel: 'workspace',
    });
    await adapter.upsertContextEscalationPolicy!(s, { defaultDecision: 'allow', maxTokenBudget: 8192 });

    const state = await adapter.getGovernanceState!(s);
    expect(state).not.toBeNull();
    expect(state!.defaultContract).toEqual({
      state: 'set',
      contract: { tokenBudget: 4096, maxKnowledgeItems: 10 },
    });
    expect(state!.namedContracts.focused).toEqual({ tokenBudget: 1024 });
    expect(state!.invariants).toHaveLength(1);
    expect(state!.invariants[0]).toMatchObject({ id: 'inv-1', severity: 'critical' });
    expect(state!.escalationPolicy).toMatchObject({ defaultDecision: 'allow', maxTokenBudget: 8192 });
  });

  it('3.8: deleting a named contract and invariant soft-deletes them', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    await adapter.upsertNamedContextContract!(s, 'temp', { tokenBudget: 512 });
    await adapter.upsertContextInvariant!(s, {
      id: 'inv-x',
      title: 't',
      instruction: 'i',
    });

    expect(await adapter.deleteNamedContextContract!(s, 'temp')).toBe(true);
    expect(await adapter.deleteContextInvariant!(s, 'inv-x')).toBe(true);
    // Deleting again reports "did not exist as active" (false).
    expect(await adapter.deleteNamedContextContract!(s, 'temp')).toBe(false);

    const state = await adapter.getGovernanceState!(s);
    expect(state!.namedContracts.temp).toBeUndefined();
    expect(state!.deletedContractNames).toContain('temp');
    expect(state!.invariants).toHaveLength(0);
    expect(state!.deletedInvariantIds).toContain('inv-x');
  });

  it('3.8: getGovernanceState returns null for a scope with no governance rows', async () => {
    const { adapter } = await prepareAdapter();
    const state = await adapter.getGovernanceState!(scopeIn('empty-ws'));
    expect(state).toBeNull();
  });

  // ── F4: semantic (embedding) cross-scope visibility gate ────────────────────

  it('F4: findSimilarCrossScope excludes a private fact from another scope at every level', async () => {
    const { adapter, pool } = await prepareAdapter();
    const embeddings = createPostgresEmbeddingAdapter(pool);
    const owner = scopeIn('wsShared', { sys: 'sysA', collab: 'collab-1', scopeId: 'owner' });
    const reader = scopeIn('wsShared', { sys: 'sysB', collab: 'collab-2', scopeId: 'reader' });
    const vec = (): Float32Array => Float32Array.from([1, 0, 0, 0]);
    const meta = { model: 'itest-model', dimensions: 4 } as const;

    const priv = await adapter.insertKnowledgeMemory({
      ...owner,
      fact: 'private semantic secret',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'private',
    });
    await embeddings.storeEmbedding(priv.id, vec(), meta);
    const ws = await adapter.insertKnowledgeMemory({
      ...owner,
      fact: 'workspace semantic note',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'workspace',
    });
    await embeddings.storeEmbedding(ws.id, vec(), meta);

    const levels = ['scope', 'workspace', 'system', 'tenant'] as const;
    for (const level of levels) {
      const hits = await embeddings.findSimilarCrossScope(reader, level, vec(), {
        limit: 10,
        minSimilarity: 0,
        filter: meta,
      });
      expect(new Set(hits.map((h) => h.knowledgeMemoryId)).has(priv.id)).toBe(false);
    }
    // Positive control: workspace-class fact IS found at workspace widening.
    const wsHits = await embeddings.findSimilarCrossScope(reader, 'workspace', vec(), {
      limit: 10,
      minSimilarity: 0,
      filter: meta,
    });
    expect(new Set(wsHits.map((h) => h.knowledgeMemoryId)).has(ws.id)).toBe(true);
  });

  // ── F4: event-log cross-scope visibility gate (payload.after leaks fact) ─────

  it('F4: listMemoryEventsCrossScope excludes a private fact\'s event at every level', async () => {
    const { adapter } = await prepareAdapter();
    const owner = scopeIn('wsShared', { sys: 'sysA', collab: 'collab-1', scopeId: 'owner' });
    const reader = scopeIn('wsShared', { sys: 'sysB', collab: 'collab-2', scopeId: 'reader' });

    const priv = await adapter.insertKnowledgeMemory({
      ...owner,
      fact: 'private event secret',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'private',
    });
    const ws = await adapter.insertKnowledgeMemory({
      ...owner,
      fact: 'workspace event note',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      visibility_class: 'workspace',
    });

    const knowledgeEntityIds = async (level: 'scope' | 'workspace' | 'system' | 'tenant') => {
      const page = await adapter.listMemoryEventsCrossScope(reader, level, { limit: 200 });
      return new Set(
        page.events.filter((e) => e.entity_kind === 'knowledge_memory').map((e) => e.entity_id),
      );
    };
    for (const level of ['scope', 'workspace', 'system', 'tenant'] as const) {
      expect((await knowledgeEntityIds(level)).has(String(priv.id))).toBe(false);
    }
    // Positive control: workspace fact's event surfaces at workspace widening.
    expect((await knowledgeEntityIds('workspace')).has(String(ws.id))).toBe(true);
  });

  // ── MAJOR: insertPlaybook persists a non-private visibility_class ────────────

  it('MAJOR: insertPlaybook round-trips a non-private visibility_class (was dropped → private)', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    const wsPb = await adapter.insertPlaybook({
      ...s,
      visibility_class: 'workspace',
      title: 'ws playbook',
      description: 'workspace-scoped guide',
      instructions: 'do the thing',
    });
    const tenantPb = await adapter.insertPlaybook({
      ...s,
      visibility_class: 'tenant',
      title: 'tenant playbook',
      description: 'tenant-wide guide',
      instructions: 'do the other thing',
    });
    // A dropped column would read back the DEFAULT 'private'.
    expect(wsPb.visibility_class).toBe('workspace');
    expect(tenantPb.visibility_class).toBe('tenant');
    expect((await adapter.getPlaybookById(wsPb.id))?.visibility_class).toBe('workspace');
    expect((await adapter.getPlaybookById(tenantPb.id))?.visibility_class).toBe('tenant');
  });

  // ── F2-class: to_tsquery empty-input guard (empty / punctuation / CJK) ───────

  it('F2-class: empty / punctuation-only / non-Latin queries return [] without erroring', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    // Seed at least one matchable row so a NON-empty query is meaningful.
    await adapter.insertTurn({
      ...s,
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'searchable turn content',
    });
    await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'searchable knowledge fact',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    await adapter.insertPlaybook({
      ...s,
      title: 'searchable playbook',
      description: 'searchable',
      instructions: 'searchable steps',
    });

    // Each of these tokenizes to '' — to_tsquery('english','') errors on some PG
    // majors, so the guard must return [] BEFORE the DB call (no throw).
    for (const q of ['', '   ', '??', '.,;:!', '你好世界']) {
      expect(await adapter.searchTurns(s, q)).toEqual([]);
      expect(await adapter.searchKnowledge(s, q)).toEqual([]);
      expect(await adapter.searchKnowledgeCrossScope(s, 'tenant', q)).toEqual([]);
      expect(await adapter.searchPlaybooks(s, q)).toEqual([]);
      expect(await adapter.searchPlaybooksCrossScope(s, 'tenant', q)).toEqual([]);
    }
    // Sanity: a real token still returns the seeded rows (guard didn't over-fire).
    expect((await adapter.searchKnowledge(s, 'searchable')).length).toBeGreaterThan(0);
  });

  // ── F5: caller created_at is integer-coerced (float → floor seconds) ─────────

  it('F5: a float created_at is coerced to integer seconds (no 22P02 on INTEGER column)', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    const floatTs = 1_600_000_123.7;
    const k = await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'float-timestamped fact',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      created_at: floatTs,
    });
    expect(k.created_at).toBe(1_600_000_123);
    expect(Number.isInteger(k.created_at)).toBe(true);
    expect((await adapter.getKnowledgeMemoryById(k.id))?.created_at).toBe(1_600_000_123);

    const pb = await adapter.insertPlaybook({
      ...s,
      title: 'float pb',
      description: 'd',
      instructions: 'i',
      created_at: floatTs,
    });
    expect(pb.created_at).toBe(1_600_000_123);
    expect(pb.updated_at).toBe(1_600_000_123);
    expect((await adapter.getPlaybookById(pb.id))?.created_at).toBe(1_600_000_123);
  });

  // ── F5: caller created_at round-trips as an integer on insertKnowledgeMemory ─

  it('F5: insertKnowledgeMemory honors an integer caller created_at', async () => {
    const { adapter } = await prepareAdapter();
    const s = scopeIn('ws1');
    const k = await adapter.insertKnowledgeMemory({
      ...s,
      fact: 'backdated import fact',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
      created_at: 1_600_000_321,
    });
    expect(k.created_at).toBe(1_600_000_321);
    expect((await adapter.getKnowledgeMemoryById(k.id))?.created_at).toBe(1_600_000_321);
  });

  // ── minor: unknown visibility_class fails OPEN to its own scope (not vanish) ─

  it('minor: an unknown visibility_class is visible in its own scope but not cross-scope', async () => {
    const { adapter, pool } = await prepareAdapter();
    const owner = scopeIn('wsX', { sys: 'sysA', scopeId: 'owner' });
    const reader = scopeIn('wsY', { sys: 'sysB', scopeId: 'reader' });
    // Seed a row with a garbage visibility_class the type system can't express,
    // via raw SQL, to exercise the fail-open-to-own-scope fallback.
    const { rows } = await pool.query(
      `INSERT INTO knowledge_memory
         (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type,
          knowledge_state, knowledge_class, source, confidence, confidence_score, trust_score,
          created_at, last_accessed_at, visibility_class)
       VALUES ($1,$2,$3,$4,$5,$6,'reference','trusted','project_fact','user_stated','high',0.5,0.5,
               $7,$7,'weird_unknown_class')
       RETURNING id`,
      [owner.tenant_id, owner.system_id, owner.workspace_id, owner.collaboration_id,
       owner.scope_id, 'unknown-class fact', 1_600_000_400],
    );
    const id = Number(rows[0].id);
    // Own scope (scope level): the row must still surface (fail-open, like private).
    const own = await adapter.getActiveKnowledgeCrossScope(owner, 'scope');
    expect(own.some((k) => k.id === id)).toBe(true);
    // A different scope widening to tenant must NOT see it (treated as private).
    const cross = await adapter.getActiveKnowledgeCrossScope(reader, 'tenant');
    expect(cross.some((k) => k.id === id)).toBe(false);
  });
});
