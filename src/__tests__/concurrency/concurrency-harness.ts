/**
 * Shared setup for the Phase 5.4 Postgres concurrency tier.
 *
 * Every concurrency suite is Postgres-only and gated on `POSTGRES_TEST_URL`
 * (see the `describe.skip` pattern in each `*.concurrency.test.ts`). This module
 * provisions ONE ephemeral schema per test and hands out fully independent
 * adapters so that races genuinely race:
 *
 *   - `control`     — an adapter (on its own pool) used only for deterministic
 *                     seeding and post-race assertions.
 *   - `controlPool` — the same pool, exposed for direct COUNT/SELECT SQL when a
 *                     test needs to inspect raw rows the adapter API hides.
 *   - `spawnRacers(n)` — `n` adapters, EACH backed by its own `pg.Pool`, so N
 *                     concurrent operations run on N distinct physical
 *                     connections with zero shared client and no serialization
 *                     imposed by the test harness itself. Each racer pool is
 *                     pre-warmed (`SELECT 1`) so the barrier releases into the
 *                     DB operation, not TCP/auth setup.
 *
 * Determinism: fixtures derive timestamps from {@link BASE_TS}, a fixed value
 * well under the int4 ceiling (2_147_483_647), so event/claim rows never bind a
 * float or out-of-range integer to an INTEGER column and two runs are
 * byte-identical. The adapter's own `nowSeconds()` (used for a few
 * non-asserted, wall-clock fields like compaction `duration_ms`) also stays
 * int4-safe until 2038 and is never asserted on.
 *
 * pgvector is installed via the shared `ensurePgVectorExtension` helper (pinned
 * to `public`), so the per-test `DROP SCHEMA ... CASCADE` teardown never removes
 * the extension out from under a parallel vitest worker.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresAdapter } from '../../adapters/postgres/index.js';
import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import { ensurePgVectorExtension } from '../helpers/verification-harness.js';

type PgModule = typeof import('pg');
type PgPool = InstanceType<PgModule['Pool']>;

export const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** Fixed, int4-safe epoch-seconds base for all fixtures. */
export const BASE_TS = 1_700_000_000;

function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(path.join(dir, 'openapi.yaml'), 'utf8');
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error('project root not found walking up from concurrency-harness');
}

function loadSchemaSql(): string {
  return readFileSync(path.join(findProjectRoot(), 'src/adapters/postgres/schema.sql'), 'utf8');
}

export interface PgConcurrencyEnv {
  /** Name of the ephemeral schema (also handy as a per-test workspace_id). */
  readonly schemaName: string;
  /** Adapter for seeding + assertions (single pool). */
  readonly control: AsyncStorageAdapter;
  /** Underlying control pool, for raw SQL assertions (COUNT, etc.). */
  readonly controlPool: PgPool;
  /** Spawn `n` independent, pre-warmed racer adapters (each its own pool). */
  spawnRacers(n: number): Promise<AsyncStorageAdapter[]>;
  /** Drop the schema (CASCADE) and end every pool. Best-effort, idempotent. */
  teardown(): Promise<void>;
}

export async function setupPgConcurrency(): Promise<PgConcurrencyEnv> {
  if (!POSTGRES_TEST_URL) {
    throw new Error('setupPgConcurrency called without POSTGRES_TEST_URL');
  }
  const pg = await import('pg');
  const schemaSql = loadSchemaSql();
  const schemaName = `ml_conc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // Bootstrap on a one-shot pool: pin pgvector to public, then create the
  // schema before any search_path'd pool touches it.
  const bootstrap = new pg.Pool({ connectionString: POSTGRES_TEST_URL });
  try {
    await ensurePgVectorExtension(bootstrap);
    await bootstrap.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await bootstrap.end();
  }

  const pools: PgPool[] = [];
  const makePool = (max: number): PgPool => {
    const url = new URL(POSTGRES_TEST_URL!);
    // Inherit search_path via connection options (avoids the pg `connect` hook
    // deprecation warning). See makePostgresHarness for the rationale.
    url.searchParams.set('options', `-c search_path=${schemaName},public`);
    const pool = new pg.Pool({ connectionString: url.toString(), max });
    pools.push(pool);
    return pool;
  };

  const controlPool = makePool(4);
  await controlPool.query(schemaSql);
  const control = createPostgresAdapter(controlPool);

  const spawnRacers = async (n: number): Promise<AsyncStorageAdapter[]> => {
    const adapters: AsyncStorageAdapter[] = [];
    for (let i = 0; i < n; i++) {
      // max: 2 — each racer needs exactly one connection for its transaction;
      // the spare avoids a deadlocked pool if a nested helper ever grabs a
      // second. Distinct pools guarantee distinct physical connections.
      const pool = makePool(2);
      await pool.query('SELECT 1'); // pre-warm the physical connection
      adapters.push(createPostgresAdapter(pool));
    }
    return adapters;
  };

  const teardown = async (): Promise<void> => {
    try {
      await controlPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } catch {
      // best-effort; teardown must not mask a test failure
    }
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  };

  return { schemaName, control, controlPool, spawnRacers, teardown };
}

export interface Barrier {
  readonly gate: Promise<void>;
  release(): void;
}

/** A one-shot release barrier: all waiters resume when `release()` is called. */
export function makeBarrier(): Barrier {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/**
 * Fire `fn` for every item SIMULTANEOUSLY. Each invocation parks on one shared
 * gate; the gate is released only after all invocations are lined up, so they
 * proceed in the same tick with no ordering imposed between them and no
 * `sleep`-as-synchronization anywhere. Results come back settled, in input
 * order, so a test can assert "exactly one fulfilled, the rest rejected".
 */
export async function raceAll<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const { gate, release } = makeBarrier();
  // Each async IIFE runs synchronously up to `await gate` during this .map(),
  // so all N are parked before we release.
  const running = items.map((item, index) =>
    (async () => {
      await gate;
      return fn(item, index);
    })(),
  );
  await Promise.resolve(); // extra microtask turn: belt-and-suspenders
  release();
  return Promise.allSettled(running);
}

/** Count rows matching a WHERE clause on `controlPool`. */
export async function countRows(
  pool: PgPool,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const { rows } = await pool.query(sql, params as unknown[]);
  return Number((rows[0] as { n: string | number }).n);
}
