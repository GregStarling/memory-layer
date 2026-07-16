/**
 * Architecture boundary rules (Phase 6.4 — Layering).
 *
 * Layer model (low -> high):
 *   contracts   pure types/interfaces + a few leaf value-contracts; no internal deps
 *   core        orchestration; depends on contracts (+ an enumerated set of pure
 *               shared-utility modules — see `core-imports-only-contracts`)
 *   adapters /  storage backends, embedding + summarizer providers; depend on
 *   embeddings/ contracts (and core, for the shared types they implement)
 *   summarizers
 *   composition wiring layer: assembles core + adapters + providers (the only
 *               layer permitted to reach the concrete adapters)
 *   server /    entrypoints: consume composition + core; sit above the wiring
 *   cli /       layer, so they may import downward freely
 *   integrations
 *
 * A run is CLEAN on the current tree and FAILS on any inverted/illegal edge
 * (proven by temporarily adding a bad import during development).
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'No circular dependencies (incl. type-only). This is what catches the ' +
        'contracts cycles the audit found; tsPreCompilationDeps makes type-only ' +
        'edges count.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-imports-nothing-internal',
      severity: 'error',
      comment:
        'The contracts layer is the shared vocabulary; it must not depend on any ' +
        'other internal layer (only sibling contracts modules + external pkgs).',
      from: { path: '^src/contracts/' },
      to: {
        path: '^src/',
        pathNot: '^src/contracts/',
      },
    },
    {
      name: 'core-imports-only-contracts',
      severity: 'error',
      comment:
        'core depends on contracts only, plus a small ENUMERATED allowlist of ' +
        'pure shared-utility modules it legitimately consumes: adapters/shared ' +
        '(scope/visibility/ordering helpers over contracts), adapters/sync-to-async ' +
        '(the wrapSyncAdapter facade), and summarizers/prompts (prompt formatters + ' +
        'response parsers). Any other reach into adapters/composition/server/cli/' +
        'summarizers/embeddings/integrations — e.g. importing a concrete storage ' +
        'backend or an LLM provider — is a layering violation.',
      from: { path: '^src/core/' },
      to: {
        path: '^src/(adapters|composition|server|cli|summarizers|embeddings|integrations)/',
        pathNot:
          '^src/(adapters/shared/|adapters/sync-to-async\\.ts|summarizers/prompts\\.ts)',
      },
    },
    {
      name: 'adapters-no-upward',
      severity: 'error',
      comment:
        'The adapters layer sits below wiring/entrypoints; it may use contracts + ' +
        'core (the shapes it implements) but must never reach up into composition, ' +
        'the servers, the CLI, or integrations.',
      from: { path: '^src/adapters/' },
      to: { path: '^src/(composition|server|cli|integrations)/' },
    },
    {
      name: 'providers-no-upward',
      severity: 'error',
      comment:
        'Provider layers (embeddings, summarizers) sit below wiring/entrypoints; ' +
        'they must not reach up into composition, servers, the CLI, integrations, ' +
        'or the storage adapters.',
      from: { path: '^src/(embeddings|summarizers)/' },
      to: { path: '^src/(adapters|composition|server|cli|integrations)/' },
    },
    {
      name: 'composition-no-entrypoints',
      severity: 'error',
      comment:
        'composition is the wiring layer: it may assemble core + adapters + ' +
        'providers, but the entrypoints (server, cli, integrations) sit ABOVE it, ' +
        'so composition must never import them.',
      from: { path: '^src/composition/' },
      to: { path: '^src/(server|cli|integrations)/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    // Count type-only imports — the audit's contract cycles were type-only.
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    // Layer rules govern production source only; tests wire across all layers.
    exclude: { path: '(^src/__tests__/|\\.test\\.ts$|^node_modules)' },
    includeOnly: { path: '^src/' },
  },
};
