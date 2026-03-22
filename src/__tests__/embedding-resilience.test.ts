import { describe, expect, it, vi } from 'vitest';

import {
  batchedGenerate,
  createCachedEmbeddingGenerator,
  withRetry,
} from '../embeddings/resilience.js';

describe('embedding resilience helpers', () => {
  it('retries transient failures', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(run, 1, 0)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('batches embedding generation', async () => {
    const generator = vi.fn(async (texts: string[]) =>
      texts.map((text) => new Float32Array([text.length])),
    );

    const vectors = await batchedGenerate(generator, ['a', 'bb', 'ccc'], 2);
    expect(generator).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(3);
  });

  it('caches repeated inputs', async () => {
    const generator = vi.fn(async (texts: string[]) =>
      texts.map((text) => new Float32Array([text.length])),
    );
    const cached = createCachedEmbeddingGenerator(generator, 10);

    await cached(['hello', 'world']);
    await cached(['hello']);

    expect(generator).toHaveBeenCalledTimes(1);
  });
});
