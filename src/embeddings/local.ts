import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';

const DEFAULT_DIMENSIONS = 128;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
}

function hashToken(token: string, dimensions: number): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % dimensions;
}

function normalizeVector(vector: Float32Array): Float32Array {
  let magnitude = 0;
  for (let i = 0; i < vector.length; i += 1) {
    magnitude += vector[i] * vector[i];
  }
  if (magnitude === 0) {
    return vector;
  }
  const scale = Math.sqrt(magnitude);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] /= scale;
  }
  return vector;
}

export function createLocalEmbeddingGenerator(options?: {
  dimensions?: number;
}): EmbeddingGenerator {
  const dimensions = options?.dimensions ?? DEFAULT_DIMENSIONS;

  return async (texts: string[]): Promise<EmbeddingVector[]> =>
    texts.map((text) => {
      const vector = new Float32Array(dimensions);
      for (const token of tokenize(text)) {
        const index = hashToken(token, dimensions);
        vector[index] += 1;
      }
      return normalizeVector(vector);
    });
}
