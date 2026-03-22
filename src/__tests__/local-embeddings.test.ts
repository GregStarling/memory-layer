import { describe, expect, it } from 'vitest';

import { createLocalEmbeddingGenerator } from '../embeddings/local.js';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe('local embeddings', () => {
  it('keeps common deployment and database aliases semantically closer', async () => {
    const generate = createLocalEmbeddingGenerator();
    const [postgres, pg, unrelated] = await generate([
      'PostgreSQL deployment pipeline',
      'pg deploy workflow',
      'Tailwind color palette',
    ]);

    expect(cosine(postgres, pg)).toBeGreaterThan(cosine(postgres, unrelated));
  });
});
