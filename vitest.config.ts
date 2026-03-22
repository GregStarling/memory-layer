import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'bin/**',
        'benchmarks/**',
        'dist/**',
        'docs/**',
        'evals/**',
        'examples/**',
        'scripts/**',
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/index.ts',
        'src/server/index.ts',
        'src/contracts/async-storage.ts',
        'src/contracts/embedding.ts',
        'src/contracts/storage.ts',
        'src/adapters/postgres/**',
        'src/embeddings/openai.ts',
        'src/embeddings/voyage.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
