/**
 * Postgres integration tests.
 *
 * These tests apply the actual `src/adapters/postgres/schema.sql` against a
 * real Postgres database and exercise the Phase 1-3 adapter surface end to
 * end. They are the only path that catches schema/adapter drift that would
 * otherwise only surface in production.
 *
 * The suite is gated on a `POSTGRES_TEST_URL` environment variable so the
 * default test run stays fast and offline. To enable it:
 *
 *     POSTGRES_TEST_URL=postgres://user:pass@localhost:5432/dbname \
 *       npm run test -- src/__tests__/postgres-integration.test.ts
 *
 * or via the convenience script:
 *
 *     POSTGRES_TEST_URL=... npm run test:postgres
 *
 * Each `it()` block runs inside a unique throwaway schema so the tests are
 * isolated from each other and from any pre-existing data in the target
 * database. Schemas are dropped in `afterEach` regardless of outcome.
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
    '[postgres-integration] POSTGRES_TEST_URL not set — skipping. ' +
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
  const root = findProjectRoot();
  return readFileSync(path.join(root, 'src/adapters/postgres/schema.sql'), 'utf8');
}

function scope(schemaName: string): MemoryScope {
  return {
    tenant_id: 'itest',
    system_id: 'postgres',
    workspace_id: schemaName,
    scope_id: 'session-1',
  };
}

describeIntegration('Postgres integration — schema + adapter parity', () => {
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

  async function prepareSchema(options: { applySchema?: boolean } = {}): Promise<{
    pool: InstanceType<typeof import('pg').Pool>;
    schemaName: string;
    schemaSql: string;
  }> {
    const schemaName = `memory_layer_itest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    // Bootstrap: create the schema on a one-shot pool first so we can then
    // open the real pool with the schema in the connection-string options.
    const bootstrapPool = new pg.Pool({ connectionString: POSTGRES_TEST_URL });
    try {
      await bootstrapPool.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      await bootstrapPool.end();
    }

    // Every client from this pool inherits search_path via Postgres
    // connection options, avoiding the pg `connect` hook pattern (which
    // emits a deprecation warning when the hook query overlaps with the
    // first user query).
    const baseUrl = new URL(POSTGRES_TEST_URL!);
    baseUrl.searchParams.set('options', `-c search_path=${schemaName},public`);
    const pool = new pg.Pool({ connectionString: baseUrl.toString() });
    poolRef = pool;
    currentSchema = schemaName;

    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    const schemaSql = loadSchemaSql();
    if (options.applySchema ?? true) {
      await pool.query(schemaSql);
    }
    return { pool, schemaName, schemaSql };
  }

  it('applies schema.sql to a fresh schema and records version history', async () => {
    const { pool, schemaName } = await prepareSchema();
    const versions = await pool.query('SELECT version FROM schema_version ORDER BY version');
    const recorded = versions.rows.map((r: { version: number }) => r.version);
    // v1 must be present; v9-v12 must be recorded after the migration inserts.
    expect(recorded).toContain(1);
    expect(recorded).toContain(9);
    expect(recorded).toContain(10);
    expect(recorded).toContain(11);
    expect(recorded).toContain(12);
    expect(schemaName).toBeTruthy();
  });

  it('applies schema.sql twice without error (idempotent)', async () => {
    const { pool, schemaSql } = await prepareSchema();
    // Second application must not throw.
    await expect(pool.query(schemaSql)).resolves.toBeDefined();
    // And must not duplicate version rows.
    const versions = await pool.query('SELECT version, COUNT(*) AS n FROM schema_version GROUP BY version');
    for (const row of versions.rows as Array<{ version: number; n: string }>) {
      expect(Number(row.n)).toBe(1);
    }
  });

  it('inserts turns and knowledge with every column the adapter writes', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    // Turn insert exercises the `priority` column that was missing pre-v12.
    const turn = await adapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'deploy the api to staging',
      priority: 2.5,
    });
    expect(turn.id).toBeGreaterThan(0);
    expect(turn.priority).toBe(2.5);

    // Knowledge insert exercises all the v12 parity columns
    // (knowledge_state, knowledge_class, trust_score, source_turn_ids, etc).
    const knowledge = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'the staging environment runs on port 8080',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      knowledge_state: 'trusted',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.9,
      source_turn_ids: [turn.id],
    });
    expect(knowledge.id).toBeGreaterThan(0);
    expect(knowledge.knowledge_state).toBe('trusted');
    expect(knowledge.knowledge_class).toBe('project_fact');
    expect(knowledge.trust_score).toBe(0.9);
    expect(knowledge.source_turn_ids).toEqual([turn.id]);
  });

  it('accepts low-confidence knowledge and boolean candidate source flags', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const turn = await adapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'Document the rollback checklist',
    });
    const workingMemory = await adapter.insertWorkingMemory({
      ...scope(schemaName),
      session_id: 'session-1',
      summary: 'Rollback prep summary',
      key_entities: ['rollback'],
      topic_tags: ['deploy'],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'manual',
    });

    const knowledge = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'Rollback verification is still provisional',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'low',
    });
    const candidate = await adapter.insertKnowledgeCandidate({
      ...scope(schemaName),
      working_memory_id: workingMemory.id,
      fact: 'Rollback checklist needs approver sign-off',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      normalized_fact: 'rollback checklist needs approver sign-off',
      confidence: 'low',
      source_summary: true,
      source_turns: false,
    });

    expect(knowledge.confidence).toBe('low');
    expect(candidate.confidence).toBe('low');
    expect(candidate.source_summary).toBe(true);
    expect(candidate.source_turns).toBe(false);
  });

  it('turn + knowledge FTS search uses correct placeholder binding', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    await adapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'deploy staging pipeline',
    });
    await adapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'review the billing module',
    });
    await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'staging deployments require a health check',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });

    // This exercises the $6/$7 placeholder fix — before v12 the placeholders
    // were off-by-one and the query either errored or returned wrong rows.
    const turnHits = await adapter.searchTurns(scope(schemaName), 'staging');
    expect(turnHits.length).toBeGreaterThan(0);
    expect(turnHits[0].item.content).toContain('staging');

    const knowledgeHits = await adapter.searchKnowledge(scope(schemaName), 'staging');
    expect(knowledgeHits.length).toBeGreaterThan(0);
    expect(knowledgeHits[0].item.fact).toContain('staging');
  });

  it('playbook insert + FTS search round-trip works', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const playbook = await adapter.insertPlaybook({
      ...scope(schemaName),
      title: 'Deploy to staging',
      description: 'Deploy current branch',
      instructions: '1. tests\n2. push\n3. verify',
      tags: ['deploy'],
    });
    expect(playbook.id).toBeGreaterThan(0);

    const hits = await adapter.searchPlaybooks(scope(schemaName), 'deploy');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.title).toBe('Deploy to staging');
  });

  it('association insert enforces unique constraint via UniqueConstraintError', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const a = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'Fact A',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const b = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'Fact B',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });

    const assoc = await adapter.insertAssociation({
      ...scope(schemaName),
      source_kind: 'knowledge',
      source_id: a.id,
      target_kind: 'knowledge',
      target_id: b.id,
      association_type: 'related_to',
    });
    expect(assoc.id).toBeGreaterThan(0);

    // Second insert of the same edge must throw a UniqueConstraintError
    // (not a generic Error) so autoDetectAssociations can safely ignore it.
    const { UniqueConstraintError } = await import('../contracts/storage.js');
    await expect(
      adapter.insertAssociation({
        ...scope(schemaName),
        source_kind: 'knowledge',
        source_id: a.id,
        target_kind: 'knowledge',
        target_id: b.id,
        association_type: 'related_to',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('getAssociationById finds in-scope records for removeAssociation path', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const a = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'src',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const b = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'tgt',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const assoc = await adapter.insertAssociation({
      ...scope(schemaName),
      source_kind: 'knowledge',
      source_id: a.id,
      target_kind: 'knowledge',
      target_id: b.id,
      association_type: 'supports',
    });

    const fetched = await adapter.getAssociationById(assoc.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(assoc.id);
    expect(fetched?.tenant_id).toBe(scope(schemaName).tenant_id);

    await adapter.deleteAssociation(assoc.id);
    const afterDelete = await adapter.getAssociationById(assoc.id);
    expect(afterDelete).toBeNull();
  });

  it('working_memory includes episode_recap column (v10 migration)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'working_memory'
         AND column_name = 'episode_recap'`,
      [schemaName],
    );
    expect(result.rows.length).toBe(1);
  });

  it('knowledge_memory includes every v12 parity column', async () => {
    const { pool, schemaName } = await prepareSchema();
    const required = [
      'knowledge_state',
      'knowledge_class',
      'confidence_score',
      'grounding_strength',
      'evidence_count',
      'trust_score',
      'verification_status',
      'verification_notes',
      'last_verified_at',
      'next_reverification_at',
      'last_confirmed_at',
      'confirmation_count',
      'source_turn_ids',
      'successful_use_count',
      'failed_use_count',
      'disputed_at',
      'dispute_reason',
      'contradiction_score',
      'superseded_at',
      'last_accessed_at',
      'access_count',
    ];
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'knowledge_memory'`,
      [schemaName],
    );
    const present = new Set(result.rows.map((r: { column_name: string }) => r.column_name));
    for (const col of required) {
      expect(present.has(col), `knowledge_memory missing column: ${col}`).toBe(true);
    }
  });

  it('knowledge_candidate and knowledge_evidence tables exist', async () => {
    const { pool, schemaName } = await prepareSchema();
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1`,
      [schemaName],
    );
    const tables = new Set(result.rows.map((r: { table_name: string }) => r.table_name));
    expect(tables.has('knowledge_candidate')).toBe(true);
    expect(tables.has('knowledge_evidence')).toBe(true);
    expect(tables.has('playbooks')).toBe(true);
    expect(tables.has('playbook_revisions')).toBe(true);
    expect(tables.has('associations')).toBe(true);
  });

  it('stores candidate source flags as booleans in fresh schemas', async () => {
    const { pool, schemaName } = await prepareSchema();
    const result = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'knowledge_candidate'
         AND column_name IN ('source_summary', 'source_turns')`,
      [schemaName],
    );
    const dataTypes = new Map(
      result.rows.map((row: { column_name: string; data_type: string }) => [row.column_name, row.data_type]),
    );

    expect(dataTypes.get('source_summary')).toBe('boolean');
    expect(dataTypes.get('source_turns')).toBe('boolean');
  });

  // ---------------------------------------------------------------------------
  // Phase 0 remediation regression tests (Postgres group)
  // ---------------------------------------------------------------------------

  function actor(id: string) {
    return {
      actor_kind: 'agent' as const,
      actor_id: id,
      system_id: null,
      display_name: null,
      metadata: null,
    };
  }

  // Plan 0.2 — concurrent claim race: N parallel claimWorkItem calls on one
  // item must yield exactly 1 success and N-1 ConflictError. Pre-fix, the
  // unguarded ON CONFLICT DO UPDATE let a second committer silently steal an
  // active claim, so multiple calls would succeed.
  it('0.2 concurrent claimWorkItem on one item → exactly one success', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const { ConflictError } = await import('../contracts/errors.js');

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'contended work item',
    });

    const N = 8;
    const claimedAt = Math.floor(Date.now() / 1000);
    const attempts = Array.from({ length: N }, (_, i) =>
      adapter.claimWorkItem({
        ...scope(schemaName),
        work_item_id: item.id,
        actor: actor(`agent-${i}`),
        lease_seconds: 300,
        visibility_class: 'private',
        claimed_at: claimedAt,
      }),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(N - 1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }

    // Exactly one active claim row survives.
    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM work_claims_current WHERE work_item_id = $1 AND status = 'active'`,
      [item.id],
    );
    expect(active.rows[0].n).toBe(1);
  });

  // Plan 0.2 (race fix) — concurrent claim on an item whose prior claim is
  // active-but-expired. Pre-fix each racer's stale pre-SELECT triggered an
  // unguarded expireClaimRecord that stomped the claim a concurrent racer had
  // legitimately won, so ALL N racers could succeed with N bogus
  // work_claim.expired events. The guarded UPDATE makes rowCount the authority:
  // exactly one expire + one winner.
  it('0.2 concurrent claimWorkItem on expired-claim item → one success, one expire event', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const { ConflictError } = await import('../contracts/errors.js');

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'expired-claim work item',
    });

    // Seed an active-but-expired claim (claimed in the past, already lapsed).
    const past = Math.floor(Date.now() / 1000) - 1000;
    const priorClaim = await adapter.claimWorkItem({
      ...scope(schemaName),
      work_item_id: item.id,
      actor: actor('prior-owner'),
      lease_seconds: 300,
      visibility_class: 'private',
      claimed_at: past,
    });
    // Sanity: the seeded claim is active but its expiry is in the past.
    expect(priorClaim.status).toBe('active');
    expect(priorClaim.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    const N = 8;
    const claimedAt = Math.floor(Date.now() / 1000);
    const attempts = Array.from({ length: N }, (_, i) =>
      adapter.claimWorkItem({
        ...scope(schemaName),
        work_item_id: item.id,
        actor: actor(`agent-${i}`),
        lease_seconds: 300,
        visibility_class: 'private',
        claimed_at: claimedAt,
      }),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(N - 1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }

    // Exactly one active claim row survives.
    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM work_claims_current WHERE work_item_id = $1 AND status = 'active'`,
      [item.id],
    );
    expect(active.rows[0].n).toBe(1);

    // Exactly one work_claim.expired event was appended (not N bogus ones).
    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'work_claim' AND event_type = 'work_claim.expired'
         AND entity_id = $1`,
      [String(priorClaim.id)],
    );
    expect(expiredEvents.rows[0].n).toBe(1);
  });

  // Plan 0.4 — search must default activeOnly to true so superseded/retired
  // records are excluded unless activeOnly:false is passed. Pre-fix, undefined
  // was treated as false and superseded facts leaked into default search.
  it('0.4 searchKnowledge defaults to activeOnly (superseded excluded)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const oldFact = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'the deploy target is the alpha cluster',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const newFact = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'the deploy target is the beta cluster',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    await adapter.supersedeKnowledgeMemory(oldFact.id, newFact.id);

    // Default (no options): superseded fact must be absent.
    const defaultHits = await adapter.searchKnowledge(scope(schemaName), 'alpha cluster');
    expect(defaultHits.some((h) => h.item.id === oldFact.id)).toBe(false);

    // activeOnly:false: superseded fact must be present.
    const allHits = await adapter.searchKnowledge(scope(schemaName), 'alpha cluster', {
      activeOnly: false,
    });
    expect(allHits.some((h) => h.item.id === oldFact.id)).toBe(true);
  });

  it('0.4 searchTurns defaults to activeOnly (archived excluded)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const turn = await adapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'provision the gamma database',
    });
    await adapter.archiveTurn(turn.id, Math.floor(Date.now() / 1000), null);

    const defaultHits = await adapter.searchTurns(scope(schemaName), 'gamma database');
    expect(defaultHits.some((h) => h.item.id === turn.id)).toBe(false);

    const allHits = await adapter.searchTurns(scope(schemaName), 'gamma database', {
      activeOnly: false,
    });
    expect(allHits.some((h) => h.item.id === turn.id)).toBe(true);
  });

  // Plan 0.5 — scoped deleteEmbedding must actually delete. Pre-fix the scope
  // clause compared tenant_id against the knowledge id ($1) and matched
  // nothing, so the delete was a silent no-op.
  it('0.5 scoped deleteEmbedding removes the embedding', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    // Embedding methods live on the embedding adapter, not the core adapter.
    const embeddings = createPostgresEmbeddingAdapter(pool);

    const km = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'embedding delete target',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const vector = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    await embeddings.storeEmbedding(km.id, vector);

    // Present before delete.
    const before = await embeddings.findSimilar(scope(schemaName), vector, { limit: 10 });
    expect(before.some((r) => r.knowledgeMemoryId === km.id)).toBe(true);

    // Scoped delete must remove it.
    await embeddings.deleteEmbedding(km.id, scope(schemaName));

    const after = await embeddings.findSimilar(scope(schemaName), vector, { limit: 10 });
    expect(after.some((r) => r.knowledgeMemoryId === km.id)).toBe(false);

    const rowCheck = await pool.query(
      'SELECT COUNT(*)::int AS n FROM knowledge_embeddings WHERE knowledge_memory_id = $1',
      [km.id],
    );
    expect(rowCheck.rows[0].n).toBe(0);
  });

  // Plan 0.7 — optimistic locking: two parallel updateWorkItem calls with the
  // same expectedVersion must yield exactly one success. Pre-fix the version
  // check was a check-then-write against a stale SELECT, so both could win.
  it('0.7 concurrent updateWorkItem with same expectedVersion → one success', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const { ConflictError } = await import('../contracts/errors.js');

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'versioned item',
    });
    expect(item.version).toBeDefined();
    const expectedVersion = item.version;

    const attempts = [
      adapter.updateWorkItem(item.id, { title: 'update A' }, { expectedVersion }),
      adapter.updateWorkItem(item.id, { title: 'update B' }, { expectedVersion }),
    ];

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // Version advanced by exactly one.
    const check = await pool.query('SELECT version FROM work_items WHERE id = $1', [item.id]);
    expect(Number(check.rows[0].version)).toBe(Number(expectedVersion) + 1);
  });
});
