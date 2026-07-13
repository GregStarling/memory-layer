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
import { ensurePgVectorExtension } from './helpers/verification-harness.js';

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
      // Pin pgvector to public (see ensurePgVectorExtension) — installing it
      // via the search_path'd pool put it in the ephemeral schema, and the
      // teardown CASCADE dropped it for concurrently-running test files.
      await ensurePgVectorExtension(bootstrapPool);
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

  // ==========================================================================
  // Phase 2 — data-integrity: atomic mutation+event, promotion atomicity,
  // event-cursor ordering, embedding versioning/HNSW, lazy lease expiry.
  // ==========================================================================

  // A pool wrapper that lets a test inject a failure on the Nth statement whose
  // SQL matches a predicate. It wraps BOTH pool.query and the per-connection
  // client returned by pool.connect(), because inside this.transaction() every
  // statement routes through the acquired client, not the pool.
  function faultInjectingPool(
    real: InstanceType<typeof import('pg').Pool>,
    shouldFail: (sql: string) => boolean,
  ) {
    let armed = true;
    const maybeThrow = (sql: string) => {
      if (armed && shouldFail(sql)) {
        armed = false;
        throw new Error('injected fault');
      }
    };
    const wrapClient = (client: { query: Function; release: Function }) =>
      new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === 'query') {
            return (text: string, values?: unknown[]) => {
              maybeThrow(text);
              return (target.query as Function)(text, values);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (text: string, values?: unknown[]) => {
            maybeThrow(text);
            return (target.query as Function)(text, values);
          };
        }
        if (prop === 'connect') {
          return async () => {
            const client = await (target.connect as Function)();
            return wrapClient(client);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as InstanceType<typeof import('pg').Pool>;
  }

  // Plan 2.1 — atomic mutation+event. When the event insert throws, the whole
  // primitive rolls back inside its BEGIN/COMMIT: no orphaned knowledge row and
  // no orphaned event. Pre-fix the row-write and event-write could land on
  // different pooled connections and half-commit.
  it('2.1 fault on event insert rolls back the row (no orphan row/event)', async () => {
    const { pool, schemaName } = await prepareSchema();
    // Fail the FIRST insert into memory_event_log (the knowledge.created event).
    const faulted = faultInjectingPool(pool, (sql) =>
      /INSERT INTO memory_event_log/i.test(sql),
    );
    const adapter = createPostgresAdapter(faulted, { ownsPool: false });

    await expect(
      adapter.insertKnowledgeMemory({
        ...scope(schemaName),
        fact: 'this insert must roll back entirely',
        fact_type: 'reference',
        source: 'user_stated',
        confidence: 'high',
      }),
    ).rejects.toThrow(/injected fault/);

    // Row must NOT exist (rolled back with the failed event).
    const km = await pool.query(
      `SELECT COUNT(*)::int AS n FROM knowledge_memory WHERE fact = $1`,
      ['this insert must roll back entirely'],
    );
    expect(km.rows[0].n).toBe(0);
    // No event either.
    const ev = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log WHERE entity_kind = 'knowledge_memory'`,
    );
    expect(ev.rows[0].n).toBe(0);
  });

  // Plan 2.2 — promotion atomicity + candidate lifecycle events. The candidate
  // flip, the knowledge insert, and BOTH events (knowledge.created +
  // knowledge_candidate.promoted) are one transaction.
  it('2.2 promoteKnowledgeCandidate is atomic and emits candidate events', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const turn = await adapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'seed',
    });
    const wm = await adapter.insertWorkingMemory({
      ...scope(schemaName),
      session_id: 'session-1',
      summary: 'sum',
      key_entities: [],
      topic_tags: [],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'manual',
    });
    const candidate = await adapter.insertKnowledgeCandidate({
      ...scope(schemaName),
      working_memory_id: wm.id,
      fact: 'promote me',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      normalized_fact: 'promote me',
      confidence: 'high',
    });

    // knowledge_candidate.created was emitted on insert.
    const created = await adapter.getMemoryEventsByEntity(
      scope(schemaName),
      'knowledge_candidate',
      String(candidate.id),
    );
    expect(created.events.some((e) => e.event_type === 'knowledge_candidate.created')).toBe(true);

    const knowledge = await adapter.promoteKnowledgeCandidate(candidate.id, {
      ...scope(schemaName),
      fact: 'promote me',
      fact_type: 'reference',
      source: 'promoted_from_working',
      confidence: 'high',
    });
    expect(knowledge.id).toBeGreaterThan(0);

    // Candidate flipped to provisional + linked.
    const after = await adapter.getKnowledgeCandidateById(candidate.id);
    expect(after?.state).toBe('provisional');
    expect(after?.promoted_knowledge_id).toBe(knowledge.id);

    // knowledge_candidate.promoted event exists.
    const promotedEvents = await adapter.getMemoryEventsByEntity(
      scope(schemaName),
      'knowledge_candidate',
      String(candidate.id),
    );
    expect(promotedEvents.events.some((e) => e.event_type === 'knowledge_candidate.promoted')).toBe(
      true,
    );
  });

  // Plan 2.2 — source_document lifecycle events.
  it('2.2 source document insert/update emit source_document events', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const doc = await adapter.insertSourceDocument({
      ...scope(schemaName),
      title: 'runbook',
      content_hash: 'hash-1',
      mime_type: 'text/markdown',
    });
    await adapter.updateSourceDocument(doc.id, { status: 'processed', fact_count: 3 });

    const events = await adapter.getMemoryEventsByEntity(
      scope(schemaName),
      'source_document',
      String(doc.id),
    );
    const types = events.events.map((e) => e.event_type);
    expect(types).toContain('source_document.created');
    expect(types).toContain('source_document.updated');
  });

  // Plan 2.3 — event pagination cursor correctness. Ordering is event_id ASC
  // alone; the cursor is event_id > N. Backdated created_at values must not
  // cause skips or repeats. Pre-fix, ORDER BY (created_at, event_id) with an
  // event_id-only cursor skipped/repeated rows whose timestamps were backdated.
  it('2.3 paging with backdated created_at yields no skips or repeats', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    // Insert 6 events with DESCENDING created_at (later event_id = earlier time)
    // so any created_at-based ordering would disagree with event_id order.
    const total = 6;
    for (let i = 0; i < total; i++) {
      await adapter.insertMemoryEvent({
        ...scope(schemaName),
        entity_kind: 'work_item',
        entity_id: String(1000 + i),
        event_type: 'work_item.created',
        payload: { seq: i },
        created_at: 5_000_000 - i * 10, // backdated, strictly decreasing
      });
    }

    // Page through 2 at a time using the returned cursor.
    const seen: string[] = [];
    let cursor: string | number | undefined = undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await adapter.listMemoryEvents(scope(schemaName), {
        limit: 2,
        cursor,
      });
      for (const e of page.events) seen.push(e.event_id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Every event exactly once, in strictly ascending event_id order.
    expect(seen.length).toBe(total);
    const unique = new Set(seen);
    expect(unique.size).toBe(total);
    const asBig = seen.map((id) => BigInt(id));
    for (let i = 1; i < asBig.length; i++) {
      expect(asBig[i] > asBig[i - 1]).toBe(true);
    }
  });

  // Plan 2.4(a) — lazy per-dimension HNSW index. After storing vectors of a
  // given dimension, pg_indexes must contain emb_hnsw_<dims>.
  it('2.4 storing vectors creates a per-dimension HNSW index', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const embeddings = createPostgresEmbeddingAdapter(pool);

    const km = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'hnsw target',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    await embeddings.storeEmbedding(km.id, vec, { model: 'test-model', dimensions: 4 });

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'knowledge_embeddings' AND indexname = 'emb_hnsw_4'`,
      [schemaName],
    );
    expect(idx.rows.length).toBe(1);
  });

  // Plan 2.4(b) — mixed dimensions coexist and findSimilar succeeds filtering to
  // the active dims. This exact scenario used to throw "different vector
  // dimensions" because a 4-dim query vector was distance-compared against a
  // 3-dim stored vector.
  it('2.4 mixed-dimension rows coexist; findSimilar filters to active dims', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const embeddings = createPostgresEmbeddingAdapter(pool);

    const kmOld = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'old 3-dim fact',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    const kmNew = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'new 4-dim fact',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    await embeddings.storeEmbedding(kmOld.id, new Float32Array([1, 0, 0]), {
      model: 'old-model',
      dimensions: 3,
    });
    await embeddings.storeEmbedding(kmNew.id, new Float32Array([1, 0, 0, 0]), {
      model: 'new-model',
      dimensions: 4,
    });

    // Query with a 4-dim vector filtering to dimensions=4: must succeed (no
    // dimension-mismatch error) and return ONLY the 4-dim row.
    const results = await embeddings.findSimilar(scope(schemaName), new Float32Array([1, 0, 0, 0]), {
      limit: 10,
      filter: { dimensions: 4, model: 'new-model' },
    });
    const ids = results.map((r) => r.knowledgeMemoryId);
    expect(ids).toContain(kmNew.id);
    expect(ids).not.toContain(kmOld.id);
  });

  // Plan 2.4(b) — coverage diagnostics. With all stored vectors mismatched to
  // the active dims, coverage reports total>0 and matching=0.
  it('2.4 getEmbeddingCoverage reports mismatch against active provider', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const embeddings = createPostgresEmbeddingAdapter(pool);

    const km = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'coverage fact',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });
    await embeddings.storeEmbedding(km.id, new Float32Array([1, 0, 0]), {
      model: 'old-model',
      dimensions: 3,
    });

    const coverage = await embeddings.getEmbeddingCoverage!(scope(schemaName), { dimensions: 4 });
    expect(coverage.total).toBe(1);
    expect(coverage.matching).toBe(0);
    expect(coverage.mismatched).toBe(1);
  });

  // Plan 2.4(c) — EXPLAIN should reference the partial index for a dim-filtered
  // similarity query. On tiny data the planner may prefer a seq scan; in that
  // case we assert the index exists and the query returns correct results
  // (best-effort, per the plan).
  it('2.4 similarity query can use the partial HNSW index (best-effort)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const embeddings = createPostgresEmbeddingAdapter(pool);

    // Store several 4-dim vectors so the index has content.
    for (let i = 0; i < 5; i++) {
      const km = await adapter.insertKnowledgeMemory({
        ...scope(schemaName),
        fact: `vec ${i}`,
        fact_type: 'reference',
        source: 'user_stated',
        confidence: 'high',
      });
      await embeddings.storeEmbedding(km.id, new Float32Array([i / 5, 0, 0, 1 - i / 5]), {
        model: 'm',
        dimensions: 4,
      });
    }

    // The EXPLAIN mirrors the ACTUAL expression the adapter now emits for a
    // dims-filtered query: both operands cast to vector(4) and the dimension
    // inlined as a literal, so the ORDER BY expression is textually identical to
    // the partial index expression ((embedding::vector(4)) vector_cosine_ops
    // WHERE dimensions = 4). Pre-fix the adapter ordered by the un-cast column
    // (`ke.embedding <=>`), which never matched the index expression → seq scan.
    const explain = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT ke.knowledge_memory_id, 1 - ((ke.embedding::vector(4)) <=> '[0.1,0,0,0.9]'::vector(4)) AS similarity
       FROM knowledge_embeddings ke
       WHERE ke.dimensions = 4
       ORDER BY (ke.embedding::vector(4)) <=> '[0.1,0,0,0.9]'::vector(4) ASC
       LIMIT 3`,
    );
    const plan = explain.rows.map((r: Record<string, unknown>) => Object.values(r)[0]).join('\n');

    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'emb_hnsw_4'`,
      [schemaName],
    );
    // Either the planner picked the index, or (on tiny data) it did not — in
    // which case the index must at least exist and results must be correct.
    if (/emb_hnsw_4/.test(plan)) {
      expect(/emb_hnsw_4/.test(plan)).toBe(true);
    } else {
      expect(idx.rows.length).toBe(1);
      const results = await embeddings.findSimilar(
        scope(schemaName),
        new Float32Array([0.1, 0, 0, 0.9]),
        { limit: 3, filter: { dimensions: 4 } },
      );
      expect(results.length).toBeGreaterThan(0);
    }
  });

  // Plan 2.5 — reads never write. Listing an expired claim must not emit a
  // work_claim.expired event nor mutate the row; effective status is computed.
  it('2.5 listing/reading an expired claim writes nothing', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'expiry read item',
    });
    const claimedAt = Math.floor(Date.now() / 1000) - 1000;
    await adapter.claimWorkItem({
      ...scope(schemaName),
      work_item_id: item.id,
      actor: actor('agent-a'),
      lease_seconds: 1, // expires_at = claimedAt + 1, already in the past
      visibility_class: 'private',
      claimed_at: claimedAt,
    });

    // Two concurrent reads of an expired claim.
    await Promise.all([
      adapter.listWorkClaims(scope(schemaName), { includeExpired: true }),
      adapter.getActiveWorkClaim(item.id),
      adapter.listWorkClaims(scope(schemaName), { includeExpired: true }),
    ]);

    // The stored row is untouched: still status='active' in the table.
    const row = await pool.query(
      `SELECT status FROM work_claims_current WHERE work_item_id = $1`,
      [item.id],
    );
    expect(row.rows[0].status).toBe('active');
    // No expiry event was emitted by reads.
    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'work_claim' AND event_type = 'work_claim.expired'`,
    );
    expect(expiredEvents.rows[0].n).toBe(0);

    // But effective status seen by the read is 'expired'.
    const effective = await adapter.getActiveWorkClaim(item.id);
    expect(effective).toBeNull();
  });

  // Plan 2.5 — concurrent expireStaleClaims + claimWorkItem: no double events,
  // exactly one winner. The reaper's self-guarding UPDATE + FOR UPDATE SKIP
  // LOCKED, and claimWorkItem's guarded upsert, resolve the race.
  it('2.5 concurrent expireStaleClaims + claimWorkItem → one winner, one event', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'reaper race item',
    });
    const claimedAt = Math.floor(Date.now() / 1000) - 1000;
    const priorClaim = await adapter.claimWorkItem({
      ...scope(schemaName),
      work_item_id: item.id,
      actor: actor('agent-a'),
      lease_seconds: 1,
      visibility_class: 'private',
      claimed_at: claimedAt,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    // Race the reaper against a fresh claim by a different actor.
    const [reaped, reclaimed] = await Promise.all([
      adapter.expireStaleClaims(scope(schemaName), nowSec),
      adapter
        .claimWorkItem({
          ...scope(schemaName),
          work_item_id: item.id,
          actor: actor('agent-b'),
          lease_seconds: 300,
          visibility_class: 'private',
          claimed_at: nowSec,
        })
        .catch(() => null),
    ]);
    void reaped;

    // Positive winner (finding 10): the prior claim was EXPIRED, so agent-b's
    // reclaim must succeed regardless of interleaving — asserting only `<=1`
    // would also pass if both raced to a no-op and left the stale row behind.
    expect(reclaimed).not.toBeNull();

    // Exactly one active claim row survives, and it belongs to agent-b (forward
    // progress, not the abandoned stale row). Never two active rows.
    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM work_claims_current WHERE work_item_id = $1 AND status = 'active'`,
      [item.id],
    );
    expect(active.rows[0].n).toBe(1);
    const owner = await pool.query(
      `SELECT actor_id FROM work_claims_current WHERE work_item_id = $1 AND status = 'active'`,
      [item.id],
    );
    expect(owner.rows[0].actor_id).toBe('agent-b');

    // Exactly one work_claim.expired event for the ORIGINAL claim (the guarded
    // UPDATE makes rowCount the authority — never a double-emission, and the
    // takeover/reaper expires it exactly once).
    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'work_claim' AND event_type = 'work_claim.expired'
         AND entity_id = $1`,
      [String(priorClaim.id)],
    );
    expect(expiredEvents.rows[0].n).toBe(1);
  });

  // Plan 2.2 (finding 10) — promotion crash-BETWEEN: a fault on the candidate
  // state-flip UPDATE (after the knowledge insert, before the promoted event)
  // must roll the WHOLE promotion back. No knowledge row, no candidate flip, no
  // events — the candidate is still an un-promoted 'candidate'.
  it('2.2 promoteKnowledgeCandidate rolls back entirely on a mid-transaction fault', async () => {
    const { pool, schemaName } = await prepareSchema();
    const baseAdapter = createPostgresAdapter(pool);

    const turn = await baseAdapter.insertTurn({
      ...scope(schemaName),
      session_id: 'session-1',
      actor: 'user',
      role: 'user',
      content: 'seed',
    });
    const wm = await baseAdapter.insertWorkingMemory({
      ...scope(schemaName),
      session_id: 'session-1',
      summary: 'sum',
      key_entities: [],
      topic_tags: [],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'manual',
    });
    const candidate = await baseAdapter.insertKnowledgeCandidate({
      ...scope(schemaName),
      working_memory_id: wm.id,
      fact: 'crash-between fact',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      normalized_fact: 'crash-between fact',
      confidence: 'high',
    });

    // Fail the candidate state-flip UPDATE, which runs AFTER insertKnowledgeMemory
    // (row + knowledge.created event) but BEFORE the knowledge_candidate.promoted
    // event — the crash-between window.
    const faulted = faultInjectingPool(pool, (sql) =>
      /UPDATE knowledge_candidate SET promoted_knowledge_id/i.test(sql),
    );
    const adapter = createPostgresAdapter(faulted, { ownsPool: false });

    await expect(
      adapter.promoteKnowledgeCandidate(candidate.id, {
        ...scope(schemaName),
        fact: 'crash-between fact',
        fact_type: 'reference',
        source: 'promoted_from_working',
        confidence: 'high',
      }),
    ).rejects.toThrow(/injected fault/);

    // No knowledge row was left behind.
    const km = await pool.query(
      `SELECT COUNT(*)::int AS n FROM knowledge_memory WHERE fact = $1`,
      ['crash-between fact'],
    );
    expect(km.rows[0].n).toBe(0);
    // The candidate flip rolled back: still 'candidate', not linked.
    const after = await baseAdapter.getKnowledgeCandidateById(candidate.id);
    expect(after?.state).toBe('candidate');
    expect(after?.promoted_knowledge_id).toBeNull();
    // No promotion event, and no orphaned knowledge.created event.
    const promotedEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'knowledge_candidate' AND event_type = 'knowledge_candidate.promoted'`,
    );
    expect(promotedEvents.rows[0].n).toBe(0);
    const knowledgeEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log WHERE entity_kind = 'knowledge_memory'`,
    );
    expect(knowledgeEvents.rows[0].n).toBe(0);
  });

  // Plan 2.4 (finding 8) — storeEmbedding must reject a metadata.dimensions that
  // contradicts the actual vector length, since that column is the sole key for
  // the partial HNSW index and the vector(N) casts in findSimilar.
  it('2.4 storeEmbedding rejects metadata.dimensions that disagrees with the vector', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);
    const embeddings = createPostgresEmbeddingAdapter(pool);
    const { ValidationError } = await import('../contracts/errors.js');

    const km = await adapter.insertKnowledgeMemory({
      ...scope(schemaName),
      fact: 'lying dimensions',
      fact_type: 'reference',
      source: 'user_stated',
      confidence: 'high',
    });

    await expect(
      embeddings.storeEmbedding(km.id, new Float32Array([1, 0, 0, 0]), {
        model: 'm',
        dimensions: 3, // vector is 4-dim → contradiction
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing was written.
    const rowCheck = await pool.query(
      'SELECT COUNT(*)::int AS n FROM knowledge_embeddings WHERE knowledge_memory_id = $1',
      [km.id],
    );
    expect(rowCheck.rows[0].n).toBe(0);

    // The truthful path stores dimensions = vector.length.
    await embeddings.storeEmbedding(km.id, new Float32Array([1, 0, 0, 0]), { model: 'm' });
    const stored = await pool.query(
      'SELECT dimensions FROM knowledge_embeddings WHERE knowledge_memory_id = $1',
      [km.id],
    );
    expect(Number(stored.rows[0].dimensions)).toBe(4);
  });

  // Plan 2.5 / D5 — handoff list/by-id reads NEVER write. Two concurrent list
  // calls on a pending-but-expired handoff must emit ZERO handoff.expired and
  // leave the stored row untouched; effective status reads as 'expired'.
  it('2.5 listing/reading an expired handoff writes nothing (D5/D6)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'handoff read item',
    });
    const past = Math.floor(Date.now() / 1000) - 1000;
    const handoff = await adapter.createHandoff({
      ...scope(schemaName),
      work_item_id: item.id,
      session_id: 'session-1',
      from_actor: actor('agent-a'),
      to_actor: actor('agent-b'),
      summary: 'please take over',
      visibility_class: 'private',
      expires_at: past + 1, // already lapsed
    });

    // Concurrent reads across all three read paths.
    const [list1, byId, list2] = await Promise.all([
      adapter.listHandoffs(scope(schemaName)),
      adapter.getHandoffById(handoff.id),
      adapter.listHandoffs(scope(schemaName)),
    ]);

    // Effective status is 'expired' on every read path (D5 + D6 consistency).
    expect(list1.find((h) => h.id === handoff.id)?.status).toBe('expired');
    expect(list2.find((h) => h.id === handoff.id)?.status).toBe('expired');
    expect(byId?.status).toBe('expired');

    // The stored row is untouched (still 'pending' in the table).
    const row = await pool.query(`SELECT status FROM handoff_records WHERE id = $1`, [handoff.id]);
    expect(row.rows[0].status).toBe('pending');
    // No handoff.expired event was emitted by reads.
    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'handoff' AND event_type = 'handoff.expired'`,
    );
    expect(expiredEvents.rows[0].n).toBe(0);
  });

  // Plan 2.5 / D5 — the handoff reaper: expireStaleHandoffs durably expires a
  // pending-but-expired handoff, emitting EXACTLY ONE handoff.expired, and is
  // idempotent (a second call emits nothing).
  it('2.5 expireStaleHandoffs expires exactly once and is idempotent (D5)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'handoff reaper item',
    });
    const past = Math.floor(Date.now() / 1000) - 1000;
    const handoff = await adapter.createHandoff({
      ...scope(schemaName),
      work_item_id: item.id,
      session_id: 'session-1',
      from_actor: actor('agent-a'),
      to_actor: actor('agent-b'),
      summary: 'please take over',
      visibility_class: 'private',
      expires_at: past + 1,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const first = await adapter.expireStaleHandoffs(scope(schemaName), nowSec);
    expect(first).toEqual([handoff.id]);
    // Second call finds nothing to reap (idempotent).
    const second = await adapter.expireStaleHandoffs(scope(schemaName), nowSec);
    expect(second).toEqual([]);

    // Row is durably expired.
    const row = await pool.query(`SELECT status FROM handoff_records WHERE id = $1`, [handoff.id]);
    expect(row.rows[0].status).toBe('expired');
    // Exactly one handoff.expired event.
    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'handoff' AND event_type = 'handoff.expired' AND entity_id = $1`,
      [String(handoff.id)],
    );
    expect(expiredEvents.rows[0].n).toBe(1);
  });

  // Plan 2.5 / D5 — two concurrent expireStaleHandoffs on the same stale handoff
  // must emit EXACTLY ONE handoff.expired (the guarded UPDATE + FOR UPDATE SKIP
  // LOCKED make one reaper the winner; the other no-ops).
  it('2.5 concurrent expireStaleHandoffs → exactly one handoff.expired (D5)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'handoff reaper race item',
    });
    const past = Math.floor(Date.now() / 1000) - 1000;
    const handoff = await adapter.createHandoff({
      ...scope(schemaName),
      work_item_id: item.id,
      session_id: 'session-1',
      from_actor: actor('agent-a'),
      to_actor: actor('agent-b'),
      summary: 'please take over',
      visibility_class: 'private',
      expires_at: past + 1,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const [a, b] = await Promise.all([
      adapter.expireStaleHandoffs(scope(schemaName), nowSec),
      adapter.expireStaleHandoffs(scope(schemaName), nowSec),
    ]);
    // Exactly one reaper claimed it across both calls.
    expect([...a, ...b]).toEqual([handoff.id]);

    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'handoff' AND event_type = 'handoff.expired' AND entity_id = $1`,
      [String(handoff.id)],
    );
    expect(expiredEvents.rows[0].n).toBe(1);
  });

  // Plan 2.5 / D6 — getWorkClaimById applies the same effective-status
  // computation as the list paths (an active-but-expired claim reads 'expired')
  // WITHOUT writing.
  it('2.5 getWorkClaimById reports effective expired status without writing (D6)', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const item = await adapter.insertWorkItem({
      ...scope(schemaName),
      session_id: 'session-1',
      title: 'by-id claim item',
    });
    const past = Math.floor(Date.now() / 1000) - 1000;
    const claim = await adapter.claimWorkItem({
      ...scope(schemaName),
      work_item_id: item.id,
      actor: actor('agent-a'),
      lease_seconds: 1, // expires_at in the past
      visibility_class: 'private',
      claimed_at: past,
    });

    const byId = await adapter.getWorkClaimById(claim.id);
    expect(byId?.status).toBe('expired');
    // Consistent with the list path.
    const listed = await adapter.listWorkClaims(scope(schemaName), { includeExpired: true });
    expect(listed.find((c) => c.id === claim.id)?.status).toBe('expired');

    // No write happened — the stored row is still 'active'.
    const row = await pool.query(`SELECT status FROM work_claims_current WHERE id = $1`, [claim.id]);
    expect(row.rows[0].status).toBe('active');
    const expiredEvents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_event_log
       WHERE entity_kind = 'work_claim' AND event_type = 'work_claim.expired'`,
    );
    expect(expiredEvents.rows[0].n).toBe(0);
  });

  // Plan D1 — insertPlaybookRevision emits BOTH playbook.revised (the revision
  // audit) AND a playbook.updated after-snapshot carrying the bumped
  // revision_count/updated_at, in event_id order, so temporal replay (which folds
  // only the `playbook` entity kind) reconstructs the bumped counter.
  it('D1 insertPlaybookRevision emits playbook.revised then playbook.updated', async () => {
    const { pool, schemaName } = await prepareSchema();
    const adapter = createPostgresAdapter(pool);

    const playbook = await adapter.insertPlaybook({
      ...scope(schemaName),
      title: 'runbook',
      description: 'desc',
      instructions: 'v1',
    });
    expect(playbook.revision_count).toBe(0);

    const revision = await adapter.insertPlaybookRevision({
      ...scope(schemaName),
      playbook_id: playbook.id,
      instructions: 'v2',
      revision_reason: 'update',
      source_session_id: 'session-1',
      created_at: Math.floor(Date.now() / 1000),
    });

    // The parent playbook's revision_count/updated_at were bumped durably.
    const updated = await adapter.getPlaybookById(playbook.id);
    expect(updated?.revision_count).toBe(1);
    expect(updated?.updated_at).toBe(revision.created_at);

    // playbook.updated after-snapshot exists and carries the bumped counter,
    // ordered AFTER playbook.revised.
    const playbookEvents = await adapter.getMemoryEventsByEntity(
      scope(schemaName),
      'playbook',
      String(playbook.id),
    );
    const updatedEvent = playbookEvents.events.find((e) => e.event_type === 'playbook.updated');
    expect(updatedEvent).toBeDefined();
    const afterSnapshot = (updatedEvent?.payload as { after?: { revision_count?: number } }).after;
    expect(afterSnapshot?.revision_count).toBe(1);

    const revisionEvents = await adapter.getMemoryEventsByEntity(
      scope(schemaName),
      'playbook_revision',
      String(revision.id),
    );
    const revisedEvent = revisionEvents.events.find((e) => e.event_type === 'playbook.revised');
    expect(revisedEvent).toBeDefined();
    // event_id order: playbook.revised strictly precedes playbook.updated.
    expect(BigInt(updatedEvent!.event_id) > BigInt(revisedEvent!.event_id)).toBe(true);
  });
});
