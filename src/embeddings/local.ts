import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';

const DEFAULT_DIMENSIONS = 384;
const HASH_SEEDS = [2166136261, 16777619, 374761393, 668265263];
const TOKEN_ALIASES: Record<string, string[]> = {
  pg: ['postgres', 'postgresql'],
  postgres: ['postgresql', 'pg'],
  postgresql: ['postgres', 'pg'],
  ts: ['typescript'],
  typescript: ['ts'],
  js: ['javascript'],
  javascript: ['js'],
  auth: ['authentication'],
  authentication: ['auth'],
  repo: ['repository'],
  repository: ['repo'],
  deploy: ['deployment', 'release'],
  deployment: ['deploy', 'release'],
  bug: ['issue'],
  issue: ['bug'],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
}

function stemToken(token: string): string {
  return token
    .replace(/(ments|ment|tions|tion|ings|ing|edly|edly|edly|edly|ed|ly|es|s)$/g, '')
    .replace(/(.)\1$/g, '$1');
}

function expandTokenFeatures(token: string): string[] {
  const features = new Set<string>([token]);
  const stem = stemToken(token);
  if (stem.length > 2) {
    features.add(`stem:${stem}`);
  }
  for (const alias of TOKEN_ALIASES[token] ?? []) {
    features.add(`alias:${alias}`);
    const aliasStem = stemToken(alias);
    if (aliasStem.length > 2) {
      features.add(`stem:${aliasStem}`);
    }
  }
  return [...features];
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
    const expanded = expandTokenFeatures(token);
    expanded.forEach((feature) => increment(`tok:${feature}`));
    for (const feature of expanded) {
      for (const trigram of charTrigrams(feature.replace(/^(?:stem:|alias:)/, ''))) {
        increment(`chr:${trigram}`);
      }
    }
    if (index < tokens.length - 1) {
      increment(`big:${token}_${tokens[index + 1]}`);
    }
    if (index < tokens.length - 2) {
      increment(`skip:${token}_${tokens[index + 2]}`);
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

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    const featureSets = texts.map((text) => collectFeatures(tokenize(text)));
    const documentFrequency = new Map<string, number>();
    featureSets.forEach((features) => {
      features.forEach((_count, feature) => {
        documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1);
      });
    });

    return featureSets.map((features) => {
      const vector = new Float32Array(dimensions);

      for (const [feature, termFrequency] of features.entries()) {
        const inverseDocumentFrequency =
          1 + Math.log((1 + featureSets.length) / (1 + (documentFrequency.get(feature) ?? 0)));
        const weight = (1 + Math.log(termFrequency)) * inverseDocumentFrequency;
        for (const seed of HASH_SEEDS) {
          const { index, sign } = hashFeature(feature, dimensions, seed);
          vector[index] += weight * sign;
        }
      }

      return normalizeVector(vector);
    });
  };
}
