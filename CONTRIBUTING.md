# Contributing to memory-layer

## Development Setup

```bash
git clone <repo-url>
cd memory-layer
npm install
npm test
```

Requires Node 20+.

## Project Structure

```
src/
  contracts/    Type definitions and interfaces (StorageAdapter, policies, etc.)
  core/         Business logic (manager, orchestrator, context, monitor, runtime)
  adapters/     Storage implementations (sqlite, memory)
  integrations/ Protocol adapters (MCP, middleware, Claude/OpenAI tools)
  summarizers/  Compaction providers (Claude, OpenAI, extractive)
  __tests__/    All test files
examples/       Integration pattern examples
evals/          Evaluation scripts
benchmarks/     Performance benchmarks
scripts/        Export/import utilities
```

## Running Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run lint          # Type check without emitting
npm run eval:gate     # Evals (enforced)
```

## Adding a New Storage Adapter

1. Implement the `StorageAdapter` interface from `src/contracts/storage.ts`
2. Run the adapter conformance test harness against your implementation
3. Add an example showing setup
4. Export from `src/index.ts`

## Adding a New Summarizer or Extractor

1. Implement the `Summarizer` or `Extractor` type from `src/core/orchestrator.ts` / `src/core/extractor.ts`
2. Use dynamic imports for any SDK dependencies (keep them as optional peer deps)
3. Add tests with mocked SDK responses
4. Export from `src/index.ts`

## Code Style

- TypeScript strict mode
- Factory functions over classes
- Composition over inheritance
- Optional peer dependencies with dynamic imports for provider SDKs
- All new features need tests

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

## Pull Requests

- Include tests for new functionality
- Ensure `npm run lint && npm test && npm run build` passes
- Update README if adding user-facing features
