import { defineConfig } from 'vitest/config';

/**
 * Postgres behavioral coverage config (plan item 5.3, decision D5).
 *
 * The DEFAULT test job (vitest.config.ts) has no Postgres, so it EXCLUDES
 * src/adapters/postgres/** from coverage — measuring it there would report a
 * misleading ~0%. Real pg coverage is measured HERE instead, and this config is
 * run by the `postgres-integration` CI job (which stands up a pgvector service
 * and sets POSTGRES_TEST_URL). See the npm script + CI step owned by the Wiring
 * worker.
 *
 * Local behavior: without POSTGRES_TEST_URL every suite below collects as
 * SKIPPED (the pg leg of each parameterized `describe.each` / the pg `it`s guard
 * on POSTGRES_ENABLED). Run `vitest run --config vitest.postgres.config.ts`
 * (no --coverage) to confirm clean collection locally. Coverage thresholds are
 * only enforced when the CI step passes --coverage, i.e. only where pg is live.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // EVERY pg-gated suite, exactly once. This config is the single source of
    // truth for what the postgres-integration job executes (test:postgres runs
    // it), so omitting a file here means its pg leg runs NOWHERE:
    //  - integration + conformance + parity: run against real pg since Phase 3;
    //  - replay-equivalence, event-integrity-conformance, cursor-conformance:
    //    the three Phase 2 (4.3.0) release-gating verification suites — their
    //    pg legs had never executed in CI until Phase 5 added them here;
    //  - temporal-replay-equivalence: the Phase 5 seeded-PRNG property test
    //    (distinct from the Phase 2 replay-equivalence gate above);
    //  - concurrency/**: the pg-only race tier (5.4).
    include: [
      'src/__tests__/postgres-integration.test.ts',
      'src/__tests__/adapter-conformance.test.ts',
      'src/__tests__/postgres-phase3-parity.test.ts',
      'src/__tests__/replay-equivalence.test.ts',
      'src/__tests__/event-integrity-conformance.test.ts',
      'src/__tests__/cursor-conformance.test.ts',
      'src/__tests__/temporal-replay-equivalence.test.ts',
      'src/__tests__/concurrency/**/*.concurrency.test.ts',
    ],
    coverage: {
      // Provider consistent with the main config (vitest.config.ts).
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Scope coverage to the pg adapter ONLY — this config exists to measure
      // exactly the code the default job cannot. Restrict to .ts: the bare
      // `**` glob pulled in schema.sql, which the coverage remapper tried to
      // parse as a module and crashed (RolldownError) on the first CI run.
      include: ['src/adapters/postgres/**/*.ts'],
      // REPORT-ONLY for the debut run: no thresholds. Nobody has ever measured
      // pg-adapter coverage under these suites; enforcing a guessed number on
      // the first instrumented CI run risks failing the job blind. The first
      // postgres-integration run prints the actual numbers (text + lcov above);
      // ratchet: add thresholds at (measured − 5) in the immediate follow-up
      // commit once that report exists.
    },
  },
});
