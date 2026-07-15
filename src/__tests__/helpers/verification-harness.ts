/**
 * Shared harness for the Phase 2 (4.3.0) release-gating verification suites
 * (plan items 5.3/5.4, scoped to what 4.3.0 needs).
 *
 * The three suites — replay-equivalence, event-integrity conformance, and
 * cursor conformance — all parameterize over the same adapter set:
 *   [in-memory, SQLite, Postgres-gated]
 *
 * In-memory and SQLite adapters are the SYNC `StorageAdapter`; Postgres is the
 * ASYNC `AsyncStorageAdapter`. To parameterize uniformly, every sync adapter is
 * wrapped with `wrapSyncAdapter`, so all three present the async interface and
 * the same test body runs verbatim against each.
 *
 * Determinism: none of this harness reads `Date.now()` or `Math.random()`.
 * Timestamps are derived from a caller-supplied counter (`makeClock`) and any
 * randomness comes from the seeded PRNG (`makeRng`). Two consecutive runs
 * produce byte-identical operation sequences and assertions.
 */
import { createInMemoryAdapter } from '../../adapters/memory/index.js';
import { createInMemoryEmbeddingAdapter } from '../../adapters/memory/embeddings.js';
import { createSQLiteAdapterWithEmbeddings } from '../../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import type { EmbeddingAdapter } from '../../contracts/embedding.js';
import type { MemoryScope } from '../../contracts/identity.js';
import type { StorageAdapter } from '../../contracts/storage.js';

export interface HarnessAdapter {
  /** Human-readable adapter name for the `describe.each` label. */
  readonly name: string;
  /** The adapter under test, always presented via the async interface. */
  readonly adapter: AsyncStorageAdapter;
  /**
   * The underlying SYNC adapter when one exists (in-memory, SQLite). Null for
   * Postgres. Some fault-injection tests need direct sync access; those tests
   * skip adapters where this is null.
   */
  readonly sync: StorageAdapter | null;
  /**
   * The embedding adapter backed by the SAME store as {@link adapter}, so
   * semantic-search conformance (F4 cross-scope visibility) can be exercised on
   * every backend. Its methods return MaybePromise; callers `await` them
   * uniformly. Sync-backed adapters (memory, sqlite) resolve synchronously.
   */
  readonly embeddings: EmbeddingAdapter;
  /** Tear down the adapter and any backing resources. */
  close(): Promise<void>;
}

export type HarnessFactory = () => Promise<HarnessAdapter>;

/**
 * Deterministic 32-bit PRNG (mulberry32). Seed with any integer; identical
 * seeds produce identical streams. Never uses Math.random.
 */
export function makeRng(seed: number): {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(maxExclusive: number): number {
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
  };
}

/**
 * Monotonic timestamp source. Starts at `start` and advances by `step` each
 * tick. Derived from a counter — never `Date.now()`.
 */
export function makeClock(start = 1_700_000_000, step = 1): { now(): number; tick(): number } {
  let t = start;
  return {
    now: () => t,
    tick: () => {
      t += step;
      return t;
    },
  };
}

/**
 * The in-memory + SQLite factories that always run. Postgres is added by
 * `withPostgres` when POSTGRES_TEST_URL is set.
 */
export const LOCAL_FACTORIES: HarnessFactory[] = [
  async () => {
    const sync = createInMemoryAdapter();
    return {
      name: 'in-memory',
      adapter: wrapSyncAdapter(sync),
      sync,
      embeddings: createInMemoryEmbeddingAdapter(sync),
      close: async () => sync.close(),
    };
  },
  async () => {
    const sync = createSQLiteAdapterWithEmbeddings(':memory:');
    return {
      name: 'sqlite',
      adapter: wrapSyncAdapter(sync),
      sync,
      embeddings: sync.embeddings,
      close: async () => sync.close(),
    };
  },
];

/**
 * Returns the local factories plus a Postgres factory when POSTGRES_TEST_URL is
 * set. Each Postgres factory call provisions a throwaway schema, applies
 * schema.sql, and returns an adapter whose `close()` drops the schema and ends
 * the pool. When the env var is absent the pg factory is omitted entirely, so
 * pg cases collect as skipped via `describe.each` never seeing them; callers
 * that want an explicit skipped placeholder can use `POSTGRES_ENABLED`.
 */
export const POSTGRES_ENABLED = Boolean(process.env.POSTGRES_TEST_URL);

let pgModulePromise: Promise<typeof import('pg')> | null = null;

async function loadPg(): Promise<typeof import('pg')> {
  if (!pgModulePromise) pgModulePromise = import('pg');
  return pgModulePromise;
}

/**
 * Install pgvector pinned to the `public` schema, tolerating concurrent
 * installs. Every pg test harness creates an ephemeral schema first in its
 * `search_path` and drops it CASCADE on teardown — a bare
 * `CREATE EXTENSION IF NOT EXISTS vector` on such a pool installs the
 * extension INTO the ephemeral schema, and the first teardown then drops the
 * `vector` type out from under every other vitest worker mid-run. Pinning to
 * `public` keeps the extension alive across all workers; the pg_extension
 * re-check absorbs the duplicate-object race two workers can hit inside
 * IF NOT EXISTS.
 */
export async function ensurePgVectorExtension(pool: {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}): Promise<void> {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  } catch (err) {
    const { rows } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (rows.length === 0) throw err;
  }
}

export async function makePostgresHarness(): Promise<HarnessAdapter> {
  if (!POSTGRES_TEST_URL) {
    throw new Error('makePostgresHarness called without POSTGRES_TEST_URL');
  }
  const pg = await loadPg();
  const { createPostgresAdapter, createPostgresEmbeddingAdapter } = await import(
    '../../adapters/postgres/index.js'
  );
  const { readFileSync } = await import('node:fs');
  const nodePath = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const findRoot = (): string => {
    let dir = nodePath.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      try {
        readFileSync(nodePath.join(dir, 'openapi.yaml'), 'utf8');
        return dir;
      } catch {
        dir = nodePath.dirname(dir);
      }
    }
    throw new Error('project root not found');
  };
  const schemaSql = readFileSync(
    nodePath.join(findRoot(), 'src/adapters/postgres/schema.sql'),
    'utf8',
  );

  const schemaName = `ml_verify_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const bootstrap = new pg.Pool({ connectionString: POSTGRES_TEST_URL });
  try {
    await ensurePgVectorExtension(bootstrap);
    await bootstrap.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await bootstrap.end();
  }
  const url = new URL(POSTGRES_TEST_URL);
  url.searchParams.set('options', `-c search_path=${schemaName},public`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(schemaSql);

  return {
    name: 'postgres',
    adapter: createPostgresAdapter(pool),
    sync: null,
    embeddings: createPostgresEmbeddingAdapter(pool),
    close: async () => {
      // Idempotent: a test that calls manager.close() has already ended this
      // pool (the manager closes its adapter), and afterEach then calls
      // harness.close() again — pg's Pool throws "Called end on pool more
      // than once" where sqlite tolerates the double-close.
      const state = pool as unknown as { ended?: boolean; ending?: boolean };
      if (state.ended || state.ending) return;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } catch {
        // best-effort
      }
      await pool.end();
    },
  };
}

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/**
 * The full factory list for a `describe.each`. Postgres is ALWAYS present so its
 * variants show up in the report; when POSTGRES_TEST_URL is unset they collect
 * as skipped rather than being silently omitted. Callers gate pg execution with
 * `isSkipped(name)` on their hooks and `it`s. Each entry is `[name, factory]`.
 */
export function harnessCases(): Array<[string, HarnessFactory]> {
  return [
    ['in-memory', LOCAL_FACTORIES[0]],
    ['sqlite', LOCAL_FACTORIES[1]],
    ['postgres', makePostgresHarness],
  ];
}

/**
 * True when the named case cannot run in this environment (currently: the
 * Postgres case without POSTGRES_TEST_URL). Tests use this to pick `it.skip`
 * and to short-circuit their `beforeEach`/`afterEach`.
 */
export function isSkipped(name: string): boolean {
  return name === 'postgres' && !POSTGRES_ENABLED;
}

/** Standard scope for the verification suites. */
export function verifyScope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'verify-tenant',
    system_id: 'verify-system',
    scope_id: 'verify-scope',
    ...overrides,
  };
}
