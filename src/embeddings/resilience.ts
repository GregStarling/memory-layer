import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 250,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) {
        throw error;
      }
      await sleep(delayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function batchedGenerate(
  generator: EmbeddingGenerator,
  inputs: string[],
  batchSize = 32,
): Promise<EmbeddingVector[]> {
  if (inputs.length === 0) return [];
  if (batchSize <= 0) return generator(inputs);

  const output: EmbeddingVector[] = [];
  for (let index = 0; index < inputs.length; index += batchSize) {
    const batch = inputs.slice(index, index + batchSize);
    output.push(...(await generator(batch)));
  }
  return output;
}

export function createCachedEmbeddingGenerator(
  generator: EmbeddingGenerator,
  maxEntries = 256,
): EmbeddingGenerator {
  const cache = new Map<string, EmbeddingVector>();

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    const missing = texts.filter((text) => !cache.has(text));
    if (missing.length > 0) {
      const generated = await generator(missing);
      missing.forEach((text, index) => {
        const vector = generated[index];
        if (!vector) return;
        cache.set(text, vector);
        if (cache.size > maxEntries) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
      });
    }

    return texts.map((text) => cache.get(text) ?? new Float32Array());
  };
}
