import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';

const DEFAULT_DIMENSIONS = 384;
const HASH_SEEDS = [2166136261, 16777619, 374761393, 668265263];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
}

function charTrigrams(token: string): string[] {
  if (token.length <= 3) return [token];
  const padded = `_${token}_`;
  const results: string[] = [];
  for (let index = 0; index <= padded.length - 3; index += 1) {
    results.push(padded.slice(index, index + 3));
  }
  return results;
}

function collectFeatures(tokens: string[]): Map<string, number> {
  const features = new Map<string, number>();
  const increment = (feature: string) => {
    features.set(feature, (features.get(feature) ?? 0) + 1);
  };

  tokens.forEach((token, index) => {
    increment(`tok:${token}`);
    for (const trigram of charTrigrams(token)) {
      increment(`chr:${trigram}`);
    }
    if (index < tokens.length - 1) {
      increment(`big:${token}_${tokens[index + 1]}`);
    }
  });

  return features;
}

function hashFeature(feature: string, dimensions: number, seed: number): {
  index: number;
  sign: number;
} {
  let hash = seed;
  for (let i = 0; i < feature.length; i += 1) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const normalized = hash >>> 0;
  return {
    index: normalized % dimensions,
    sign: normalized % 2 === 0 ? 1 : -1,
  };
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
      const features = collectFeatures(tokenize(text));

      for (const [feature, termFrequency] of features.entries()) {
        const weight = 1 + Math.log(termFrequency);
        for (const seed of HASH_SEEDS) {
          const { index, sign } = hashFeature(feature, dimensions, seed);
          vector[index] += weight * sign;
        }
      }

      return normalizeVector(vector);
    });
}
